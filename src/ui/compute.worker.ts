/// <reference lib="webworker" />
import { computeWorksheet } from '../engine/worksheet';
import type { Worksheet } from '../engine/model';

self.onmessage = (e: MessageEvent<{ id: number; ws: Worksheet }>) => {
  const { id, ws } = e.data;
  try {
    const result = computeWorksheet(ws);
    (self as unknown as Worker).postMessage({ id, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
