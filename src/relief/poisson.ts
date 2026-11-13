/**
 * Solver for the masked Poisson problem
 *
 *     4*u[p] - sum(u[n] for the 4 neighbours n) = rhs[p]     for p inside the mask
 *     u[p] = 0                                               for p outside the mask
 *
 * Pixels beyond the image border count as "outside".
 *
 * Optionally each pixel edge carries a weight (how strongly its target
 * difference is enforced); the equation then reads
 *
 *     sum over neighbours n of weight(p,n) * (u[p] - u[n]) = rhs[p].
 *
 * Method: conjugate gradients preconditioned by one multigrid V-cycle.
 * The coarse grids are built by aggregation (each coarse cell is the union of
 * up to 2x2 fine cells) with Galerkin coarse operators, so irregular
 * silhouettes and odd image sizes are represented exactly on every level and
 * the iteration cannot diverge.
 */

interface Level {
  w: number;
  h: number;
  mask: Uint8Array;
  /** Operator diagonal; null when every edge has weight 1 (finest level only), where it is 4 everywhere. */
  diag: Float32Array | null;
  /** Weight of the link between a cell and its right neighbour (0 if none). */
  wR: Float32Array | null;
  /** Weight of the link between a cell and the one below it (0 if none). */
  wD: Float32Array | null;
  u: Float32Array;
  rhs: Float32Array;
  res: Float32Array;
}

export interface EdgeWeights {
  /** Weight of the edge between each pixel and its right neighbour. */
  right: Float32Array;
  /** Weight of the edge between each pixel and the one below it. */
  down: Float32Array;
  /** Weight of the edges that cross the image border. */
  border: number;
}

export interface PoissonOptions {
  /** Per-edge weights; omitted means every edge has weight 1. */
  weights?: EdgeWeights;
  /** Stop when the residual norm has dropped by this factor. */
  tolerance?: number;
  maxIterations?: number;
  onProgress?: (fraction: number) => void;
}

export interface PoissonResult {
  u: Float32Array;
  /** Number of iterations used. */
  cycles: number;
  /** Final residual norm relative to the initial one. */
  relativeResidual: number;
}

/** Coarse correction is scaled up to offset the stiffness of aggregation grids. */
const OVERCORRECTION = 1.6;

function coarsen(f: Level): Level {
  const { w, h, mask } = f;
  const cw = (w + 1) >> 1;
  const ch = (h + 1) >> 1;
  const cn = cw * ch;
  const cmask = new Uint8Array(cn);
  const diag = new Float32Array(cn);
  const wR = new Float32Array(cn);
  const wD = new Float32Array(cn);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const crow = (y >> 1) * cw;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (!mask[i]) continue;
      const c = crow + (x >> 1);
      cmask[c] = 1;
      diag[c] += f.diag ? f.diag[i] : 4;
      if (x < w - 1) {
        // Links to cells outside the mask are not unknown-to-unknown links:
        // they stay in the diagonal, pulling the cell towards zero.
        const wt = !mask[i + 1] ? 0 : f.wR ? f.wR[i] : 1;
        if (wt) {
          if (x & 1) wR[c] += wt;
          else diag[c] -= 2 * wt;
        }
      }
      if (y < h - 1) {
        const wt = !mask[i + w] ? 0 : f.wD ? f.wD[i] : 1;
        if (wt) {
          if (y & 1) wD[c] += wt;
          else diag[c] -= 2 * wt;
        }
      }
    }
  }
  return {
    w: cw,
    h: ch,
    mask: cmask,
    diag,
    wR,
    wD,
    u: new Float32Array(cn),
    rhs: new Float32Array(cn),
    res: new Float32Array(cn),
  };
}

/** One red-black Gauss-Seidel sweep; `reverse` runs black before red. */
function smooth(l: Level, reverse: boolean): void {
  const { w, h, mask, u, rhs, diag, wR, wD } = l;
  for (let pass = 0; pass < 2; pass++) {
    const color = reverse ? 1 - pass : pass;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = (y + color) & 1; x < w; x += 2) {
        const i = row + x;
        if (!mask[i]) continue;
        let sum = rhs[i];
        if (diag) {
          if (x > 0) sum += wR![i - 1] * u[i - 1];
          if (x < w - 1) sum += wR![i] * u[i + 1];
          if (y > 0) sum += wD![i - w] * u[i - w];
          if (y < h - 1) sum += wD![i] * u[i + w];
          u[i] = sum / diag[i];
        } else {
          if (x > 0) sum += u[i - 1];
          if (x < w - 1) sum += u[i + 1];
          if (y > 0) sum += u[i - w];
          if (y < h - 1) sum += u[i + w];
          u[i] = sum * 0.25;
        }
      }
    }
  }
}

/** out = A*v on a level. `v` must be zero outside the mask. */
function apply(l: Level, v: Float32Array, out: Float32Array): void {
  const { w, h, mask, diag, wR, wD } = l;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (!mask[i]) {
        out[i] = 0;
        continue;
      }
      let sum = 0;
      if (diag) {
        if (x > 0) sum += wR![i - 1] * v[i - 1];
        if (x < w - 1) sum += wR![i] * v[i + 1];
        if (y > 0) sum += wD![i - w] * v[i - w];
        if (y < h - 1) sum += wD![i] * v[i + w];
        out[i] = diag[i] * v[i] - sum;
      } else {
        if (x > 0) sum += v[i - 1];
        if (x < w - 1) sum += v[i + 1];
        if (y > 0) sum += v[i - w];
        if (y < h - 1) sum += v[i + w];
        out[i] = 4 * v[i] - sum;
      }
    }
  }
}

function vcycle(levels: Level[], k: number): void {
  const l = levels[k];
  if (k === levels.length - 1) {
    for (let s = 0; s < 8; s++) smooth(l, false);
    for (let s = 0; s < 8; s++) smooth(l, true);
    return;
  }
  smooth(l, false);
  smooth(l, false);

  // Residual, restricted (summed) onto the coarse grid.
  const c = levels[k + 1];
  apply(l, l.u, l.res);
  c.rhs.fill(0);
  c.u.fill(0);
  const { w, h, mask } = l;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const crow = (y >> 1) * c.w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (mask[i]) c.rhs[crow + (x >> 1)] += l.rhs[i] - l.res[i];
    }
  }

  vcycle(levels, k + 1);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    const crow = (y >> 1) * c.w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (mask[i]) l.u[i] += OVERCORRECTION * c.u[crow + (x >> 1)];
    }
  }
  smooth(l, true);
  smooth(l, true);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Note: `rhs` is used as working storage and is overwritten. */
export function solvePoisson(
  w: number,
  h: number,
  mask: Uint8Array,
  rhs: Float32Array,
  opts: PoissonOptions = {},
): PoissonResult {
  const tolerance = opts.tolerance ?? 1e-4;
  const maxIterations = opts.maxIterations ?? 100;
  const n = w * h;

  // r doubles as the finest level's right-hand side, z as its solution.
  const r = rhs;
  for (let i = 0; i < n; i++) if (!mask[i]) r[i] = 0;
  let diag: Float32Array | null = null;
  const weights = opts.weights;
  if (weights) {
    diag = new Float32Array(n);
    const { right, down, border } = weights;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (!mask[i]) continue;
        diag[i] =
          (x > 0 ? right[i - 1] : border) +
          (x < w - 1 ? right[i] : border) +
          (y > 0 ? down[i - w] : border) +
          (y < h - 1 ? down[i] : border);
      }
    }
  }
  const top: Level = {
    w,
    h,
    mask,
    diag,
    wR: weights ? weights.right : null,
    wD: weights ? weights.down : null,
    u: new Float32Array(n),
    rhs: r,
    res: new Float32Array(n),
  };
  const levels = [top];
  while (levels[levels.length - 1].w > 2 || levels[levels.length - 1].h > 2) {
    levels.push(coarsen(levels[levels.length - 1]));
  }

  const x = new Float32Array(n);
  const r0 = Math.sqrt(dot(r, r));
  if (r0 === 0) return { u: x, cycles: 0, relativeResidual: 0 };

  const z = top.u;
  const p = new Float32Array(n);
  const Ap = top.res; // only used inside the V-cycle otherwise
  const logTol = Math.log(tolerance);
  let rz = 0;
  let rel = 1;
  let it = 0;
  while (it < maxIterations) {
    z.fill(0);
    vcycle(levels, 0);
    const rzNew = dot(r, z);
    if (it === 0) p.set(z);
    else {
      const beta = rzNew / rz;
      for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    }
    rz = rzNew;
    apply(top, p, Ap);
    const pAp = dot(p, Ap);
    if (!(pAp > 0)) break;
    const alpha = rz / pAp;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * Ap[i];
    }
    it++;
    rel = Math.sqrt(dot(r, r)) / r0;
    opts.onProgress?.(Math.min(1, Math.log(Math.max(rel, tolerance)) / logTol));
    if (rel <= tolerance) break;
  }
  return { u: x, cycles: it, relativeResidual: rel };
}
