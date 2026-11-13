import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { writeExr, writePfm, writePng16 } from '../src/export/image';
import { buildGrid, triangleCount, writeObj, writeStl } from '../src/export/mesh';

const dims = { pixelSize: 0.5, depth: 4, base: 2, sunken: false };

function bumpField(w: number, h: number) {
  const f = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      f[y * w + x] = Math.max(0, 1 - Math.hypot(x - w / 2, y - h / 2) / (w / 3));
  return f;
}

/** Reads the triangles back out of a binary STL. */
function readStl(buf: ArrayBuffer) {
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true);
  const tris: number[][] = [];
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50;
    const v: number[] = [];
    for (let k = 0; k < 12; k++) v.push(dv.getFloat32(o + k * 4, true));
    tris.push(v);
  }
  return tris;
}

describe('mesh export', () => {
  it('buildGrid maps heights to millimetres and downsamples', () => {
    const f = bumpField(64, 48);
    const g = buildGrid(f, 64, 48, dims, 32);
    expect(g.w).toBe(32);
    expect(g.h).toBe(24);
    expect(g.spacing).toBeCloseTo(1);
    expect(Math.min(...g.z)).toBeCloseTo(2, 5);
    expect(Math.max(...g.z)).toBeLessThanOrEqual(6);
    const sunk = buildGrid(f, 64, 48, { ...dims, sunken: true }, 32);
    expect(Math.max(...sunk.z)).toBeCloseTo(6, 5);
  });

  it('STL is a closed, outward-facing solid', () => {
    const g = buildGrid(bumpField(21, 17), 21, 17, dims, 64);
    const buf = writeStl(g);
    expect(buf.byteLength).toBe(84 + triangleCount(g) * 50);
    const tris = readStl(buf);

    // Watertight: every directed edge is matched by its reverse exactly once.
    const edges = new Map<string, number>();
    const key = (a: number[], b: number[]) => `${a.join(',')}>${b.join(',')}`;
    let volume = 0;
    for (const t of tris) {
      const p = [t.slice(3, 6), t.slice(6, 9), t.slice(9, 12)];
      for (let k = 0; k < 3; k++) {
        const e = key(p[k], p[(k + 1) % 3]);
        edges.set(e, (edges.get(e) ?? 0) + 1);
      }
      const [a, b, c] = p;
      volume +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) -
          a[1] * (b[0] * c[2] - b[2] * c[0]) +
          a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6;
    }
    for (const [e, count] of edges) {
      expect(count).toBe(1);
      const [a, b] = e.split('>');
      expect(edges.get(`${b}>${a}`)).toBe(1);
    }
    // Outward normals give a positive volume, at least that of the base plate.
    const plate = 20 * 0.5 * 16 * 0.5 * 2;
    expect(volume).toBeGreaterThan(plate);
    expect(volume).toBeLessThan(plate * 3);
  });

  it('OBJ has matching vertex and face counts', async () => {
    const g = buildGrid(bumpField(10, 8), 10, 8, dims, 64);
    const text = await writeObj(g).text();
    const v = text.split('\n').filter((l) => l.startsWith('v ')).length;
    const faces = text.split('\n').filter((l) => l.startsWith('f '));
    const perimeter = 2 * 9 + 2 * 7;
    expect(v).toBe(80 + perimeter + 1);
    expect(faces.length).toBe(triangleCount(g));
    for (const f of faces)
      for (const idx of f.split(' ').slice(1)) {
        expect(Number(idx)).toBeGreaterThanOrEqual(1);
        expect(Number(idx)).toBeLessThanOrEqual(v);
      }
  });
});

describe('image export', () => {
  it('PNG16 round-trips through zlib', async () => {
    const w = 7;
    const h = 5;
    const f = new Float32Array(w * h).map((_, i) => i / (w * h - 1));
    const png = new Uint8Array(await (await writePng16(f, w, h)).arrayBuffer());
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(png.buffer);
    expect(dv.getUint32(16)).toBe(w);
    expect(dv.getUint32(20)).toBe(h);
    expect(png[24]).toBe(16);
    const idatLen = dv.getUint32(33);
    expect(String.fromCharCode(...png.subarray(37, 41))).toBe('IDAT');
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect(raw.length).toBe(h * (1 + w * 2));
    const last = raw.length - 2;
    expect((raw[last] << 8) | raw[last + 1]).toBe(65535);
    expect((raw[1] << 8) | raw[2]).toBe(0);
  });

  it('EXR has a valid header and scanline table', () => {
    const w = 6;
    const h = 4;
    const f = new Float32Array(w * h).map((_, i) => i * 0.25);
    const buf = writeExr(f, w, h);
    const dv = new DataView(buf);
    expect(dv.getInt32(0, true)).toBe(20000630);
    expect(dv.getInt32(4, true)).toBe(2);
    const text = new TextDecoder('latin1').decode(buf.slice(0, 400));
    for (const name of ['channels', 'compression', 'dataWindow', 'displayWindow', 'lineOrder'])
      expect(text).toContain(name);
    // The last scanline's offset points at a chunk holding y = h-1.
    const chunk = 8 + w * 4;
    const dataStart = buf.byteLength - h * chunk;
    const tableStart = dataStart - h * 8;
    const off = Number(dv.getBigUint64(tableStart + (h - 1) * 8, true));
    expect(off).toBe(dataStart + (h - 1) * chunk);
    expect(dv.getInt32(off, true)).toBe(h - 1);
    expect(dv.getInt32(off + 4, true)).toBe(w * 4);
    expect(dv.getFloat32(off + 8 + (w - 1) * 4, true)).toBeCloseTo((w * h - 1) * 0.25);
  });

  it('PFM stores rows bottom-up', () => {
    const f = new Float32Array([1, 2, 3, 4, 5, 6]);
    const buf = writePfm(f, 3, 2);
    const head = 'Pf\n3 2\n-1.0\n'.length;
    const dv = new DataView(buf);
    expect(dv.getFloat32(head, true)).toBe(4);
    expect(dv.getFloat32(head + 20, true)).toBe(3);
  });
});
