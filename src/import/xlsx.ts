/**
 * Minimal reader for Excel workbooks (.xlsx): sheet names and cell values (numbers, texts, booleans,
 * cached results of formulas). Formatting, charts and formulas themselves are ignored.
 */
import JSZip from 'jszip';
import type { DataFile } from '../engine/model';
import { defaultXmlParser, type XmlParser } from './common';

const strip = (s: string) => s.replace(/^﻿/, '');
const byTag = (d: Document | Element, tag: string) => Array.from(d.getElementsByTagName('*')).filter(e => e.localName === tag);

/** "C12" → [row, col] (0-based). */
function ref(r: string): [number, number] {
  const m = /^([A-Z]+)(\d+)$/.exec(r);
  if (!m) return [-1, -1];
  return [parseInt(m[2], 10) - 1, m[1].split('').reduce((s, ch) => s * 26 + ch.charCodeAt(0) - 64, 0) - 1];
}

export async function readXlsx(name: string, data: ArrayBuffer | Uint8Array, parseXml: XmlParser = defaultXmlParser): Promise<DataFile> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(data); } catch { throw new Error(`„${name}“ ist keine Excel-Datei (.xlsx). Ältere .xls-Dateien bitte in Excel als .xlsx oder .csv speichern.`); }
  const wb = zip.file('xl/workbook.xml');
  if (!wb) throw new Error(`„${name}“: keine Excel-Arbeitsmappe`);
  const wdoc = parseXml(strip(await wb.async('string')));
  const relsF = zip.file('xl/_rels/workbook.xml.rels');
  const rels = new Map<string, string>();
  if (relsF) for (const r of byTag(parseXml(strip(await relsF.async('string'))), 'Relationship')) rels.set(r.getAttribute('Id') ?? '', r.getAttribute('Target') ?? '');
  const shared: string[] = [];
  const ss = zip.file('xl/sharedStrings.xml');
  if (ss) for (const si of byTag(parseXml(strip(await ss.async('string'))), 'si')) shared.push(byTag(si, 't').map(t => t.textContent ?? '').join(''));
  const sheets: NonNullable<DataFile['sheets']> = [];
  for (const sh of byTag(wdoc, 'sheet').slice(0, 50)) {
    const rid = Array.from(sh.attributes).find(a => a.localName === 'id')?.value ?? '';
    let target = rels.get(rid) ?? '';
    target = target.replace(/^\//, '');
    if (!target.startsWith('xl/')) target = 'xl/' + target;
    const f = zip.file(target);
    if (!f) continue;
    const sdoc = parseXml(strip(await f.async('string')));
    const cells: (number | string | null)[][] = [];
    for (const c of byTag(sdoc, 'c')) {
      const [r, k] = ref(c.getAttribute('r') ?? '');
      if (r < 0 || r > 1e5 || k > 2000) continue;
      const t = c.getAttribute('t');
      const v = byTag(c, 'v')[0]?.textContent ?? '';
      let val: number | string | null = null;
      if (t === 's') val = shared[parseInt(v, 10)] ?? '';
      else if (t === 'inlineStr') val = byTag(c, 't').map(x => x.textContent ?? '').join('');
      else if (t === 'str') val = v;
      else if (t === 'b') val = v === '1' ? 1 : 0;
      else if (t === 'e') val = null;
      else if (v !== '') { const n = parseFloat(v); val = Number.isFinite(n) ? n : v; }
      while (cells.length <= r) cells.push([]);
      const row = cells[r];
      while (row.length < k) row.push(null);
      row[k] = val;
    }
    sheets.push({ name: sh.getAttribute('name') ?? `Tabelle${sheets.length + 1}`, cells });
  }
  if (!sheets.length) throw new Error(`„${name}“: keine Tabellenblätter gefunden`);
  return { name, kind: 'xlsx', sheets };
}
