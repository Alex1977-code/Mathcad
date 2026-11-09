// @vitest-environment jsdom
/**
 * Verification of the Mathcad import: every imported file is recalculated with FormelWerk and each
 * result is compared with the value Mathcad stored in the file.
 *
 * Additional real-world files can be checked with:  MATHCAD_SAMPLES=/pfad/zu/dateien npm run verify:mathcad
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { verifyFile, listFiles, type FileReport } from './verifyutil';
import { loadWorksheetFile } from '../src/import';
import { computeWorksheet } from '../src/engine/worksheet';
import { sortRegions, type MathRegion } from '../src/engine/model';

const FIX = join(__dirname, 'fixtures', 'mathcad');

function writeReport(name: string, reports: FileReport[]) {
  const dir = join(__dirname, '..', 'test-results');
  mkdirSync(dir, { recursive: true });
  const lines = reports.map(r => `${r.file.padEnd(42)} ${String(r.match).padStart(4)}/${String(r.total).padEnd(4)} Bereiche=${r.regions} Formeln=${r.math} ${r.ms ?? ''} ms`);
  const m = reports.reduce((s, r) => s + r.match, 0), t = reports.reduce((s, r) => s + r.total, 0);
  lines.push(`GESAMT ${m}/${t} (${(100 * m / Math.max(t, 1)).toFixed(1)} %)`);
  for (const r of reports) for (const f of r.failures) lines.push(`  ✗ ${r.file}: ${f.src.replace(/\n/g, ' ⏎ ').slice(0, 100)} | Mathcad: ${f.expected} | FormelWerk: ${f.got}`);
  writeFileSync(join(dir, name), lines.join('\n'));
  return { m, t };
}

describe('Mathcad 11–15 (.xmcd)', () => {
  it('imports the handwritten sample and reproduces every stored result', async () => {
    const ws = await loadWorksheetFile('beispiel_mathcad15.xmcd', readFileSync(join(FIX, 'beispiel_mathcad15.xmcd')));
    expect(ws.settings.origin).toBe(0);
    const res = computeWorksheet(ws);
    const math = sortRegions(ws.regions).filter(r => r.type === 'math') as MathRegion[];
    const srcs = math.map(m => m.src);
    expect(srcs).toContain('a := 5 m');
    expect(srcs).toContain('b_Steg := 300 mm');
    expect(srcs).toContain('a*b_Steg = cm^2');
    expect(srcs).toContain('f(x) := x^2 + 1');
    expect(srcs).toContain('A := [1, 2; 3, 4]');
    expect(srcs).toContain('sum(j^2, j, 1, 10) =');
    expect(srcs.find(s => s.startsWith('g(x) :='))).toContain('if x < 0');
    const text = ws.regions.find(r => r.type === 'text');
    expect(text && text.type === 'text' && text.html).toContain('<b>Träger</b> &amp; Querschnitt');
    expect(res.verification).toEqual({ match: 7, mismatch: 0, total: 7 });
    expect(res.errorCount).toBe(0);
  });
});

describe('Mathcad Prime (.mcdx)', () => {
  it('reproduces the results stored by Mathcad Prime', { timeout: 300000 }, async () => {
    const reports: FileReport[] = [];
    for (const f of listFiles(join(FIX, 'prime'))) reports.push(await verifyFile(f));
    const { m, t } = writeReport('mathcad-prime-verifikation.txt', reports);
    expect(reports.length).toBeGreaterThanOrEqual(30);
    // files whose functions are fully supported must match completely
    for (const name of ['trig.mcdx', 'hyperbolic.mcdx', 'log-exp.mcdx', 'breaks-sets-logic.mcdx', 'RC_torsion.mcdx', 'range_sum.mcdx',
      'plain_concrete_cohesion.mcdx', 'Constants.mcdx', 'shrinkage.mcdx', 'solve_as_function.mcdx', 'sort.mcdx', 'NM_to_CT.mcdx',
      'Elastic_foundation_eq_line_spring.mcdx', 'RC_interface.mcdx', 'RC_col.mcdx', 'biaxial_bending.mcdx']) {
      const r = reports.find(x => x.file === name)!;
      expect(r, name).toBeDefined();
      expect(`${name}: ${r.match}/${r.total}`).toBe(`${name}: ${r.total}/${r.total}`);
    }
    // overall: at least 86 % of all stored results reproduced (rest: unsupported special functions, random numbers, external DLLs)
    expect(m / t).toBeGreaterThan(0.86);
  });

  it('additional sample files (optional, MATHCAD_SAMPLES)', { timeout: 600000 }, async () => {
    const dir = process.env.MATHCAD_SAMPLES;
    if (!dir) return;
    const reports: FileReport[] = [];
    for (const f of listFiles(dir)) {
      try { reports.push(await verifyFile(f)); } catch (e) { reports.push({ file: f + ' (Importfehler: ' + (e as Error).message + ')', regions: 0, math: 0, disabled: 0, errors: 0, match: 0, mismatch: 0, total: 0, warnings: [], failures: [] }); }
    }
    writeReport('mathcad-samples-verifikation.txt', reports);
  });
});
