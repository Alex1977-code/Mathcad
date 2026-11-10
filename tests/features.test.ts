// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { emptyWorksheet, normalizeWorksheet, type Worksheet } from '../src/engine/model';
import { fillTemplate, pageVars, templateParts } from '../src/engine/pageinfo';
import { findMatches, replaceAll, replaceInRegion } from '../src/ui/findReplace';
import { buildDocx } from '../src/export/docx';

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
