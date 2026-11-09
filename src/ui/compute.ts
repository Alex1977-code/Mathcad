import { useEffect, useRef, useState } from 'react';
import type { Worksheet } from '../engine/model';
import type { ComputeResult, Progress } from '../engine/worksheet';
import { computeWorksheet } from '../engine/worksheet';

export interface ComputeState {
  result: ComputeResult | null;
  busy: boolean;
  error?: string;
  /** Progress of the running calculation (regions in evaluation order). */
  progress?: Progress;
  /** Document state the current result belongs to. */
  computedWs?: Worksheet;
}

/**
 * Recalculates the worksheet in a Web Worker. The worker works incrementally and checks for newer
 * requests between time slices, so typing never queues up stale calculations. Only if the worker
 * is stuck in a single very long region while a newer request waits is it restarted.
 */
export function useCompute(ws: Worksheet, delay = 60, auto = true): ComputeState & { recalc: () => void } {
  const [state, setState] = useState<ComputeState>({ result: null, busy: true });
  const worker = useRef<Worker | null>(null);
  const reqId = useRef(0);
  const sentWs = useRef<Worksheet | undefined>(undefined);
  const lastMsg = useRef(Date.now());
  const pendingSince = useRef<number | null>(null);
  const [manualTick, setManualTick] = useState(0);

  const spawn = () => {
    try {
      const w = new Worker(new URL('./compute.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ id: number; result?: ComputeResult; error?: string; progress?: Progress }>) => {
        lastMsg.current = Date.now();
        if (e.data.id !== reqId.current) return;
        if (e.data.progress) { setState(s => ({ ...s, busy: true, progress: e.data.progress })); return; }
        pendingSince.current = null;
        setState({ result: e.data.result ?? null, busy: false, error: e.data.error, computedWs: sentWs.current });
      };
      w.onerror = () => { pendingSince.current = null; setState(s => ({ ...s, busy: false, error: 'Berechnung abgebrochen' })); };
      worker.current = w;
    } catch {
      worker.current = null;
    }
  };

  useEffect(() => {
    spawn();
    // watchdog: a single region running for a long time blocks newer requests → restart the worker
    const t = setInterval(() => {
      if (pendingSince.current !== null && Date.now() - lastMsg.current > 3000 && Date.now() - pendingSince.current > 3000 && worker.current) {
        worker.current.terminate();
        spawn();
        lastMsg.current = Date.now();
        worker.current?.postMessage({ id: reqId.current, ws: latestWs.current });
      }
    }, 1000);
    return () => { clearInterval(t); worker.current?.terminate(); };
  }, []);

  const latestWs = useRef(ws);
  latestWs.current = ws;

  useEffect(() => {
    if (!auto && manualTick === 0) return;
    const t = setTimeout(() => {
      const id = ++reqId.current;
      sentWs.current = ws;
      pendingSince.current = Date.now();
      setState(s => ({ ...s, busy: true, progress: undefined }));
      if (worker.current) {
        worker.current.postMessage({ id, ws });
      } else {
        try { setState({ result: computeWorksheet(ws), busy: false, computedWs: ws }); } catch (e) { setState({ result: null, busy: false, error: String(e) }); }
        pendingSince.current = null;
      }
    }, delay);
    return () => clearTimeout(t);
  }, [auto ? ws : null, manualTick, auto]);

  return { ...state, recalc: () => setManualTick(n => n + 1) };
}
