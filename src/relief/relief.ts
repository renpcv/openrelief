/**
 * Bas-relief generation from a height field.
 *
 * The approach follows the published gradient-domain literature
 * (Weyrich et al. 2007, "Digital Bas-Relief from 3D Scenes"; Kerber et al. 2009):
 *
 *   1. take the height field's gradients,
 *   2. replace depth discontinuities (silhouettes, occlusion edges) by small,
 *      controlled steps and compress the remaining slopes non-linearly,
 *   3. integrate the modified gradients back into a height field by solving a
 *      Poisson equation, with the background pinned to zero,
 *   4. post-process (detail emphasis, smoothing) and scale to the target depth.
 *
 * Input heights are expressed in pixels (model height * pixels per model unit),
 * so gradients are true geometric slopes and the settings behave the same at
 * every output resolution.
 */

import { solvePoisson } from './poisson';

export type ReliefMode = 'compressed' | 'raw';

export interface ReliefParams {
  mode: ReliefMode;
  /**
   * Slope compression strength (0 = none). Steep slopes are flattened more
   * than gentle ones: s -> log(1 + a*s) / a.
   */
  compression: number;
  /** Height of the step where a model meets the background, as a fraction of the image's long side. */
  silhouetteStep: number;
  /** Height kept at occlusion edges inside the model, as a fraction of the image's long side. */
  occlusionStep: number;
  /** Slope above which an edge counts as a depth discontinuity. */
  discontinuitySlope: number;
  /** Unsharp-mask amount applied to the result (0 = off). */
  detail: number;
  /** Unsharp-mask radius, as a fraction of the image's long side. */
  detailRadius: number;
  /** Final smoothing radius in pixels, applied to the whole relief including its outline (0 = off). */
  smoothing: number;
}

export const defaultParams: ReliefParams = {
  mode: 'compressed',
  compression: 5,
  silhouetteStep: 0.004,
  occlusionStep: 0.004,
  discontinuitySlope: 6,
  detail: 0.5,
  detailRadius: 0.01,
  smoothing: 0,
};

export interface ReliefResult {
  /** Relief heights normalised to 0..1 (0 = lowest point, 1 = highest). */
  height: Float32Array;
  /** Level of the background plane: 0 unless parts of the relief are recessed below it. */
  background: number;
  width: number;
  heightPx: number;
  solverCycles: number;
  solverResidual: number;
}

export type Progress = (stage: string, fraction: number) => void;

/**
 * @param w      image width
 * @param h      image height
 * @param depth  heights in pixel units, larger = closer to the viewer
 * @param mask   1 where a model covers the pixel, 0 for background
 */
export function generateRelief(
  w: number,
  h: number,
  depth: Float32Array,
  mask: Uint8Array,
  params: ReliefParams,
  onProgress: Progress = () => {},
): ReliefResult {
  const n = w * h;
  const longSide = Math.max(w, h);
  let out: Float32Array;
  let cycles = 0;
  let rel = 0;

  if (params.mode === 'raw') {
    out = new Float32Array(n);
    let min = Infinity;
    for (let i = 0; i < n; i++) if (mask[i] && depth[i] < min) min = depth[i];
    const lift = params.silhouetteStep * longSide;
    for (let i = 0; i < n; i++) if (mask[i]) out[i] = depth[i] - min + lift;
  } else {
    onProgress('Compressing gradients', 0);
    const rhs = buildRhs(w, h, depth, mask, params, longSide);
    const sol = solvePoisson(w, h, mask, rhs, {
      onProgress: (f) => onProgress('Integrating', f),
    });
    out = sol.u;
    cycles = sol.cycles;
    rel = sol.relativeResidual;
  }

  if (params.detail > 0 && params.detailRadius > 0) {
    onProgress('Enhancing detail', 0);
    const radius = Math.max(1, params.detailRadius * longSide);
    const blurred = maskedBlur(w, h, out, mask, radius);
    for (let i = 0; i < n; i++) if (mask[i]) out[i] += params.detail * (out[i] - blurred[i]);
  }

  // Normalise to 0..1. Normally the background is the lowest level (0). Deep
  // recesses (the inside of an open box, say) can come out lower than the
  // background. Cutting them off at the background would leave a flat patch,
  // and squeezing them above it creases the surface where it crosses that
  // level, so they keep their shape: the lowest point becomes 0 and the
  // background plane sits above it.
  let max = 0;
  let min = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    if (out[i] > max) max = out[i];
    if (out[i] < min) min = out[i];
  }
  const range = max - min;
  const background = range > 0 && min < 0 ? -min / range : 0;
  const inv = range > 0 ? 1 / range : 0;
  for (let i = 0; i < n; i++) out[i] = mask[i] ? (out[i] - min) * inv : background;

  // Final smoothing runs over the whole image, background included, so it
  // also softens the step where a model meets the background (and the
  // pixel-stair jaggies along it), not just the surface inside the outline.
  let level = background;
  if (params.smoothing > 0) {
    onProgress('Smoothing', 0);
    out = maskedBlur(w, h, out, new Uint8Array(n).fill(1), params.smoothing);
    // Blurring pulls the extremes in slightly; stretch back to the full 0..1.
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      if (out[i] < lo) lo = out[i];
      if (out[i] > hi) hi = out[i];
    }
    if (hi > lo) {
      const k = 1 / (hi - lo);
      for (let i = 0; i < n; i++) out[i] = (out[i] - lo) * k;
      level = Math.min(1, Math.max(0, (background - lo) * k));
    }
  }
  onProgress('Done', 1);
  return { height: out, width: w, heightPx: h, background: level, solverCycles: cycles, solverResidual: rel };
}

/** Target difference (to - from) for one pixel edge. */
function edgeTarget(
  dFrom: number,
  dTo: number,
  mFrom: number,
  mTo: number,
  alpha: number,
  tau: number,
  silPx: number,
  occPx: number,
): number {
  if (!mFrom && !mTo) return 0;
  if (!mFrom) return silPx;
  if (!mTo) return -silPx;
  const g = dTo - dFrom;
  const a = Math.abs(g);
  if (a > tau) return g > 0 ? Math.min(a, occPx) : -Math.min(a, occPx);
  if (alpha <= 0) return g;
  const c = Math.log1p(alpha * a) / alpha;
  return g > 0 ? c : -c;
}

function buildRhs(
  w: number,
  h: number,
  depth: Float32Array,
  mask: Uint8Array,
  p: ReliefParams,
  longSide: number,
): Float32Array {
  const rhs = new Float32Array(w * h);
  const silPx = p.silhouetteStep * longSide;
  const occPx = p.occlusionStep * longSide;
  const alpha = p.compression;
  const tau = p.discontinuitySlope;
  // Minimising sum over edges of (u[q] - u[p] - t)^2 gives, for each pixel,
  // 4u - sum(neighbours) = -(sum of targets pointing away from the pixel).
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const mi = mask[i];
      if (x < w - 1) {
        const j = i + 1;
        const t = edgeTarget(depth[i], depth[j], mi, mask[j], alpha, tau, silPx, occPx);
        rhs[i] -= t;
        rhs[j] += t;
      } else if (mi) {
        rhs[i] += silPx; // image border acts as background
      }
      if (y < h - 1) {
        const j = i + w;
        const t = edgeTarget(depth[i], depth[j], mi, mask[j], alpha, tau, silPx, occPx);
        rhs[i] -= t;
        rhs[j] += t;
      } else if (mi) {
        rhs[i] += silPx;
      }
      if (mi) {
        if (x === 0) rhs[i] += silPx;
        if (y === 0) rhs[i] += silPx;
      }
    }
  }
  return rhs;
}

/**
 * Approximate Gaussian blur (three box passes) that only averages pixels
 * inside the mask, so the background never bleeds into the model.
 */
export function maskedBlur(
  w: number,
  h: number,
  src: Float32Array,
  mask: Uint8Array,
  sigma: number,
): Float32Array {
  const n = w * h;
  let val = new Float32Array(n);
  let wgt = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (mask[i]) {
      val[i] = src[i];
      wgt[i] = 1;
    }
  }
  // Box radius whose three-fold convolution approximates the Gaussian.
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2));
  let tmpV = new Float32Array(n);
  let tmpW = new Float32Array(n);
  for (let pass = 0; pass < 3; pass++) {
    boxH(w, h, val, tmpV, r);
    boxH(w, h, wgt, tmpW, r);
    boxV(w, h, tmpV, val, r);
    boxV(w, h, tmpW, wgt, r);
  }
  tmpV = tmpW = null!;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) if (mask[i] && wgt[i] > 1e-6) out[i] = val[i] / wgt[i];
  return out;
}

function boxH(w: number, h: number, src: Float32Array, dst: Float32Array, r: number): void {
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) acc += src[row + x];
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc * norm;
      const add = x + r + 1;
      const sub = x - r;
      if (add < w) acc += src[row + add];
      if (sub >= 0) acc -= src[row + sub];
    }
  }
}

function boxV(w: number, h: number, src: Float32Array, dst: Float32Array, r: number): void {
  const norm = 1 / (2 * r + 1);
  const acc = new Float64Array(w);
  for (let y = 0; y <= Math.min(r, h - 1); y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) acc[x] += src[row + x];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) dst[row + x] = acc[x] * norm;
    const add = y + r + 1;
    const sub = y - r;
    if (add < h) {
      const ar = add * w;
      for (let x = 0; x < w; x++) acc[x] += src[ar + x];
    }
    if (sub >= 0) {
      const sr = sub * w;
      for (let x = 0; x < w; x++) acc[x] -= src[sr + x];
    }
  }
}
