import { describe, expect, it } from 'vitest';
import { solvePoisson } from '../src/relief/poisson';
import { defaultParams, generateRelief, maskedBlur } from '../src/relief/relief';

/** A sphere of radius r (pixels) resting in front of an empty background. */
function sphereScene(size: number, r: number) {
  const depth = new Float32Array(size * size);
  const mask = new Uint8Array(size * size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d2 = (x - c) ** 2 + (y - c) ** 2;
      if (d2 < r * r) {
        depth[y * size + x] = Math.sqrt(r * r - d2);
        mask[y * size + x] = 1;
      }
    }
  }
  return { depth, mask };
}

describe('solvePoisson', () => {
  it('recovers a known solution on an irregular mask', () => {
    const size = 97; // odd on purpose
    const { mask } = sphereScene(size, 40);
    const truth = new Float32Array(size * size);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        if (mask[y * size + x]) truth[y * size + x] = Math.sin(x * 0.2) * Math.cos(y * 0.13) + 2;
    const rhs = new Float32Array(size * size);
    const at = (x: number, y: number) =>
      x < 0 || y < 0 || x >= size || y >= size ? 0 : truth[y * size + x];
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        if (mask[y * size + x])
          rhs[y * size + x] =
            4 * at(x, y) - at(x - 1, y) - at(x + 1, y) - at(x, y - 1) - at(x, y + 1);
    const sol = solvePoisson(size, size, mask, rhs, { tolerance: 1e-6 });
    expect(sol.relativeResidual).toBeLessThanOrEqual(1e-6);
    let maxErr = 0;
    for (let i = 0; i < truth.length; i++) maxErr = Math.max(maxErr, Math.abs(sol.u[i] - truth[i]));
    expect(maxErr).toBeLessThan(1e-3);
  });

  it('converges quickly on a large grid', () => {
    const size = 512;
    const { depth, mask } = sphereScene(size, 200);
    const rhs = new Float32Array(size * size);
    for (let i = 0; i < rhs.length; i++) rhs[i] = mask[i] ? depth[i] * 0.01 : 0;
    const sol = solvePoisson(size, size, mask, rhs);
    expect(sol.relativeResidual).toBeLessThanOrEqual(1e-4);
    expect(sol.cycles).toBeLessThan(25);
  });
});

describe('generateRelief', () => {
  it('produces a normalised, background-flat relief', () => {
    const size = 128;
    const { depth, mask } = sphereScene(size, 50);
    const r = generateRelief(size, size, depth, mask, defaultParams);
    let max = 0;
    for (let i = 0; i < r.height.length; i++) {
      expect(r.height[i]).toBeGreaterThanOrEqual(0);
      if (!mask[i]) expect(r.height[i]).toBe(0);
      max = Math.max(max, r.height[i]);
    }
    expect(max).toBeCloseTo(1, 5);
    // The sphere's centre should be its highest region.
    const c = (size >> 1) * size + (size >> 1);
    expect(r.height[c]).toBeGreaterThan(0.9);
  });

  it('reproduces the input when nothing is compressed', () => {
    const size = 96;
    const { depth, mask } = sphereScene(size, 36);
    // Use a paraboloid, whose rim meets the background at (almost) zero
    // height, so pinning the background at 0 is consistent with the input.
    for (let i = 0; i < depth.length; i++) depth[i] = (depth[i] * depth[i]) / 36;
    const r = generateRelief(size, size, depth, mask, {
      ...defaultParams,
      compression: 0,
      discontinuitySlope: 1e9,
      silhouetteStep: 0,
      detail: 0,
    });
    // Compare shape after normalising the input the same way.
    let maxD = 0;
    for (let i = 0; i < depth.length; i++) maxD = Math.max(maxD, depth[i]);
    let err = 0;
    for (let i = 0; i < depth.length; i++)
      err = Math.max(err, Math.abs(r.height[i] - depth[i] / maxD));
    expect(err).toBeLessThan(0.06);
  });

  it('flattens tall shapes more than shallow detail', () => {
    // A tall block with a small bump on top: after compression the bump should
    // occupy a larger share of the total height than it did originally.
    const size = 128;
    const depth = new Float32Array(size * size);
    const mask = new Uint8Array(size * size);
    for (let y = 24; y < 104; y++)
      for (let x = 24; x < 104; x++) {
        const i = y * size + x;
        mask[i] = 1;
        const bump = Math.max(0, 6 - Math.hypot(x - 64, y - 64) * 0.5);
        depth[i] = 400 + bump;
      }
    const r = generateRelief(size, size, depth, mask, { ...defaultParams, detail: 0 });
    const top = r.height[64 * size + 64];
    const plateau = r.height[40 * size + 40];
    const share = (top - plateau) / top;
    expect(share).toBeGreaterThan(6 / 406 * 5);
  });

  it('raw mode is a linear rescale', () => {
    const size = 64;
    const { depth, mask } = sphereScene(size, 25);
    const r = generateRelief(size, size, depth, mask, {
      ...defaultParams,
      mode: 'raw',
      silhouetteStep: 0,
      detail: 0,
    });
    const c = (size >> 1) * size + (size >> 1);
    const q = (size >> 1) * size + (size >> 1) + 10;
    expect(r.height[q] / r.height[c]).toBeCloseTo(
      (depth[q] - minMasked(depth, mask)) / (depth[c] - minMasked(depth, mask)),
      4,
    );
  });
});

function minMasked(d: Float32Array, m: Uint8Array) {
  let min = Infinity;
  for (let i = 0; i < d.length; i++) if (m[i]) min = Math.min(min, d[i]);
  return min;
}

describe('maskedBlur', () => {
  it('keeps a constant field constant and ignores the background', () => {
    const size = 64;
    const { mask } = sphereScene(size, 20);
    const src = new Float32Array(size * size);
    for (let i = 0; i < src.length; i++) src[i] = mask[i] ? 3 : 100;
    const out = maskedBlur(size, size, src, mask, 4);
    for (let i = 0; i < out.length; i++) {
      if (mask[i]) expect(out[i]).toBeCloseTo(3, 4);
      else expect(out[i]).toBe(0);
    }
  });
});
