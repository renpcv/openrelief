/// <reference lib="webworker" />
import { generateRelief, type ReliefParams } from './relief';

export interface ReliefRequest {
  width: number;
  height: number;
  depth: Float32Array;
  mask: Uint8Array;
  params: ReliefParams;
}

export type ReliefMessage =
  | { type: 'progress'; stage: string; fraction: number }
  | { type: 'done'; height: Float32Array; background: number; iterations: number; residual: number; ms: number }
  | { type: 'error'; message: string };

const post = (m: ReliefMessage, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

self.onmessage = (e: MessageEvent<ReliefRequest>) => {
  const { width, height, depth, mask, params } = e.data;
  const t0 = performance.now();
  try {
    const r = generateRelief(width, height, depth, mask, params, (stage, fraction) =>
      post({ type: 'progress', stage, fraction }),
    );
    post(
      {
        type: 'done',
        height: r.height,
        background: r.background,
        iterations: r.solverCycles,
        residual: r.solverResidual,
        ms: performance.now() - t0,
      },
      [r.height.buffer],
    );
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
