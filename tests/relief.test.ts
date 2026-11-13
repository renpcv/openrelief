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
      if (!mask[i]) expect(r.height[i]).toBe(Math.fround(r.background));
      max = Math.max(max, r.height[i]);
    }
    expect(max).toBeCloseTo(1, 5);
    // A convex shape has no real recesses, so the background stays near the lowest level.
    expect(r.background).toBeLessThan(0.15);
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

  it('keeps recesses that fall below the background instead of cutting them off flat', () => {
    // An open box seen from the front: a raised rim around a floor that
    // slopes far away from the viewer, well below the level of the rim's base.
    const size = 128;
    const depth = new Float32Array(size * size);
    const mask = new Uint8Array(size * size);
    for (let y = 16; y < 112; y++)
      for (let x = 16; x < 112; x++) {
        const i = y * size + x;
        mask[i] = 1;
        const rim = x < 22 || x >= 106 || y < 22 || y >= 106;
        depth[i] = rim ? 600 : 500 - (x - 22) * 5;
      }
    // (Levelling is off here: it would, rightly, flatten the evenly sloping floor.)
    const r = generateRelief(size, size, depth, mask, {
      ...defaultParams,
      detail: 0,
      levelling: 0,
      edgeWeight: 1,
    });
    // The background plane sits above the lowest point...
    expect(r.background).toBeGreaterThan(0.05);
    expect(r.height[0]).toBeCloseTo(r.background, 6);
    let min = 1;
    for (let i = 0; i < r.height.length; i++) min = Math.min(min, r.height[i]);
    expect(min).toBeCloseTo(0, 6);
    // ...and the floor keeps descending all the way across, rather than
    // ending in a flat, cut-off patch.
    const row = 64 * size;
    for (let x = 24; x < 104; x++) expect(r.height[row + x + 1]).toBeLessThan(r.height[row + x]);
  });

  it('smoothing softens the step where the model meets the background', () => {
    const size = 96;
    const depth = new Float32Array(size * size);
    const mask = new Uint8Array(size * size);
    for (let y = 24; y < 72; y++)
      for (let x = 24; x < 72; x++) {
        mask[y * size + x] = 1;
        depth[y * size + x] = 50;
      }
    const sharp = generateRelief(size, size, depth, mask, { ...defaultParams, detail: 0 });
    const soft = generateRelief(size, size, depth, mask, { ...defaultParams, detail: 0, smoothing: 2 });
    const row = 48 * size;
    const step = (r: { height: Float32Array }) => r.height[row + 24] - r.height[row + 23];
    // Unsmoothed, the whole rise happens between two neighbouring pixels...
    expect(sharp.height[row + 23]).toBe(0);
    expect(step(sharp)).toBeGreaterThan(0.3);
    // ...smoothed, it is spread out: a smaller jump, and background next to the model is lifted.
    expect(step(soft)).toBeLessThan(step(sharp) * 0.6);
    expect(soft.height[row + 23]).toBeGreaterThan(0.01);
    // Far from the model the background is still flat and at the bottom.
    expect(soft.height[0]).toBeCloseTo(0, 5);
    let max = 0;
    for (const v of soft.height) max = Math.max(max, v);
    expect(max).toBeCloseTo(1, 5);
  });

  it('keeps the ridges of a tilted corrugated sheet uniform to their ends', () => {
    // A corrugated sheet tilted away from the viewer along its ridges, with a slanted outline.
    const size = 256;
    const scene = () => {
      const depth = new Float32Array(size * size);
      const mask = new Uint8Array(size * size);
      for (let y = 30; y <= 225; y++)
        for (let x = 0; x < size; x++) {
          const u = x - 30 - (y - 30) * 0.3; // position across the ridges
          if (u < 0 || u > 150) continue;
          const p = u % 30;
          const ridge = p < 10 ? p : p < 15 ? 10 : p < 25 ? 25 - p : 0; // 10 px high
          mask[y * size + x] = 1;
          depth[y * size + x] = 200 - (y - 30) * 0.8 + ridge;
        }
      return { depth, mask };
    };
    /** Ridge height (top minus the valley beside it) at row y, as a fraction of the relief's depth. */
    const ridgeHeight = (r: { height: Float32Array }, y: number) => {
      const x0 = 30 + (y - 30) * 0.3;
      return r.height[y * size + Math.round(x0 + 72)] - r.height[y * size + Math.round(x0 + 88)];
    };
    const a = scene();
    const pinned = generateRelief(size, size, a.depth, a.mask, {
      ...defaultParams,
      detail: 0,
      edgeWeight: 1,
      levelling: 0,
    });
    const b = scene();
    const free = generateRelief(size, size, b.depth, b.mask, { ...defaultParams, detail: 0 });
    // Rigid pinning squashes the ridges towards the sheet's ends...
    expect(ridgeHeight(pinned, 34) / ridgeHeight(pinned, 128)).toBeLessThan(0.75);
    // ...the defaults keep them nearly the same height all the way along,
    for (const y of [34, 60, 200, 221])
      expect(ridgeHeight(free, y) / ridgeHeight(free, 128)).toBeGreaterThan(0.85);
    // and still spend a good share of the depth on the ridges rather than on the tilt.
    expect(ridgeHeight(free, 128)).toBeGreaterThan(0.3);
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
