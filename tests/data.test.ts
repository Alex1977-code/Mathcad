// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeWorksheet, type RegionResult } from '../src/engine/worksheet';
import { emptyWorksheet, normalizeWorksheet, type DataFile, type Region, type Worksheet } from '../src/engine/model';
import { parseDelimited } from '../src/engine/datafiles';
import { readXlsx } from '../src/import/xlsx';
import { readXls } from '../src/import/xls';
import { buildXlsx } from '../src/export/xlsxWrite';

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

  it('altes Excel-Format .xls (aus LibreOffice): Zahlen, Texte, Formelwerte, mehrere Blätter, lange Texttabelle', () => {
    const f = readXls('alt.xls', readFileSync(join(__dirname, 'fixtures/data/alt.xls')));
    expect(f.sheets!.map(s => s.name)).toEqual(['Messung', 'Zweites Blatt', 'Viele']);
    const m = f.sheets![0].cells;
    expect(m[0]).toEqual(['Zeit', 'Weg', 'Kommentar']);
    expect(m[3]).toEqual([1, 5, 'Größe µ']);
    expect(m[6][0]).toBe('Summe');
    expect(m[6][1]).toBe(37.5);                      // cached result of =SUM(B2:B6)
    expect(m[7].slice(0, 3)).toEqual([1234567.891, -3, 0.07]);
    expect(f.sheets![1].cells).toEqual([['a', 'b'], [1, 2], [3, 4]]);
    const v = f.sheets![2].cells;
    expect(v.length).toBe(900);
    for (const i of [0, 1, 137, 450, 899]) expect(v[i]).toEqual([`Text Nummer ${i} – ${'äöü ß '.repeat(6)}Ende${i}`, i * 1.5, `kurz${i}`]);
    const r = run(['D := READEXCEL("alt.xls", "Messung!B2:B6")', 'sum(D) =', 'READEXCEL("alt.xls", "Viele!B900") ='], [f]);
    expect(txt(r[1])).toBe('37.5');
    expect(txt(r[2])).toBe('1348.5');
    expect(() => readXls('x.xls', new Uint8Array(600))).toThrow(/keine Excel-97-2003-Datei/);
  });

  it('Schreiben: WRITEPRN, APPENDPRN, WRITECSV, WRITEEXCEL – Ausgabedateien und Wiedereinlesen', async () => {
    const ws = sheet([
      'M := [1, 2.5; 3, 4]', 'WRITEPRN("out.prn", M)', 'APPENDPRN("out.prn", [5, 6])', 'P := READPRN("out.prn")', 'P[2, 1] =',
      'WRITECSV("werte.csv", [1.5 m, "a,b"; 2 km, "c"])', 'READCSV("werte.csv")[1, 0] =',
      'x := WRITEEXCEL("erg.xlsx", M, "Daten!B2")', 'READEXCEL("erg.xlsx", "Daten!C3") =',
      'WRITEPRN("alt.prn") := M*2', 'READPRN("alt.prn")[1, 1] =',
    ]);
    const res = computeWorksheet(ws);
    const t = (i: number) => txt(res.results[`r${i}`]);
    expect(Object.values(res.results).filter(r => r.error).map(r => r.error!.message)).toEqual([]);
    expect(t(4)).toBe('6');
    expect(t(6)).toBe('2000');
    expect(t(8)).toBe('4');
    expect(t(10)).toBe('8');
    const out = new Map(res.outputs!.map(f => [f.name, f]));
    expect([...out.keys()].sort()).toEqual(['alt.prn', 'erg.xlsx', 'out.prn', 'werte.csv']);
    expect(out.get('out.prn')!.text).toBe('1 2.5\n3 4\n5 6\n');
    expect(out.get('werte.csv')!.text).toBe('1.5,"a,b"\n2000,c\n');
    // the workbook is a real .xlsx: read back with the own reader
    const blob = await buildXlsx(out.get('erg.xlsx')!.sheets!);
    const back = await readXlsx('erg.xlsx', await blob.arrayBuffer());
    expect(back.sheets![0].name).toBe('Daten');
    expect(back.sheets![0].cells).toEqual([[], [null, 1, 2.5], [null, 3, 4]]);
  });
});