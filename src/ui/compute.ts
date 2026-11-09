import { useEffect, useRef, useState } from 'react';
import type { Worksheet } from '../engine/model';
import type { ComputeResult } from '../engine/worksheet';
import { computeWorksheet } from '../engine/worksheet';

export interface ComputeState { result: ComputeResult | null; busy: boolean; error?: string }

/**
 * Recalculates the worksheet in a Web Worker (the UI never blocks). A new request supersedes a running
 * one: if the worker is still busy after a short grace period it is terminated and restarted.
 */
export function useCompute(ws: Worksheet, delay = 90): ComputeState {
  const [state, setState] = useState<ComputeState>({ result: null, busy: true });
  const worker = useRef<Worker | null>(null);
  const reqId = useRef(0);
  const busySince = useRef<number | null>(null);

  const spawn = () => {
    try {
      const w = new Worker(new URL('./compute.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ id: number; result?: ComputeResult; error?: string }>) => {
        if (e.data.id !== reqId.current) return;
        busySince.current = null;
        setState({ result: e.data.result ?? null, busy: false, error: e.data.error });
      };
      w.onerror = () => { busySince.current = null; setState(s => ({ ...s, busy: false, error: 'Berechnung abgebrochen' })); };
      worker.current = w;
    } catch {
      worker.current = null;
    }
  };

  useEffect(() => {
    spawn();
    return () => worker.current?.terminate();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      const id = ++reqId.current;
      if (busySince.current !== null && Date.now() - busySince.current > 400 && worker.current) {
        worker.current.terminate();
        spawn();
      }
      busySince.current = busySince.current ?? Date.now();
      setState(s => ({ ...s, busy: true }));
      if (worker.current) {
        worker.current.postMessage({ id, ws });
      } else {
        // fallback without worker support
        try { setState({ result: computeWorksheet(ws), busy: false }); } catch (e) { setState({ result: null, busy: false, error: String(e) }); }
        busySince.current = null;
      }
    }, delay);
    return () => clearTimeout(t);
  }, [ws]);

  return state;
}
