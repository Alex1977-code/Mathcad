// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeWorksheet, type RegionResult } from '../src/engine/worksheet';
import { emptyWorksheet, normalizeWorksheet, type DataFile, type Region, type Worksheet } from '../src/engine/model';
import { parseDelimited } from '../src/engine/datafiles';
import { readXlsx } from '../src/import/xlsx';

function sheet(lines: (string | Region)[], files?: DataFile[]): Worksheet {
  const ws = emptyWorksheet();
  ws.regions = lines.map((src, i) => (typeof src === 'string' ? { id: `r${i}`, type: 'math' as const, x: 0, y: i * 20, src } : { ...src, id: `r${i}`, y: i * 20 }));
  if (files) ws.files = files;
  return ws;
}
function run(lines: (string | Region)[], files?: DataFile[]): RegionResult[] {
  const ws = sheet(lines, files);
  const res = computeWorksheet(ws);
  return lines.map((_, i) => res.results[`r${i}`]);
}
const txt = (r: RegionResult) => r.error ? 'ERROR: ' + r.error.message : r.resultText;

describe('Daten einlesen', () => {
  it('CSV: Komma, Semikolon mit Dezimalkomma, Tabulator, Anführungszeichen', () => {
    expect(parseDelimited('x,y\n1,2.5\n2,3e2')).toEqual([['x', 'y'], [1, 2.5], [2, 300]]);
    expect(parseDelimited('Zeit;Kraft\n0,5;1.250,75\n1;2')).toEqual([['Zeit', 'Kraft'], [0.5, 1250.75], [1, 2]]);
    expect(parseDelimited('a\tb\n1,5\t2,25')).toEqual([['a', 'b'], [1.5, 2.25]]);
    expect(parseDelimited('"Name, lang",2\n"Sie sagte ""ja""",3')).toEqual([['Name, lang', 2], ['Sie sagte "ja"', 3]]);
    const empty = parseDelimited('1,,3');
    expect(empty[0][0]).toBe(1); expect(Number.isNaN(empty[0][1])).toBe(true);
  });

  it('READCSV / READPRN aus angehängten Dateien', () => {
    const files: DataFile[] = [{ name: 'messung.csv', kind: 'text', text: 't;s\n0;0\n1;4,9\n2;19,6' }, { name: 'werte.prn', kind: 'text', text: '# Kommentar\n1 2 3\n4 5 6\n' }];
    const r = run(['M := READCSV("messung.csv")', 'M[3, 1] =', 'rows(M) =', 'P := READPRN("C:\\\\Daten\\\\werte.prn")', 'sum(P) =', 'READCSV("fehlt.csv") ='], files);
    expect(txt(r[1])).toBe('19.6');
    expect(txt(r[2])).toBe('4');
    expect(txt(r[4])).toBe('21');
    expect(txt(r[5])).toMatch(/nicht angehängt/);
  });

  it('Excel (.xlsx aus LibreOffice): Blätter, Bereiche, Text und Zahlen', async () => {
    const f = await readXlsx('messung.xlsx', readFileSync(join(__dirname, 'fixtures/data/messung.xlsx')));
    expect(f.sheets!.map(s => s.name)).toEqual(['Messung', 'Zweites Blatt']);
    const r = run([
      'D := READEXCEL("messung.xlsx")', 'D[0, 1] =', 'D[5, 1] =',
      'W := READEXCEL("messung.xlsx", "B2:B6")', 'sum(W) =',
      'Z := READEXCEL("messung.xlsx", "\'Zweites Blatt\'!A2:B3")', 'Z =',
      'READEXCEL("messung.xlsx", "Drittes!A1") =',
    ], [f]);
    expect(txt(r[1])).toBe('"Weg"');
    expect(txt(r[2])).toBe('20');
    expect(txt(r[4])).toBe('37.5');
    expect(txt(r[6])).toBe('[1, 2; 3, 4]');
    expect(txt(r[7])).toMatch(/Blatt „Drittes“ nicht gefunden/);
    // the parsed workbook survives saving and loading
    const ws = normalizeWorksheet(JSON.parse(JSON.stringify(sheet(['x := 1'], [f]))));
    expect(ws.files![0].sheets![1].cells).toEqual([['a', 'b'], [1, 2], [3, 4]]);
  });

  it('Datentabelle: Matrix, Spaltenvektoren, Einheiten je Spalte, Dezimalkomma', () => {
    const table: Region = { id: 't', type: 'table', x: 0, y: 0, name: 'Messung', columns: [{ name: 't', unit: 's' }, { name: 'F', unit: 'kN' }, { name: 'Bem' }], rows: [['0', '1,5', 'a'], ['2', '2.5', 'b'], ['4', '4', ''], ['', '', '']] };
    const r = run([table, 'F[1] =', 'rows(Messung) =', 'mean(F) = kN', 'Bem[0] =', 'slope(t, F) = kN/s']);
    expect(txt(r[0])).toBe('3×3');
    expect(txt(r[1])).toBe('2500 N');
    expect(txt(r[2])).toBe('3');
    expect(txt(r[3])).toBe('2.667');
    expect(txt(r[4])).toBe('"a"');
    expect(txt(r[5])).toBe('0.625');
  });
});
