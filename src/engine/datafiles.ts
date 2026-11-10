/**
 * Data files attached to the worksheet and Mathcad's functions to read them:
 *   READCSV("messung.csv")            delimited text (comma, semicolon or tab; decimal comma recognised)
 *   READPRN("daten.prn")              numbers separated by blanks
 *   READEXCEL("tabelle.xlsx" [, "Blatt1!A1:C20"])
 *   READFILE("datei", "delimited" | "fixed" | "excel" [, …])
 * Cells that are not numbers become strings; empty cells NaN (as in Mathcad Prime).
 */
import type { Matrix } from 'mathjs';
import type { DataFile } from './model';
import { CalcError, makeMatrix, type Val } from './values';

let files: DataFile[] = [];
export function setDataFiles(f: DataFile[] | undefined) { files = f ?? []; }

function find(name: Val, fn: string): DataFile {
  if (typeof name !== 'string') throw new CalcError(`${fn}: Dateiname als Text, z. B. ${fn}("messung.csv")`);
  const base = name.replace(/^.*[\\/]/, '').toLowerCase();
  const f = files.find(x => x.name.toLowerCase() === base);
  if (!f) throw new CalcError(`${fn}: Datei „${name}“ ist nicht angehängt – Einfügen → Datei einlesen`);
  return f;
}

/** Number from a cell text: 1.5, 1,5 (decimal comma), 1e-3, 1.234,5 / 1,234.5 thousand separators. */
export function cellValue(s: string, decimalComma: boolean): number | string {
  const t = s.trim();
  if (t === '') return NaN;
  let u = t.replace(/\s+/g, '');
  if (decimalComma) u = u.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  else u = u.replace(/,(?=\d{3}(\D|$))/g, '');
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(u)) return parseFloat(u);
  if (/^(nan|NaN|#N\/A)$/.test(u)) return NaN;
  return t;
}

/** Split delimited text into rows of cells (quotes respected). */
export function parseDelimited(text: string, delim?: string): (number | string)[][] {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const sample = lines.slice(0, 20).join('\n');
  const d = delim ?? (sample.includes('\t') ? '\t' : (sample.match(/;/g)?.length ?? 0) > (sample.match(/,/g)?.length ?? 0) / 2 ? ';' : ',');
  // a semicolon file usually comes from German Excel: decimal comma
  const decimalComma = d === ';' || (d === '\t' && /\d,\d/.test(sample) && !/\d\.\d/.test(sample));
  return lines.map(line => {
    const cells: string[] = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"' && cur.trim() === '') { q = true; cur = ''; }
      else if (c === d) { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    return cells.map(c => cellValue(c, decimalComma));
  });
}

function toMatrix(rows: (number | string | null)[][], fn: string): Matrix {
  const cols = Math.max(0, ...rows.map(r => r.length));
  if (!rows.length || !cols) throw new CalcError(`${fn}: die Datei enthält keine Daten`);
  return makeMatrix(rows.map(r => Array.from({ length: cols }, (_, j) => (r[j] === null || r[j] === undefined ? NaN : r[j]) as Val)));
}

/** "B2" → [row, col] (0-based). */
function cellRef(ref: string): [number, number] {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref.trim());
  if (!m) throw new CalcError(`READEXCEL: ungültiger Zellbezug „${ref}“`);
  const col = m[1].toUpperCase().split('').reduce((s, ch) => s * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return [parseInt(m[2], 10) - 1, col];
}

function readExcel(f: DataFile, range: Val | undefined): Matrix {
  if (f.kind !== 'xlsx' || !f.sheets?.length) {
    // a CSV handed to READEXCEL: read it as delimited text
    return toMatrix(parseDelimited(f.text ?? ''), 'READEXCEL');
  }
  let sheet = f.sheets[0], r0 = 0, c0 = 0, r1 = Infinity, c1 = Infinity;
  if (range !== undefined) {
    if (typeof range !== 'string') throw new CalcError('READEXCEL: Bereich als Text, z. B. "Tabelle1!A1:C20"');
    let spec = range;
    const bang = spec.lastIndexOf('!');
    if (bang >= 0) {
      const sn = spec.slice(0, bang).replace(/^'|'$/g, '');
      const s = f.sheets.find(x => x.name.toLowerCase() === sn.toLowerCase());
      if (!s) throw new CalcError(`READEXCEL: Blatt „${sn}“ nicht gefunden (vorhanden: ${f.sheets.map(x => x.name).join(', ')})`);
      sheet = s; spec = spec.slice(bang + 1);
    }
    if (spec.trim()) {
      const [a, b] = spec.split(':');
      [r0, c0] = cellRef(a);
      [r1, c1] = b ? cellRef(b) : [r0, c0];
    }
  }
  const rows = sheet.cells.slice(r0, r1 === Infinity ? undefined : r1 + 1).map(r => r.slice(c0, c1 === Infinity ? undefined : c1 + 1));
  // without a range: trailing empty rows/columns are dropped
  return toMatrix(rows, 'READEXCEL');
}

type Builtin = (args: Val[]) => Val;
const nargs = (fn: string, args: Val[], min: number, max: number) => {
  if (args.length < min || args.length > max) throw new CalcError(`${fn}: ${min === max ? min : `${min}–${max}`} Argument(e) erwartet`);
};

export const FILE_BUILTINS: Record<string, Builtin> = {
  READCSV: (args) => { nargs('READCSV', args, 1, 1); const f = find(args[0], 'READCSV'); return toMatrix(parseDelimited(f.text ?? csvOf(f)), 'READCSV'); },
  READPRN: (args) => {
    nargs('READPRN', args, 1, 1);
    const f = find(args[0], 'READPRN');
    const lines = (f.text ?? csvOf(f)).replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim() && !/^\s*[#;]/.test(l));
    return toMatrix(lines.map(l => l.trim().split(/[\s,;]+/).map(c => cellValue(c, false))), 'READPRN');
  },
  READEXCEL: (args) => { nargs('READEXCEL', args, 1, 2); return readExcel(find(args[0], 'READEXCEL'), args[1]); },
  READFILE: (args) => {
    nargs('READFILE', args, 1, 6);
    const f = find(args[0], 'READFILE');
    const type = typeof args[1] === 'string' ? args[1].toLowerCase() : 'delimited';
    if (type === 'excel') return readExcel(f, undefined);
    if (type === 'fixed') {
      const widths = args[2];
      if (!widths || typeof widths !== 'object') throw new CalcError('READFILE "fixed": Spaltenbreiten als Vektor angeben');
      const w = (widths as Matrix).toArray().flat() as number[];
      const lines = (f.text ?? '').replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim());
      return toMatrix(lines.map(l => { let p = 0; return w.map(n => { const c = l.slice(p, p + n); p += n; return cellValue(c, false); }); }), 'READFILE');
    }
    return toMatrix(parseDelimited(f.text ?? csvOf(f)), 'READFILE');
  },
};

/** First sheet of a workbook as CSV (for READCSV/READPRN on an Excel file). */
function csvOf(f: DataFile): string {
  return (f.sheets?.[0]?.cells ?? []).map(r => r.map(c => (c === null ? '' : String(c))).join(',')).join('\n');
}
