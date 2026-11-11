// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { emptyWorksheet, normalizeWorksheet, type Worksheet } from '../src/engine/model';
import { fillTemplate, pageVars, templateParts } from '../src/engine/pageinfo';
import { findMatches, replaceAll, replaceInRegion } from '../src/ui/findReplace';
import { buildDocx } from '../src/export/docx';
import { computeWorksheet } from '../src/engine/worksheet';
import { sliderFromDefinition } from '../src/ui/smart';

function sheet(): Worksheet {
  const ws = emptyWorksheet();
  ws.title = 'Träger';
  ws.regions = [
    { id: 't', type: 'text', x: 48, y: 20, w: 300, html: '<b>Last</b> auf dem Träger: <i>Last</i>fall 1' },
    { id: 'a', type: 'math', x: 48, y: 60, src: 'Last := 5 kN' },
    { id: 'b', type: 'math', x: 48, y: 100, src: 'M := Last*L/4 =' },
    { id: 'c', type: 'math', x: 48, y: 140, src: 'Lasten := 2*Last' },
  ];
  return ws;
}

describe('Suchen und Ersetzen', () => {
  it('findet in Formeln und Texten in Lesereihenfolge', () => {
    const m = findMatches(sheet(), 'last');
    expect(m.map(x => x.regionId)).toEqual(['t', 't', 'a', 'b', 'c', 'c']);
    expect(findMatches(sheet(), 'last', { caseSensitive: true })).toEqual([]);
    expect(findMatches(sheet(), 'Last', { wholeWord: true }).map(x => x.regionId)).toEqual(['t', 'a', 'b', 'c']);
  });
  it('ersetzt alle oder einen Treffer, Formatierung bleibt', () => {
    const { ws, count } = replaceAll(sheet(), 'Last', 'F', { wholeWord: true, caseSensitive: true });
    expect(count).toBe(4);
    expect((ws.regions[1] as { src: string }).src).toBe('F := 5 kN');
    expect((ws.regions[3] as { src: string }).src).toBe('Lasten := 2*F');
    expect((ws.regions[0] as { html: string }).html).toBe('<b>F</b> auf dem Träger: <i>Last</i>fall 1');
    const one = replaceInRegion(sheet().regions[3], 'Last', 'Q', {}, 12);
    expect(one.count).toBe(1);
    expect((one.region as { src: string }).src).toBe('Lasten := 2*Q');
    // regex characters are searched literally
    expect(findMatches(sheet(), 'L/4').length).toBe(1);
    expect(findMatches(sheet(), '.*').length).toBe(0);
  });
});

describe('Kopf- und Fußzeile', () => {
  it('füllt Platzhalter und bleibt beim Laden erhalten', () => {
    const ws = sheet();
    ws.settings.page = { project: 'Halle 3', author: 'A. Muster', header: ['{projekt}', '{titel}', '{bearbeiter}'], footer: ['{datum}', '', 'Seite {seite}/{seiten}'] };
    const v = pageVars(ws, 'traeger.fwk', new Date(2026, 10, 10));
    expect(fillTemplate('{projekt} – {titel} ({datei})', v, 1, 2)).toBe('Halle 3 – Träger (traeger.fwk)');
    expect(fillTemplate('Seite {seite} von {seiten}', v, 2, 5)).toBe('Seite 2 von 5');
    expect(templateParts('S. {seite}/{seiten}', v)).toEqual([{ text: 'S. ' }, { field: 'PAGE' }, { text: '/' }, { field: 'NUMPAGES' }]);
    expect(fillTemplate('{datum}', v, 1, 1)).toBe('10.11.2026');
    const back = normalizeWorksheet(JSON.parse(JSON.stringify(ws)));
    expect(back.settings.page).toEqual(ws.settings.page);
  });
  it('Word erhält Kopf- und Fußzeile mit Seitenfeldern', async () => {
    const ws = sheet();
    ws.settings.page = { project: 'Halle 3', header: ['{projekt}', '', ''], footer: ['', 'Seite {seite} von {seiten}', ''] };
    const zip = await JSZip.loadAsync(await (await buildDocx(ws, { mathLatex: r => r.src })).arrayBuffer());
    const hdr = await zip.file('word/header1.xml')!.async('string');
    const ftr = await zip.file('word/footer1.xml')!.async('string');
    expect(hdr).toContain('Halle 3');
    expect(ftr).toMatch(/PAGE.*NUMPAGES/s);
    expect(await zip.file('word/document.xml')!.async('string')).toContain('headerReference');
  });
});

describe('Schieberegler', () => {
  it('definiert die Variable mit Einheit; Änderungen rechnen nach', () => {
    const ws = emptyWorksheet();
    ws.regions = [
      { id: 's', type: 'slider', x: 48, y: 0, name: 'F', min: 0, max: 20, step: 0.5, value: 12, unit: 'kN' },
      { id: 'm', type: 'math', x: 48, y: 40, src: 'F*2 m = kN*m' },
    ];
    expect(computeWorksheet(ws).results.m.resultText).toBe('24');
    const ws2 = { ...ws, regions: [{ ...ws.regions[0], value: 7.5 } as typeof ws.regions[0], ws.regions[1]] };
    expect(computeWorksheet(ws2).results.m.resultText).toBe('15');
    const bad = { ...ws, regions: [{ ...ws.regions[0], unit: 'kN*(' } as typeof ws.regions[0], ws.regions[1]] };
    expect(computeWorksheet(bad).results.s.error).toBeTruthy();
  });
  it('bleibt beim Speichern erhalten und wird begrenzt', () => {
    const ws = emptyWorksheet();
    ws.regions = [{ id: 's', type: 'slider', x: 0, y: 0, name: 'a', min: 10, max: 0, step: 0, value: 99 }];
    const back = normalizeWorksheet(JSON.parse(JSON.stringify(ws)));
    expect(back.regions[0]).toMatchObject({ type: 'slider', name: 'a', min: 0, max: 10, value: 10, step: 0.1 });
  });
  it('erkennt Zahl-Definitionen zum Umwandeln', () => {
    expect(sliderFromDefinition('F := 12 kN')).toEqual({ name: 'F', value: 12, unit: 'kN' });
    expect(sliderFromDefinition('n := 4')).toEqual({ name: 'n', value: 4 });
    expect(sliderFromDefinition('t := -2.5 m/s')).toEqual({ name: 't', value: -2.5, unit: 'm/s' });
    expect(sliderFromDefinition('a := b*2')).toBeNull();
    expect(sliderFromDefinition('f(x) := 2')).toBeNull();
    expect(sliderFromDefinition('x := 3 =')).toBeNull();
  });
  it('wird in Word als Definition geschrieben', async () => {
    const ws = emptyWorksheet();
    ws.regions = [{ id: 's', type: 'slider', x: 48, y: 0, name: 'F', min: 0, max: 20, step: 0.5, value: 12, unit: 'kN' }];
    const zip = await JSZip.loadAsync(await (await buildDocx(ws, { mathLatex: r => r.src })).arrayBuffer());
    expect(await zip.file('word/document.xml')!.async('string')).toMatch(/<m:oMath>.*>F<.*>12<.*>k<.*>N</s);
  });
});