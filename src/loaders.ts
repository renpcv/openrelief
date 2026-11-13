import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

/** Parses an OBJ or STL file into a three.js object. */
export async function loadModelFile(file: File): Promise<THREE.Object3D> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'obj') {
    return new OBJLoader().parse(await file.text());
  }
  if (ext === 'stl') {
    const geometry = new STLLoader().parse(await file.arrayBuffer());
    return new THREE.Mesh(geometry);
  }
  throw new Error(`Unsupported file type ".${ext}" - use OBJ or STL.`);
}

/** A built-in subject so the app can be tried without any files. */
export function createDemoModel(): THREE.Object3D {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.34, 400, 64, 2, 3)));
  const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 5));
  // Fine surface texture, to show that small detail survives depth compression.
  const p = ball.geometry.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const bump = 1 + 0.035 * Math.sin(v.x * 28) * Math.sin(v.y * 28) * Math.sin(v.z * 28);
    v.multiplyScalar(bump);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  ball.geometry.computeVertexNormals();
  group.add(ball);
  return group;
}
