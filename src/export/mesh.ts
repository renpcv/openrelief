/**
 * Height field -> watertight solid mesh, with binary STL and OBJ writers.
 *
 * Mesh coordinates are millimetres: X to the right, Y up (image row 0 is the
 * top edge), Z out of the relief. The solid sits on Z = 0.
 */

export interface ReliefDimensions {
  /** Size of one height-field pixel in mm. */
  pixelSize: number;
  /** Height of the relief above the base plate, in mm. */
  depth: number;
  /** Thickness of the base plate under the relief, in mm. */
  base: number;
  /** Carve the relief into the block instead of raising it from the plate. */
  sunken: boolean;
}

export interface HeightGrid {
  w: number;
  h: number;
  /** Z in mm for each grid vertex, row 0 = top of the image. */
  z: Float32Array;
  /** Distance between neighbouring grid vertices in mm. */
  spacing: number;
}

/** Normalised height (0..1) -> Z in mm. */
export function heightToZ(v: number, d: ReliefDimensions): number {
  return d.base + d.depth * (d.sunken ? 1 - v : v);
}

/**
 * Converts a normalised height field into a grid of Z values, box-filtering it
 * down so that neither side exceeds `maxSide` vertices.
 */
export function buildGrid(
  height: Float32Array,
  w: number,
  h: number,
  dims: ReliefDimensions,
  maxSide: number,
): HeightGrid {
  const f = Math.max(1, Math.ceil(Math.max(w, h) / maxSide));
  const gw = Math.max(2, Math.floor(w / f));
  const gh = Math.max(2, Math.floor(h / f));
  const z = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let sum = 0;
      let cnt = 0;
      const y1 = Math.min(h, (gy + 1) * f);
      const x1 = Math.min(w, (gx + 1) * f);
      for (let y = gy * f; y < y1; y++) {
        const row = y * w;
        for (let x = gx * f; x < x1; x++) {
          sum += height[row + x];
          cnt++;
        }
      }
      z[gy * gw + gx] = heightToZ(cnt ? sum / cnt : 0, dims);
    }
  }
  return { w: gw, h: gh, z, spacing: dims.pixelSize * f };
}

/** Grid indices of the outline, counter-clockwise when seen from +Z. */
function boundaryLoop(gw: number, gh: number): number[] {
  const loop: number[] = [];
  const last = gh - 1;
  for (let x = 0; x < gw - 1; x++) loop.push(last * gw + x); // bottom edge, left to right
  for (let y = last; y > 0; y--) loop.push(y * gw + gw - 1); // right edge, upwards
  for (let x = gw - 1; x > 0; x--) loop.push(x); // top edge, right to left
  for (let y = 0; y < last; y++) loop.push(y * gw); // left edge, downwards
  return loop;
}

export function triangleCount(g: HeightGrid): number {
  const perimeter = 2 * (g.w - 1) + 2 * (g.h - 1);
  return 2 * (g.w - 1) * (g.h - 1) + 3 * perimeter;
}

/** Binary STL of the closed solid (relief surface, side walls, flat bottom). */
export function writeStl(g: HeightGrid): ArrayBuffer {
  const { w: gw, h: gh, z, spacing: s } = g;
  const nTri = triangleCount(g);
  const buf = new ArrayBuffer(84 + nTri * 50);
  const dv = new DataView(buf);
  const header = 'OpenRelief binary STL';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, nTri, true);
  let o = 84;

  const px = (i: number) => (i % gw) * s;
  const py = (i: number) => (gh - 1 - Math.floor(i / gw)) * s;

  const tri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ) => {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    dv.setFloat32(o + 12, ax, true); dv.setFloat32(o + 16, ay, true); dv.setFloat32(o + 20, az, true);
    dv.setFloat32(o + 24, bx, true); dv.setFloat32(o + 28, by, true); dv.setFloat32(o + 32, bz, true);
    dv.setFloat32(o + 36, cx, true); dv.setFloat32(o + 40, cy, true); dv.setFloat32(o + 44, cz, true);
    o += 50;
  };

  // Relief surface.
  for (let r = 0; r < gh - 1; r++) {
    for (let c = 0; c < gw - 1; c++) {
      const a = r * gw + c; // top-left
      const b = a + 1; // top-right
      const d = a + gw; // bottom-left
      const e = d + 1; // bottom-right
      tri(px(d), py(d), z[d], px(e), py(e), z[e], px(b), py(b), z[b]);
      tri(px(d), py(d), z[d], px(b), py(b), z[b], px(a), py(a), z[a]);
    }
  }

  // Side walls and bottom fan.
  const loop = boundaryLoop(gw, gh);
  const cx = ((gw - 1) * s) / 2;
  const cy = ((gh - 1) * s) / 2;
  for (let k = 0; k < loop.length; k++) {
    const i = loop[k];
    const j = loop[(k + 1) % loop.length];
    tri(px(i), py(i), 0, px(j), py(j), 0, px(j), py(j), z[j]);
    tri(px(i), py(i), 0, px(j), py(j), z[j], px(i), py(i), z[i]);
    tri(cx, cy, 0, px(j), py(j), 0, px(i), py(i), 0);
  }
  return buf;
}

/** Wavefront OBJ of the same closed solid, with shared vertices. */
export function writeObj(g: HeightGrid): Blob {
  const { w: gw, h: gh, z, spacing: s } = g;
  const parts: string[] = [];
  let chunk: string[] = ['# OpenRelief\n# units: millimetres\n'];
  const flush = () => {
    parts.push(chunk.join(''));
    chunk = [];
  };
  const fmt = (v: number) => (Math.round(v * 1e4) / 1e4).toString();

  for (let r = 0; r < gh; r++) {
    const y = fmt((gh - 1 - r) * s);
    for (let c = 0; c < gw; c++) chunk.push(`v ${fmt(c * s)} ${y} ${fmt(z[r * gw + c])}\n`);
    flush();
  }
  const loop = boundaryLoop(gw, gh);
  const bottomStart = gw * gh; // 0-based index of the first bottom vertex
  for (const i of loop) {
    chunk.push(`v ${fmt((i % gw) * s)} ${fmt((gh - 1 - Math.floor(i / gw)) * s)} 0\n`);
  }
  chunk.push(`v ${fmt(((gw - 1) * s) / 2)} ${fmt(((gh - 1) * s) / 2)} 0\n`);
  const centre = bottomStart + loop.length;
  flush();

  // OBJ indices are 1-based.
  for (let r = 0; r < gh - 1; r++) {
    for (let c = 0; c < gw - 1; c++) {
      const a = r * gw + c + 1;
      const b = a + 1;
      const d = a + gw;
      const e = d + 1;
      chunk.push(`f ${d} ${e} ${b}\nf ${d} ${b} ${a}\n`);
    }
    flush();
  }
  for (let k = 0; k < loop.length; k++) {
    const k2 = (k + 1) % loop.length;
    const ti = loop[k] + 1;
    const tj = loop[k2] + 1;
    const bi = bottomStart + k + 1;
    const bj = bottomStart + k2 + 1;
    chunk.push(`f ${bi} ${bj} ${tj}\nf ${bi} ${tj} ${ti}\nf ${centre + 1} ${bj} ${bi}\n`);
  }
  flush();
  return new Blob(parts, { type: 'model/obj' });
}
