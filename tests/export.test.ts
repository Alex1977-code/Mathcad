// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildDocx } from '../src/export/docx';
import { latexToOmml } from '../src/export/omml';
import { computeWorksheet } from '../src/engine/worksheet';
import { exampleWorksheet } from '../src/ui/examples';
import { composeLatex } from '../src/ui/regions/MathRegionView';
import { looksLikeFormula, regionsFromText } from '../src/ui/clipboard';

const wellFormed = (xml: string) => !new DOMParser().parseFromString(xml, 'application/xml').querySelector('parsererror');
const NS = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

describe('Word-Export', () => {
  it('LaTeX wird zu Office-Math (OMML)', () => {
    const o = (l: string) => latexToOmml(l);
    expect(o('\\frac{a}{b}')).toContain('<m:f><m:num>');
    expect(o('\\sqrt{x}')).toContain('<m:rad>');
    expect(o('\\sqrt[3]{x}')).toContain('<m:deg>');
    expect(o('x^{2}_{i}')).toContain('<m:sSubSup>');
    expect(o('\\begin{bmatrix}1 & 2 \\\\ 3 & 4\\end{bmatrix}')).toMatch(/<m:d>.*<m:m>.*<m:mr>.*<m:mr>/);
    expect(o('\\sum_{i=1}^{n} i')).toContain('<m:chr m:val="∑"/>');
    expect(o('\\int_{0}^{1} x\\,\\mathrm{d}x')).toContain('<m:chr m:val="∫"/>');
    expect(o('\\lim_{x\\to 0} f')).toContain('<m:limLow>');
    expect(o('97.7\\ \\mathrm{kN}')).toMatch(/<m:sty m:val="p"\/>.*kN/);
    expect(o('\\htmlClass{fw-result}{5}')).toContain('>5<');
    for (const l of ['\\left(\\frac{a}{b}\\right)^{2}', 'x \\xrightarrow{\\textsf{solve}} 4', '\\left|\\begin{array}{l}\\textbf{if}\\ x \\\\ y\\end{array}\\right.', 'a < b & c']) {
      expect(wellFormed(`<r ${NS}>${o(l)}</r>`), l).toBe(true);
    }
  });

  it('erzeugt ein gültiges DOCX-Paket mit Formeln, Text und Fußzeile', async () => {
    const ws = exampleWorksheet();
    const res = computeWorksheet(ws);
    const blob = await buildDocx(ws, { mathLatex: r => composeLatex(r.src, res.results[r.id]).latex, result: res });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    for (const f of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/footer1.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']) {
      const xml = await zip.file(f)!.async('string');
      expect(wellFormed(xml), f).toBe(true);
    }
    const doc = await zip.file('word/document.xml')!.async('string');
    expect((doc.match(/<m:oMath>/g) ?? []).length).toBeGreaterThan(20);
    expect(doc).toContain('Heading2');
    expect(doc).toContain('97.703');
    expect(await zip.file('word/footer1.xml')!.async('string')).toContain('NUMPAGES');
  });
});

describe('Einfügen aus anderen Programmen', () => {
  it('erkennt Formelzeilen und Fließtext', () => {
    expect(looksLikeFormula('q := 5 kN/m')).toBe(true);
    expect(looksLikeFormula('L ≔ 4 m')).toBe(true);
    expect(looksLikeFormula('q*L^2/8 =')).toBe(true);
    expect(looksLikeFormula('Bemessung des Trägers nach Eurocode')).toBe(false);
    expect(looksLikeFormula('Hallo')).toBe(false);
    const regs = regionsFromText('Nachweis der Durchbiegung\nw := 3 mm\n\nw*2 =', { x: 48, y: 100 });
    expect(regs.map(r => r.type)).toEqual(['text', 'math', 'math']);
    expect(regs.map(r => r.y)).toEqual([...regs.map(r => r.y)].sort((a, b) => a - b));
  });

  it('Datentabelle wird Word-Tabelle', async () => {
    const ws = exampleWorksheet();
    ws.regions = [{ id: 'tb', type: 'table', x: 48, y: 40, name: 'M', columns: [{ name: 't', unit: 's' }, { name: 'F' }], rows: [['0', '1,5'], ['2', '2.5']] }];
    const zip = await JSZip.loadAsync(await (await buildDocx(ws, { mathLatex: () => '' })).arrayBuffer());
    const doc = await zip.file('word/document.xml')!.async('string');
    expect(doc).toContain('<w:tbl>');
    expect(doc).toContain('t [s]');
    expect((doc.match(/<w:tr>/g) ?? []).length).toBe(3);
  });
});