import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { HeightGrid } from './export/mesh';

export interface Model {
  id: number;
  name: string;
  object: THREE.Object3D;
  triangles: number;
}

export interface DepthCapture {
  width: number;
  height: number;
  /** Heights in pixel units (larger = closer to the viewer), 0 at the farthest covered point. */
  depth: Float32Array;
  mask: Uint8Array;
}

export type ViewMode = 'scene' | 'relief';
export type TransformMode = 'translate' | 'rotate' | 'scale';

interface ViewState {
  position: THREE.Vector3;
  target: THREE.Vector3;
  zoom: number;
  radius: number;
}

const TILE = 2048;

const depthMaterial = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  vertexShader: /* glsl */ `
    varying float vViewZ;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vViewZ = mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying float vViewZ;
    void main() { gl_FragColor = vec4(vViewZ, 0.0, 0.0, 1.0); }`,
});

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  readonly orbit: OrbitControls;
  readonly gizmo: TransformControls;
  readonly models: Model[] = [];
  onSelect: (model: Model | null) => void = () => {};
  onChange: () => void = () => {};

  private readonly modelGroup = new THREE.Group();
  private readonly reliefGroup = new THREE.Group();
  private readonly gizmoHelper: THREE.Object3D;
  private readonly clay = new THREE.MeshStandardMaterial({
    color: 0xb4b4b4,
    roughness: 0.75,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  private readonly reliefMaterial = new THREE.MeshStandardMaterial({
    color: 0xc4c4c4,
    roughness: 0.6,
    metalness: 0.05,
  });
  private selected: Model | null = null;
  private mode: ViewMode = 'scene';
  private savedViews: Partial<Record<ViewMode, ViewState>> = {};
  private radius = 1;
  private nextId = 1;
  private needsRender = true;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000);
    container.appendChild(this.renderer.domElement);

    this.scene.add(this.modelGroup, this.reliefGroup, this.camera);
    this.reliefGroup.visible = false;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a2a, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-1.2, 1.6, 1.4); // travels with the camera: raking light from upper left
    this.camera.add(key);
    this.camera.add(key.target);
    key.target.position.set(0, 0, -1);

    this.camera.position.set(0, 0, 10);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.addEventListener('change', () => this.invalidate());

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.8);
    this.gizmoHelper = this.gizmo.getHelper();
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener('change', () => this.invalidate());
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !(e as unknown as { value: boolean }).value;
      if (this.orbit.enabled) this.onChange();
    });

    this.installPicking();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      if (!this.needsRender) return;
      this.needsRender = false;
      this.renderer.render(this.scene, this.camera);
    });
  }

  invalidate(): void {
    this.needsRender = true;
  }

  // ---------------------------------------------------------------- models

  addModel(name: string, object: THREE.Object3D): Model {
    let triangles = 0;
    object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = this.clay;
      const g = mesh.geometry;
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      triangles += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    });
    // Recentre so the model pivots around its own middle.
    const box = new THREE.Box3().setFromObject(object);
    const centre = box.getCenter(new THREE.Vector3());
    const pivot = new THREE.Group();
    object.position.sub(centre);
    pivot.add(object);
    const model: Model = { id: this.nextId++, name, object: pivot, triangles: Math.round(triangles) };
    this.models.push(model);
    this.modelGroup.add(pivot);
    this.setMode('scene');
    if (this.models.length === 1) this.frame();
    this.select(model);
    this.onChange();
    return model;
  }

  removeModel(model: Model): void {
    const i = this.models.indexOf(model);
    if (i < 0) return;
    this.models.splice(i, 1);
    if (this.selected === model) this.select(null);
    this.modelGroup.remove(model.object);
    model.object.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.onChange();
    this.invalidate();
  }

  select(model: Model | null): void {
    this.selected = model;
    if (model && this.mode === 'scene') this.gizmo.attach(model.object);
    else this.gizmo.detach();
    this.onSelect(model);
    this.invalidate();
  }

  get selection(): Model | null {
    return this.selected;
  }

  /** Overall size of the selected model: the geometric mean of its three scale factors. */
  get selectionScale(): number {
    const s = this.selected?.object.scale;
    return s ? Math.cbrt(Math.abs(s.x * s.y * s.z)) || 1 : 1;
  }

  /** Scales the selected model uniformly to the given overall size, keeping its proportions. */
  setSelectionScale(scale: number): void {
    if (!this.selected || !(scale > 0)) return;
    this.selected.object.scale.multiplyScalar(scale / this.selectionScale);
    this.invalidate();
  }

  setTransformMode(mode: TransformMode): void {
    this.gizmo.setMode(mode);
    this.invalidate();
  }

  private installPicking(): void {
    const dom = this.renderer.domElement;
    const ray = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;
    dom.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    dom.addEventListener('pointerup', (e) => {
      if (!down || this.mode !== 'scene' || this.gizmo.dragging) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      const rect = dom.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObjects(this.modelGroup.children, true)[0];
      if (!hit) return;
      const model = this.models.find((m) => {
        let o: THREE.Object3D | null = hit.object;
        while (o && o !== m.object) o = o.parent;
        return !!o;
      });
      if (model) this.select(model);
    });
  }

  // ---------------------------------------------------------------- camera

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.updateFrustum();
  }

  private updateFrustum(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const half = this.radius * 1.15;
    const aspect = w / h;
    const hx = aspect >= 1 ? half * aspect : half;
    const hy = aspect >= 1 ? half : half / aspect;
    this.camera.left = -hx;
    this.camera.right = hx;
    this.camera.top = hy;
    this.camera.bottom = -hy;
    // An orthographic camera may sit inside the scene, so let it see behind itself too.
    this.camera.near = -this.radius * 40;
    this.camera.far = this.radius * 40;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  /** Fit the camera to whatever the current mode shows, keeping the view direction. */
  frame(direction?: THREE.Vector3): void {
    const group = this.mode === 'scene' ? this.modelGroup : this.reliefGroup;
    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.radius = Math.max(sphere.radius, 1e-6);
    const dir =
      direction?.clone().normalize() ??
      this.camera.position.clone().sub(this.orbit.target).normalize();
    this.orbit.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, this.radius * 4);
    this.camera.zoom = 1;
    this.updateFrustum();
    this.orbit.update();
  }

  /** Look along one of the principal axes. */
  setViewDirection(direction: THREE.Vector3): void {
    this.frame(direction);
  }

  private saveView(): ViewState {
    return {
      position: this.camera.position.clone(),
      target: this.orbit.target.clone(),
      zoom: this.camera.zoom,
      radius: this.radius,
    };
  }

  setMode(mode: ViewMode): void {
    if (mode === this.mode) return;
    this.savedViews[this.mode] = this.saveView();
    this.mode = mode;
    this.modelGroup.visible = mode === 'scene';
    this.reliefGroup.visible = mode === 'relief';
    if (mode === 'scene' && this.selected) this.gizmo.attach(this.selected.object);
    else this.gizmo.detach();
    const saved = this.savedViews[mode];
    if (saved) {
      this.camera.position.copy(saved.position);
      this.orbit.target.copy(saved.target);
      this.camera.zoom = saved.zoom;
      this.radius = saved.radius;
      this.updateFrustum();
      this.orbit.update();
    } else {
      this.frame(mode === 'relief' ? new THREE.Vector3(0.25, -0.35, 1) : undefined);
    }
    this.invalidate();
  }

  get viewMode(): ViewMode {
    return this.mode;
  }

  // ---------------------------------------------------------------- relief preview

  setRelief(grid: HeightGrid): void {
    const { w, h, z, spacing } = grid;
    const pos = new Float32Array(w * h * 3);
    const ox = ((w - 1) * spacing) / 2;
    const oy = ((h - 1) * spacing) / 2;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const i = r * w + c;
        pos[i * 3] = c * spacing - ox;
        pos[i * 3 + 1] = (h - 1 - r) * spacing - oy;
        pos[i * 3 + 2] = z[i];
      }
    }
    const idx = new Uint32Array((w - 1) * (h - 1) * 6);
    let o = 0;
    for (let r = 0; r < h - 1; r++) {
      for (let c = 0; c < w - 1; c++) {
        const a = r * w + c;
        const d = a + w;
        idx[o++] = d; idx[o++] = d + 1; idx[o++] = a + 1;
        idx[o++] = d; idx[o++] = a + 1; idx[o++] = a;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();

    const first = this.reliefGroup.children.length === 0;
    for (const child of [...this.reliefGroup.children]) {
      (child as THREE.Mesh).geometry.dispose();
      this.reliefGroup.remove(child);
    }
    this.reliefGroup.add(new THREE.Mesh(geo, this.reliefMaterial));
    if (first) delete this.savedViews.relief;
    this.invalidate();
  }

  get hasRelief(): boolean {
    return this.reliefGroup.children.length > 0;
  }

  // ---------------------------------------------------------------- depth capture

  /**
   * Renders the models' depth as seen by the current camera.
   * The frame is fitted tightly around the models, plus `margin` (a fraction
   * of the long side) of empty background on every side.
   */
  captureDepth(resolution: number, margin: number): DepthCapture | null {
    if (!this.models.length) return null;
    this.scene.updateMatrixWorld(true);
    const cam = this.camera;
    const inv = cam.matrixWorldInverse;

    // Loose bounds in camera space from the meshes' bounding boxes.
    const bounds = new THREE.Box3();
    const corner = new THREE.Vector3();
    this.modelGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const b = mesh.geometry.boundingBox!;
      for (let k = 0; k < 8; k++) {
        corner
          .set(k & 1 ? b.max.x : b.min.x, k & 2 ? b.max.y : b.min.y, k & 4 ? b.max.z : b.min.z)
          .applyMatrix4(mesh.matrixWorld)
          .applyMatrix4(inv);
        bounds.expandByPoint(corner);
      }
    });
    if (bounds.isEmpty()) return null;

    // The capture camera shares the view camera's orientation but is pulled
    // back until the whole scene lies in front of it.
    const depthRange = bounds.max.z - bounds.min.z || 1;
    const capCam = new THREE.OrthographicCamera();
    capCam.quaternion.copy(cam.getWorldQuaternion(new THREE.Quaternion()));
    capCam.position
      .copy(cam.getWorldPosition(new THREE.Vector3()))
      .add(
        new THREE.Vector3(0, 0, bounds.max.z + depthRange * 0.05).applyQuaternion(capCam.quaternion),
      );
    capCam.near = 0;
    capCam.far = depthRange * 1.1;
    capCam.updateMatrixWorld(true);

    const saved = {
      target: this.renderer.getRenderTarget(),
      clear: this.renderer.getClearColor(new THREE.Color()),
      alpha: this.renderer.getClearAlpha(),
      override: this.scene.overrideMaterial,
      relief: this.reliefGroup.visible,
      models: this.modelGroup.visible,
      gizmo: this.gizmoHelper.visible,
    };
    this.scene.overrideMaterial = depthMaterial;
    this.reliefGroup.visible = false;
    this.modelGroup.visible = true;
    this.gizmoHelper.visible = false;
    this.renderer.setClearColor(0x000000, 0);

    const rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });

    /** Renders a camera-space rectangle of square pixels into a w*h image (row 0 = top). */
    const renderRect = (
      left: number, top: number, unitsPerPx: number,
      w: number, h: number, depth: Float32Array, mask: Uint8Array,
    ) => {
      let pixels: Float32Array | null = null;
      for (let ty = 0; ty < h; ty += TILE) {
        const th = Math.min(TILE, h - ty);
        for (let tx = 0; tx < w; tx += TILE) {
          const tw = Math.min(TILE, w - tx);
          capCam.left = left + tx * unitsPerPx;
          capCam.right = left + (tx + tw) * unitsPerPx;
          capCam.top = top - ty * unitsPerPx;
          capCam.bottom = top - (ty + th) * unitsPerPx;
          capCam.updateProjectionMatrix();
          rt.setSize(tw, th);
          this.renderer.setRenderTarget(rt);
          this.renderer.clear();
          this.renderer.render(this.scene, capCam);
          if (!pixels || pixels.length < tw * th * 4) pixels = new Float32Array(tw * th * 4);
          this.renderer.readRenderTargetPixels(rt, 0, 0, tw, th, pixels);
          for (let j = 0; j < th; j++) {
            const dst = (ty + th - 1 - j) * w + tx; // GL rows run bottom-up
            const src = j * tw * 4;
            for (let i = 0; i < tw; i++) {
              if (pixels[src + i * 4 + 3] > 0.5) {
                depth[dst + i] = pixels[src + i * 4];
                mask[dst + i] = 1;
              }
            }
          }
        }
      }
    };

    let result: DepthCapture | null = null;
    try {
      // Pass 1: coarse render to find the tight silhouette bounds.
      const { x: l, y: b } = bounds.min;
      const { x: r, y: t } = bounds.max;
      const probe = 256;
      const span = Math.max(r - l, t - b) || 1;
      const pw = Math.max(2, Math.ceil(((r - l) / span) * probe));
      const ph = Math.max(2, Math.ceil(((t - b) / span) * probe));
      const upp = span / probe;
      const pMask = new Uint8Array(pw * ph);
      renderRect(l, t, upp, pw, ph, new Float32Array(pw * ph), pMask);
      let x0 = pw, x1 = -1, y0 = ph, y1 = -1;
      for (let y = 0; y < ph; y++)
        for (let x = 0; x < pw; x++)
          if (pMask[y * pw + x]) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
      if (x1 >= 0) {
        // One probe pixel of slack, then the user's margin.
        const tl = l + (x0 - 1) * upp;
        const tr = l + (x1 + 2) * upp;
        const tt = t - (y0 - 1) * upp;
        const tb = t - (y1 + 2) * upp;
        const pad = Math.max(tr - tl, tt - tb) * margin;
        const fl = tl - pad;
        const ft = tt + pad;
        const fw = tr - tl + 2 * pad;
        const fh = tt - tb + 2 * pad;
        const long = Math.max(fw, fh);
        const W = Math.max(2, Math.round((fw / long) * resolution));
        const H = Math.max(2, Math.round((fh / long) * resolution));
        const unitsPerPx = long / resolution;
        const depth = new Float32Array(W * H);
        const mask = new Uint8Array(W * H);
        renderRect(fl, ft, unitsPerPx, W, H, depth, mask);
        // Convert view-space Z to pixel units, measured up from the farthest point.
        let min = Infinity;
        for (let i = 0; i < depth.length; i++) if (mask[i] && depth[i] < min) min = depth[i];
        const pxPerUnit = 1 / unitsPerPx;
        for (let i = 0; i < depth.length; i++) depth[i] = mask[i] ? (depth[i] - min) * pxPerUnit : 0;
        result = { width: W, height: H, depth, mask };
      }
    } finally {
      rt.dispose();
      this.scene.overrideMaterial = saved.override;
      this.reliefGroup.visible = saved.relief;
      this.modelGroup.visible = saved.models;
      this.gizmoHelper.visible = saved.gizmo;
      this.renderer.setRenderTarget(saved.target);
      this.renderer.setClearColor(saved.clear, saved.alpha);
      this.invalidate();
    }
    return result;
  }
}
