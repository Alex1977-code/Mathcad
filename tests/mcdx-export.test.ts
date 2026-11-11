// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { buildMcdx } from '../src/export/mcdx';
import { computeWorksheet } from '../src/engine/worksheet';
import { emptyWorksheet, sortRegions, type Worksheet } from '../src/engine/model';
import { exampleWorksheet } from '../src/ui/examples';
import { loadWorksheetFile } from '../src/import';

const shown = (ws: Worksheet) => {
  const r = computeWorksheet(ws);
  return sortRegions(ws.regions).filter(x => x.type === 'math').map(x => r.results[x.id]).filter(x => x && (x.resultText !== undefined || x.error)).map(x => (x.error ? 'ERR ' + x.error.message : x.resultText));
};
const plots = (w: Worksheet) => w.regions.filter(x => x.type === 'plot').map(x => JSON.stringify((x as { traces: { x: string; y: string }[] }).traces.map(t => [t.x.replace(/\s+/g, ''), t.y.replace(/\s+/g, '')]))).sort();
const wellFormed = (xml: string) => !new DOMParser().parseFromString(xml.replace(/^﻿/, ''), 'application/xml').querySelector('parsererror');
async function roundTrip(ws: Worksheet) {
  const { blob, warnings } = await buildMcdx(ws);
  const buf = Buffer.from(await blob.arrayBuffer());
  return { back: await loadWorksheetFile('x.mcdx', buf), warnings, zip: await JSZip.loadAsync(buf) };
}
function sheet(lines: string[]): Worksheet {
  const ws = emptyWorksheet();
  ws.regions = lines.map((src, i) => ({ id: `r${i}`, type: 'math' as const, x: 48, y: 48 + i * 40, src }));
  return ws;
}

describe('Export nach Mathcad Prime (.mcdx)', () => {
  it('Rundlauf: gleiche Ergebnisse und Diagramme nach erneutem Import', { timeout: 300000 }, async () => {
    const list: [string, Worksheet][] = [['Beispiel', exampleWorksheet()]];
    for (const f of ['RC_torsion', 'matrices', 'solve_as_function', 'statistics', 'shrinkage', 'RC_col', 'trig', 'range_sum', 'breaks-sets-logic', 'Elastic_foundation_eq_line_spring']) {
      list.push([f, await loadWorksheetFile(f + '.mcdx', readFileSync(join(__dirname, 'fixtures/mathcad/prime', f + '.mcdx')))]);
    }
    for (const [name, ws] of list) {
      const { back, warnings, zip } = await roundTrip(ws);
      expect(shown(back), name).toEqual(shown(ws));
      expect(plots(back), name).toEqual(plots(ws));
      expect(warnings, name).toEqual([]);
      for (const f of Object.keys(zip.files).filter(f => /\.(xml|rels)$/.test(f))) expect(wellFormed(await zip.file(f)!.async('string')), `${name}: ${f}`).toBe(true);
    }
  });

  it('Solve-Block aus FormelWerk (Startwert, Given, Find) wird ein Prime-Solve-Block', async () => {
    const { back, zip } = await roundTrip(sheet(['a := 3', 'x := 1', 'Given', 'a*x + 1 == 10', 'x := Find(x) =']));
    const xml = await zip.file('mathcad/worksheet.xml')!.async('string');
    expect(xml).toMatch(/<solveblock><regions><region [^>]*solve-block-category="guess-value"/);
    expect(xml).toContain('solve-block-category="constraint"');
    expect(xml).toContain('solve-block-category="solver"');
    expect(xml).toContain('<ml:id labels="KEYWORD" algorithm="" xml:space="preserve">find</ml:id>');
    expect(shown(back)).toEqual(['3']);
  });

  it('Namen, Einheiten, Indizes und Programme in Mathcads Schreibweise', async () => {
    const { zip, back } = await roundTrip(sheet([
      'F_max := 12 kN', 'f(V) := V^2 + 1', 'f(3) =', 'g(n) :=\n  s ← 0\n  for i ∈ 0..n\n    s ← s + i\n  s', 'g(4) =', 'v := [1; 2; 3]', 'v[1] =', 'F_max*2 = kN',
    ]));
    const xml = await zip.file('mathcad/worksheet.xml')!.async('string');
    expect(xml).toContain('<pw:Subscript>max</pw:Subscript>');
    expect(xml).toContain('<ml:apply><ml:scale /><ml:real>12</ml:real><ml:id labels="UNIT" xml:space="preserve">kN</ml:id></ml:apply>');
    expect(xml).toContain('<ml:id labels="VARIABLE" xml:space="preserve">V</ml:id>');   // parameter named like the unit volt
    expect(xml).toContain('<ml:for>');
    expect(shown(back)).toEqual(['10', '10', '2', '24']);
  });

  it('symbolische Auswertung „→“ mit Schlüsselwort und Ergebnis als Prime-Symbolik', async () => {
    const ws = sheet(['x^2 + 2*x*x →', '(x + 1)^2 → expand', 'a*x + b == 0 → solve, x', 'x^2 + 1 → substitute, x = c + 1']);
    const result = computeWorksheet(ws);
    const { blob, warnings } = await buildMcdx(ws, { result });
    expect(warnings).toEqual([]);
    const buf = Buffer.from(await blob.arrayBuffer());
    const xml = await (await JSZip.loadAsync(buf)).file('mathcad/worksheet.xml')!.async('string');
    expect((xml.match(/<ml:symEval>/g) ?? []).length).toBe(4);
    expect(xml).toContain('<ml:command><ml:sequence><ml:id xml:space="preserve">solve</ml:id>');
    expect(xml).toContain('<ml:command><ml:id xml:space="preserve">expand</ml:id></ml:command>');
    expect(xml).toMatch(/<ml:symResult><ml:apply><ml:mult \/><ml:real>3<\/ml:real>/);
    // read back: FormelWerk formulas with keyword again, same symbolic results
    const back = await loadWorksheetFile('s.mcdx', buf);
    expect(sortRegions(back.regions).map(r => (r as { src: string }).src.replace(/[\s*]/g, ''))).toEqual(['x^2+2xx→', '(x+1)^2→expand', 'ax+b==0→solve,x', 'x^2+1→substitute,x=c+1']);
    const rb = computeWorksheet(back);
    expect(sortRegions(back.regions).map(r => rb.results[r.id].symbolicLatex)).toEqual(sortRegions(ws.regions).map(r => result.results[r.id].symbolicLatex));
  });

  it('leeres Diagramm, Kopf- und Fußzeile, Projekt und Bearbeiter', async () => {
    const ws = sheet(['a := 1']);
    ws.regions.push({ id: 'p', type: 'plot', x: 48, y: 120, w: 400, h: 260, traces: [{ x: 'x', y: '' }] });
    ws.settings.page = { project: 'Halle 3', author: 'A. Muster', header: ['Projekt Halle 3', '', 'Statik'], footer: ['', '', 'Seite {seite} von {seiten}'] };
    const { back, warnings, zip } = await roundTrip(ws);
    expect(warnings).toEqual([]);
    expect(await zip.file('mathcad/footer.xml')!.async('string')).toContain('<pageNumber template="Seite_@PageNo_von_@PagesTotal" />');
    expect(back.regions.filter(r => r.type === 'plot').length).toBe(1);
    expect(back.settings.page).toEqual(ws.settings.page);
  });

  it('liest Kopf- und Fußzeile echter Prime-Dateien', async () => {
    const ws = await loadWorksheetFile('header_footer.mcdx', readFileSync(join(__dirname, 'fixtures/mathcad/prime/header_footer.mcdx')));
    expect(ws.settings.page?.header?.[0]).toMatch(/Author: John Smith/);
    expect(ws.settings.page?.footer?.[2]).toBe('Page {seite} of {seiten}');
  });

  it('Datentabelle wird Matrix-Definition mit Spaltenvektoren', async () => {
    const ws = sheet(['mean(F) =']);
    ws.regions.unshift({ id: 'tb', type: 'table', x: 48, y: 0, name: 'M', columns: [{ name: 't', unit: 's' }, { name: 'F', unit: 'kN' }], rows: [['0', '1,5'], ['2', '2.5'], ['', '']] });
    const { back, warnings } = await roundTrip(ws);
    expect(warnings).toEqual([]);
    expect(shown(back)).toEqual(shown(ws));
    expect(shown(back)).toEqual(['2000 N']);
  });

  it('Schieberegler wird als Definition geschrieben', async () => {
    const ws = sheet(['F*2 = kN']);
    ws.regions.unshift({ id: 'sl', type: 'slider', x: 48, y: 0, name: 'F', min: 0, max: 20, step: 0.5, value: 12, unit: 'kN' });
    const { back, warnings } = await roundTrip(ws);
    expect(warnings).toEqual([]);
    expect(shown(back)).toEqual(['24']);
  });
});