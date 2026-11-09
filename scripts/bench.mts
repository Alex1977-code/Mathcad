/**
 * Benchmark of the calculation engine on the Mathcad Prime fixtures.
 *   npx tsx scripts/bench.mts
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { loadWorksheetFile } from '../src/import';
import { computeWorksheet, ComputeSession } from '../src/engine/worksheet';
import { exampleWorksheet } from '../src/ui/examples';
import { sortRegions, type MathRegion, type Worksheet } from '../src/engine/model';

(globalThis as unknown as { DOMParser: unknown }).DOMParser = new JSDOM().window.DOMParser;
const files = (process.argv[2] ?? 'RC_col,matrices,probability,statistics,biaxial_bending,seed,Xsection_solver').split(',');
const sheets: [string, Worksheet][] = [['Beispiel', exampleWorksheet()]];
for (const f of files) sheets.push([f, await loadWorksheetFile(f + '.mcdx', readFileSync(`tests/fixtures/mathcad/prime/${f}.mcdx`))]);

let total = 0;
console.log('Blatt'.padEnd(22), 'voll'.padStart(9), '  Änderung am Ende (inkrementell)');
for (const [name, ws] of sheets) {
  let t = performance.now();
  const r = computeWorksheet(ws);
  const full = performance.now() - t;
  total += full;
  // incremental: edit the last formula
  const s = new ComputeSession();
  s.runToEnd(ws);
  const last = [...sortRegions(ws.regions)].reverse().find(x => x.type === 'math') as MathRegion | undefined;
  let inc = 0;
  if (last) {
    const edited = { ...ws, regions: ws.regions.map(x => (x.id === last.id ? { ...last, src: last.src + ' ' } : x)) };
    t = performance.now();
    s.runToEnd(edited);
    inc = performance.now() - t;
  }
  console.log(name.padEnd(22), `${full.toFixed(0)} ms`.padStart(9), `  ${inc.toFixed(1)} ms`, r.verification ? `  (Abgleich ${r.verification.match}/${r.verification.total})` : '');
}
console.log('Summe'.padEnd(22), `${total.toFixed(0)} ms`.padStart(9));
