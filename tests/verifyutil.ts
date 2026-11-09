import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadWorksheetFile } from '../src/import';
import { computeWorksheet } from '../src/engine/worksheet';
import type { MathRegion } from '../src/engine/model';

export interface FileReport {
  file: string; ms?: number; regions: number; math: number; disabled: number; errors: number;
  match: number; mismatch: number; total: number; warnings: string[];
  failures: { src: string; expected: string; got: string }[];
}

export async function verifyFile(path: string): Promise<FileReport> {
  const name = path.split('/').pop()!;
  const ws = await loadWorksheetFile(name, readFileSync(path));
  const t0 = Date.now();
  const res = computeWorksheet(ws);
  const ms = Date.now() - t0;
  const math = ws.regions.filter(r => r.type === 'math') as MathRegion[];
  const failures: FileReport['failures'] = [];
  for (const r of math) {
    const rr = res.results[r.id];
    if (rr?.check?.status === 'mismatch') failures.push({ src: r.src, expected: rr.check.expected, got: rr.error ? 'FEHLER: ' + rr.error.message : (rr.resultText ?? '') });
  }
  return {
    file: name, ms, regions: ws.regions.length, math: math.length, disabled: math.filter(m => m.disabled).length,
    errors: Object.values(res.results).filter(r => r.error).length,
    match: res.verification?.match ?? 0, mismatch: res.verification?.mismatch ?? 0, total: res.verification?.total ?? 0,
    warnings: ws.source?.warnings ?? [], failures,
  };
}

export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /\.(xmcd|mcdx)$/i.test(f)).map(f => join(dir, f)).sort();
}
