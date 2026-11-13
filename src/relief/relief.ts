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

import { type EdgeWeights, solvePoisson } from './poisson';

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
  /**
   * How strongly the steps at depth discontinuities (outlines and occlusion
   * edges) are enforced, from 1 (as strongly as the surface's own shape) down
   * towards 0. Forcing every outline to sit at the same small height above
   * the background contradicts a surface that is, say, tilted away from the
   * viewer, and at 1 that contradiction is spread into the surface as bending
   * near its ends. Lower values let the step height vary along the outline
   * instead, so straight things stay straight.
   */
  edgeWeight: number;
  /**
   * How much of each surface's overall tilt (towards or away from the viewer)
   * to remove before compressing, 0..1. A tilted surface otherwise spends the
   * relief's depth on the tilt instead of on its detail. The tilt is removed
   * as a plane per continuous surface, so straight edges stay straight.
   */
  levelling: number;
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
  edgeWeight: 0.0063,
  levelling: 1,
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
    const { rhs, weights } = buildSystem(w, h, depth, mask, params, longSide);
    const sol = solvePoisson(w, h, mask, rhs, {
      weights,
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

/**
 * Splits the model into continuous surfaces (pixels connected without
 * crossing a depth discontinuity) and fits a plane to each one.
 * Returns each pixel's surface index and each surface's slope in x and y.
 */
function fitSurfaceTilts(
  w: number,
  h: number,
  depth: Float32Array,
  mask: Uint8Array,
  tau: number,
): { label: Int32Array; tiltX: number[]; tiltY: number[] } {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const tiltX: number[] = [];
  const tiltY: number[] = [];
  for (let start = 0; start < n; start++) {
    if (!mask[start] || label[start] >= 0) continue;
    const id = tiltX.length;
    let top = 0;
    stack[top++] = start;
    label[start] = id;
    // Sums for a least-squares plane fit, with coordinates relative to the start pixel.
    const x0 = start % w;
    const y0 = (start - x0) / w;
    const z0 = depth[start];
    let cnt = 0, sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
    while (top > 0) {
      const i = stack[--top];
      const xi = i % w;
      const x = xi - x0;
      const y = (i - xi) / w - y0;
      const d = depth[i];
      const z = d - z0;
      cnt++; sx += x; sy += y; sz += z; sxx += x * x; sxy += x * y; syy += y * y; sxz += x * z; syz += y * z;
      if (xi > 0) {
        const j = i - 1;
        if (mask[j] && label[j] < 0 && Math.abs(depth[j] - d) <= tau) { label[j] = id; stack[top++] = j; }
      }
      if (xi < w - 1) {
        const j = i + 1;
        if (mask[j] && label[j] < 0 && Math.abs(depth[j] - d) <= tau) { label[j] = id; stack[top++] = j; }
      }
      if (i >= w) {
        const j = i - w;
        if (mask[j] && label[j] < 0 && Math.abs(depth[j] - d) <= tau) { label[j] = id; stack[top++] = j; }
      }
      if (i < n - w) {
        const j = i + w;
        if (mask[j] && label[j] < 0 && Math.abs(depth[j] - d) <= tau) { label[j] = id; stack[top++] = j; }
      }
    }
    // Covariances; the plane's slopes solve the 2x2 normal equations.
    const cxx = sxx - (sx * sx) / cnt;
    const cxy = sxy - (sx * sy) / cnt;
    const cyy = syy - (sy * sy) / cnt;
    const cxz = sxz - (sx * sz) / cnt;
    const cyz = syz - (sy * sz) / cnt;
    // Solve along the principal axes of the surface's footprint, using only
    // the directions in which it has real extent (over ~2 px RMS). A wide
    // surface gets a full plane; a narrow strip gets the slope along its
    // length only; a speck gets nothing.
    let ax = 0;
    let ay = 0;
    if (cnt >= 64) {
      const half = (cxx + cyy) / 2;
      const root = Math.sqrt(Math.max(0, ((cxx - cyy) / 2) ** 2 + cxy * cxy));
      const minExtent = 4 * cnt;
      for (const lambda of [half + root, half - root]) {
        if (lambda < minExtent) continue;
        // Eigenvector of [[cxx, cxy], [cxy, cyy]] for this eigenvalue.
        let vx = cxy;
        let vy = lambda - cxx;
        if (Math.abs(vx) + Math.abs(vy) < 1e-9 * lambda) {
          vx = lambda - cyy;
          vy = cxy;
        }
        if (Math.abs(vx) + Math.abs(vy) < 1e-9 * lambda) {
          // Isotropic footprint: any axis is principal.
          vx = lambda === half + root ? 1 : 0;
          vy = 1 - vx;
        }
        const len = Math.hypot(vx, vy);
        vx /= len;
        vy /= len;
        const slope = (vx * cxz + vy * cyz) / lambda;
        ax += slope * vx;
        ay += slope * vy;
      }
    }
    tiltX.push(ax);
    tiltY.push(ay);
  }
  return { label, tiltX, tiltY };
}

/** Set by edgeTarget: whether the edge it just looked at is a depth discontinuity. */
let edgeIsStep = false;

/**
 * Target difference (to - from) for one pixel edge. `tilt` is the slope to
 * take out of an ordinary surface edge before compressing it.
 */
function edgeTarget(
  dFrom: number,
  dTo: number,
  mFrom: number,
  mTo: number,
  tilt: number,
  alpha: number,
  tau: number,
  silPx: number,
  occPx: number,
): number {
  edgeIsStep = true;
  if (!mFrom && !mTo) return 0;
  if (!mFrom) return silPx;
  if (!mTo) return -silPx;
  const raw = dTo - dFrom;
  const size = Math.abs(raw);
  if (size > tau) return raw > 0 ? Math.min(size, occPx) : -Math.min(size, occPx);
  edgeIsStep = false;
  const g = raw - tilt;
  if (alpha <= 0) return g;
  const a = Math.abs(g);
  const c = Math.log1p(alpha * a) / alpha;
  return g > 0 ? c : -c;
}

function buildSystem(
  w: number,
  h: number,
  depth: Float32Array,
  mask: Uint8Array,
  p: ReliefParams,
  longSide: number,
): { rhs: Float32Array; weights?: EdgeWeights } {
  const rhs = new Float32Array(w * h);
  // Weight of discontinuity edges; ordinary surface edges always weigh 1.
  const ws = Math.min(1, Math.max(1e-4, p.edgeWeight));
  const weighted = ws < 1;
  const right = weighted ? new Float32Array(w * h).fill(1) : null;
  const down = weighted ? new Float32Array(w * h).fill(1) : null;
  const level = Math.min(1, Math.max(0, p.levelling));
  const tilts = level > 0 ? fitSurfaceTilts(w, h, depth, mask, p.discontinuitySlope) : null;
  const silPx = p.silhouetteStep * longSide;
  const occPx = p.occlusionStep * longSide;
  const alpha = p.compression;
  const tau = p.discontinuitySlope;
  // Minimising sum over edges of weight * (u[q] - u[p] - t)^2 gives, for each
  // pixel, sum(weight * (u - neighbour)) = -(sum of weight * target pointing
  // away from the pixel).
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const mi = mask[i];
      const surface = tilts && mi ? tilts.label[i] : -1;
      const tx = surface >= 0 ? level * tilts!.tiltX[surface] : 0;
      const ty = surface >= 0 ? level * tilts!.tiltY[surface] : 0;
      if (x < w - 1) {
        const j = i + 1;
        let t = edgeTarget(depth[i], depth[j], mi, mask[j], tx, alpha, tau, silPx, occPx);
        if (edgeIsStep) {
          t *= ws;
          if (right) right[i] = ws;
        }
        rhs[i] -= t;
        rhs[j] += t;
      } else if (mi) {
        rhs[i] += ws * silPx; // image border acts as background
      }
      if (y < h - 1) {
        const j = i + w;
        let t = edgeTarget(depth[i], depth[j], mi, mask[j], ty, alpha, tau, silPx, occPx);
        if (edgeIsStep) {
          t *= ws;
          if (down) down[i] = ws;
        }
        rhs[i] -= t;
        rhs[j] += t;
      } else if (mi) {
        rhs[i] += ws * silPx;
      }
      if (mi) {
        if (x === 0) rhs[i] += ws * silPx;
        if (y === 0) rhs[i] += ws * silPx;
      }
    }
  }
  return { rhs, weights: right && down ? { right, down, border: ws } : undefined };
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
