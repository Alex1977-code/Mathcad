// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ComputeSession, computeWorksheet, type ComputeResult } from '../src/engine/worksheet';
import { sortRegions, type MathRegion, type Worksheet } from '../src/engine/model';
import { exampleWorksheet } from '../src/ui/examples';
import { loadWorksheetFile } from '../src/import';

/** Comparable view of a result (timing removed). */
const view = (r: ComputeResult) => JSON.stringify({ ...r, millis: 0 }, (k, v) => (k === 'value' ? undefined : v));

function mutations(ws: Worksheet): Worksheet[] {
  const math = sortRegions(ws.regions).filter(r => r.type === 'math') as MathRegion[];
  const out: Worksheet[] = [];
  const pick = [0, Math.floor(math.length / 3), Math.floor(math.length / 2), math.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  for (const i of pick) {
    const r = math[i];
    out.push({ ...ws, regions: ws.regions.map(x => (x.id === r.id ? { ...r, src: r.src + ' ' } : x)) });          // whitespace edit
    out.push({ ...ws, regions: ws.regions.map(x => (x.id === r.id ? { ...r, src: 'zz := 1' } : x)) });            // content change
    out.push({ ...ws, regions: ws.regions.filter(x => x.id !== r.id) });                                           // deletion
    out.push({ ...ws, regions: ws.regions.map(x => (x.id === r.id ? { ...r, y: r.y + 4000 } : x)) });             // move to the end
  }
  out.push({ ...ws, settings: { ...ws.settings, decimals: 5 } });
  return out;
}

async function sheets(): Promise<[string, Worksheet][]> {
  const list: [string, Worksheet][] = [['Beispiel', exampleWorksheet()]];
  for (const f of ['RC_torsion', 'matrices', 'solve_as_function', 'statistics', 'shrinkage']) {
    list.push([f, await loadWorksheetFile(f + '.mcdx', readFileSync(join(__dirname, 'fixtures/mathcad/prime', f + '.mcdx')))]);
  }
  list.push(['xmcd', await loadWorksheetFile('b.xmcd', readFileSync(join(__dirname, 'fixtures/mathcad/beispiel_mathcad15.xmcd')))]);
  return list;
}

describe('incremental recalculation', () => {
  it('gives exactly the same results as a full recalculation after every kind of edit', { timeout: 120000 }, async () => {
    for (const [name, base] of await sheets()) {
      const session = new ComputeSession();
      expect(view(session.runToEnd(base)), name).toBe(view(computeWorksheet(base)));
      let cur = base;
      for (const m of [...mutations(base), base]) {
        expect(view(session.runToEnd(m)), `${name}: Änderung`).toBe(view(computeWorksheet(m)));
        cur = m;
      }
      void cur;
    }
  });

  it('resumes after an interrupted run', async () => {
    const ws = exampleWorksheet();
    const s = new ComputeSession();
    const it1 = s.run(ws);
    for (let i = 0; i < 10; i++) it1.next();       // interrupted after 10 regions
    const edited = { ...ws, regions: ws.regions.map((r, i) => (i === ws.regions.length - 1 && r.type === 'math' ? { ...r, src: r.src.replace('5', '7') } : r)) };
    const it2 = s.run(edited);
    let first = it2.next();
    expect(first.done).toBe(false);
    expect((first.value as { resumedAt: number }).resumedAt).toBeGreaterThanOrEqual(9);   // continues, does not start over
    while (!first.done) first = it2.next();
    expect(view(first.value)).toBe(view(computeWorksheet(edited)));
  });

  it('only recalculates what follows a change', () => {
    const ws = exampleWorksheet();
    const s = new ComputeSession();
    s.runToEnd(ws);
    const order = sortRegions(ws.regions);
    const lastMath = [...order].reverse().find(r => r.type === 'math') as MathRegion;
    const edited = { ...ws, regions: ws.regions.map(r => (r.id === lastMath.id ? { ...lastMath, src: 'root(z^3 - 2*z - 6, z) =' } : r)) };
    const it = s.run(edited);
    const p = it.next().value as { resumedAt: number; total: number };
    expect(p.resumedAt).toBe(order.indexOf(lastMath));
  });
});
