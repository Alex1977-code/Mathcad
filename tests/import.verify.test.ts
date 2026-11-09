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

describe('Befunde der Testagenten: Import-Robustheit', () => {
  const xmcd = (regions: string, enc = 'UTF-8') => `<?xml version="1.0" encoding="${enc}"?>
<worksheet version="3.0.3" xmlns="http://schemas.mathsoft.com/worksheet30" xmlns:ml="http://schemas.mathsoft.com/math30"><regions>${regions}</regions></worksheet>`;
  const region = (id: number, top: number, math: string) => `<region region-id="${id}" left="10" top="${top}" width="100" height="16"><math>${math}</math></region>`;
  const load = (s: string) => loadWorksheetFile('t.xmcd', new TextEncoder().encode(s));
  const srcs = (ws: Awaited<ReturnType<typeof load>>) => sortRegions(ws.regions).filter(r => r.type === 'math').map(r => (r as MathRegion).src);

  it('Programme mit Einzelanweisung als Rumpf (Mathcad 15)', async () => {
    const f = `<ml:define><ml:function><ml:id>f</ml:id><ml:boundVars><ml:id>n</ml:id></ml:boundVars></ml:function><ml:program>
      <ml:localDefine><ml:id>s</ml:id><ml:real>0</ml:real></ml:localDefine>
      <ml:for><ml:id>i</ml:id><ml:range><ml:real>1</ml:real><ml:id>n</ml:id></ml:range><ml:localDefine><ml:id>s</ml:id><ml:apply><ml:plus/><ml:id>s</ml:id><ml:id>i</ml:id></ml:apply></ml:localDefine></ml:for>
      <ml:id>s</ml:id></ml:program></ml:define>`;
    const ws = await load(xmcd(region(1, 10, f) + region(2, 60, '<ml:eval><ml:apply><ml:id>f</ml:id><ml:real>4</ml:real></ml:apply></ml:eval>')));
    const res = computeWorksheet(ws);
    const last = sortRegions(ws.regions).filter(r => r.type === 'math').pop()!;
    expect(res.results[last.id].resultText).toBe('10');
  });
  it('aufeinanderfolgende „if“ sind unabhängig, otherwise nur wenn keins zutraf', async () => {
    const add = (k: number) => `<ml:localDefine><ml:id>r</ml:id><ml:apply><ml:plus/><ml:id>r</ml:id><ml:real>${k}</ml:real></ml:apply></ml:localDefine>`;
    const cond = (k: number) => `<ml:apply><ml:greaterThan/><ml:id>x</ml:id><ml:real>${k}</ml:real></ml:apply>`;
    const f = `<ml:define><ml:function><ml:id>h</ml:id><ml:boundVars><ml:id>x</ml:id></ml:boundVars></ml:function><ml:program>
      <ml:localDefine><ml:id>r</ml:id><ml:real>0</ml:real></ml:localDefine>
      <ml:ifThen>${cond(0)}${add(1)}</ml:ifThen><ml:ifThen>${cond(5)}${add(10)}</ml:ifThen>
      <ml:otherwise><ml:localDefine><ml:id>r</ml:id><ml:real>100</ml:real></ml:localDefine></ml:otherwise>
      <ml:id>r</ml:id></ml:program></ml:define>`;
    const ev = (v: number, top: number) => region(top, top, `<ml:eval><ml:apply><ml:id>h</ml:id><ml:real>${v}</ml:real></ml:apply></ml:eval>`);
    const ws = await load(xmcd(region(1, 10, f) + ev(10, 100) + ev(-1, 140)));
    const res = computeWorksheet(ws);
    const m = sortRegions(ws.regions).filter(r => r.type === 'math');
    expect(res.results[m[1].id].resultText).toBe('11');
    expect(res.results[m[2].id].resultText).toBe('100');
  });
  it('kaputte Koordinaten, riesige Matrizen und Leerzeichen-Zahlen', async () => {
    const big = '<ml:define><ml:id>M</ml:id><ml:matrix rows="3000" cols="3000"><ml:real>1</ml:real></ml:matrix></ml:define>';
    const ws = await load(xmcd(region(1, 10, '<ml:define><ml:id>a</ml:id><ml:real>1</ml:real></ml:define>').replace('top="10"', 'top="1e400"') + region(2, 20, big)
      + '<region region-id="3" left="0" top="40" width="10" height="10"><text><p>x<sp count="999999999"/>y</p></text></region>'));
    for (const r of ws.regions) { expect(Number.isFinite(r.y)).toBe(true); expect(r.y).toBeLessThanOrEqual(1e6); }
    expect(ws.source?.warnings.join(' ')).toMatch(/Ungültige Matrix/);
    const t = ws.regions.find(r => r.type === 'text');
    expect(t && t.type === 'text' && t.html.length).toBeLessThan(5000);
  });
  it('Formaterkennung nach Inhalt und Kodierung', async () => {
    const s = xmcd(region(1, 10, '<ml:define><ml:id>ä</ml:id><ml:real>2</ml:real></ml:define>'), 'ISO-8859-1');
    const latin = Uint8Array.from(Array.from(s).map(c => c.charCodeAt(0)));
    expect(srcs(await loadWorksheetFile('t.mcdx', latin))).toEqual(['ä := 2']);
    const u16 = new Uint8Array(2 + s.length * 2); u16[0] = 0xff; u16[1] = 0xfe;
    for (let i = 0; i < s.length; i++) { u16[2 + 2 * i] = s.charCodeAt(i) & 0xff; u16[3 + 2 * i] = s.charCodeAt(i) >> 8; }
    expect(srcs(await loadWorksheetFile('t.xmcd', u16))).toEqual(['ä := 2']);
  });
});
