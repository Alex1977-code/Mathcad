/// <reference lib="webworker" />
import { ComputeSession, type ComputeResult, type Progress } from '../engine/worksheet';
import type { Worksheet } from '../engine/model';

/**
 * Calculation thread. Work is done in time slices; between slices the worker checks for a newer
 * request and, if there is one, abandons the current run. Thanks to the incremental session the
 * already computed prefix is kept, so the next run resumes at the first changed region.
 */
const session = new ComputeSession();
let latest: { id: number; ws: Worksheet } | null = null;
let running = false;
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

const channel = new MessageChannel();
let wake: (() => void) | null = null;
channel.port1.onmessage = () => { const w = wake; wake = null; w?.(); };
const yieldNow = () => new Promise<void>((res) => { wake = res; channel.port2.postMessage(0); });

async function loop() {
  running = true;
  while (latest) {
    const req = latest;
    latest = null;
    try {
      const it = session.run(req.ws);
      let sliceStart = performance.now();
      let step: IteratorResult<Progress, ComputeResult>;
      let abandoned = false;
      for (;;) {
        step = it.next();
        if (step.done) break;
        if (performance.now() - sliceStart > 40) {
          post({ id: req.id, progress: step.value });
          await yieldNow();
          if (latest) { abandoned = true; break; }
          sliceStart = performance.now();
        }
      }
      if (!abandoned) post({ id: req.id, result: (step as IteratorReturnResult<ComputeResult>).value });
    } catch (err) {
      post({ id: req.id, error: String((err as Error)?.message ?? err) });
    }
  }
  running = false;
}

self.onmessage = (e: MessageEvent<{ id: number; ws: Worksheet }>) => {
  latest = e.data;
  if (!running) loop();
};
