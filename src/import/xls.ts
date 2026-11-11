/**
 * Reader for old Excel workbooks (.xls, Excel 97–2003, BIFF8 in an OLE2 compound file; BIFF5 texts as
 * Latin-1): sheet names and cell values (numbers, texts, booleans, cached results of formulas).
 */
import type { DataFile } from '../engine/model';

class XlsError extends Error {}

/* ------------------------------ compound file ------------------------------ */

function readStream(buf: Uint8Array, wanted: string[]): Uint8Array {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (buf.length < 512 || sig.some((b, i) => buf[i] !== b)) throw new XlsError('keine Excel-97-2003-Datei (.xls)');
  const ss = 1 << dv.getUint16(0x1e, true), mss = 1 << dv.getUint16(0x20, true);
  const nFat = dv.getUint32(0x2c, true), dirStart = dv.getUint32(0x30, true), cutoff = dv.getUint32(0x38, true);
  const miniFatStart = dv.getUint32(0x3c, true), difatStart = dv.getUint32(0x44, true), nDifat = dv.getUint32(0x48, true);
  const off = (sec: number) => (sec + 1) * ss;
  const END = 0xfffffffe;
  // DIFAT: 109 entries in the header, the rest in a chain of sectors
  const difat: number[] = [];
  for (let i = 0; i < 109; i++) difat.push(dv.getUint32(0x4c + 4 * i, true));
  for (let s = difatStart, n = 0; s < END && n < nDifat && off(s) + ss <= buf.length; n++) {
    for (let i = 0; i < ss / 4 - 1; i++) difat.push(dv.getUint32(off(s) + 4 * i, true));
    s = dv.getUint32(off(s) + ss - 4, true);
  }
  const fat: number[] = [];
  for (const s of difat.slice(0, Math.max(nFat, 0))) {
    if (s >= END || off(s) + ss > buf.length) continue;
    for (let i = 0; i < ss / 4; i++) fat.push(dv.getUint32(off(s) + 4 * i, true));
  }
  const chain = (start: number, table: number[], limit = 1e6): number[] => {
    const out: number[] = [];
    for (let s = start; s < END && s < table.length && out.length < limit; s = table[s]) out.push(s);
    return out;
  };
  const cat = (secs: number[], size: number, at: (s: number) => number, src: Uint8Array) => {
    const out = new Uint8Array(secs.length * size);
    secs.forEach((s, i) => { const o = at(s); if (o + size <= src.length) out.set(src.subarray(o, o + size), i * size); });
    return out;
  };
  const dir = cat(chain(dirStart, fat), ss, off, buf);
  const dd = new DataView(dir.buffer);
  const entries: { name: string; type: number; start: number; size: number }[] = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const len = Math.max(0, Math.min(64, dd.getUint16(o + 0x40, true)) - 2);
    let name = '';
    for (let i = 0; i < len; i += 2) name += String.fromCharCode(dd.getUint16(o + i, true));
    entries.push({ name, type: dir[o + 0x42], start: dd.getUint32(o + 0x74, true), size: dd.getUint32(o + 0x78, true) });
  }
  const root = entries.find(e => e.type === 5);
  const e = wanted.map(w => entries.find(x => x.type === 2 && x.name.toLowerCase() === w.toLowerCase())).find(Boolean);
  if (!e) throw new XlsError('keine Arbeitsmappe in der Datei gefunden');
  if (e.size < cutoff && root) {
    const mini = cat(chain(root.start, fat), ss, off, buf);
    const mfSecs = cat(chain(miniFatStart, fat), ss, off, buf);
    const mdv = new DataView(mfSecs.buffer);
    const miniFat: number[] = [];
    for (let i = 0; i + 4 <= mfSecs.length; i += 4) miniFat.push(mdv.getUint32(i, true));
    return cat(chain(e.start, miniFat), mss, s => s * mss, mini).subarray(0, e.size);
  }
  return cat(chain(e.start, fat), ss, off, buf).subarray(0, e.size);
}

/* ---------------------------------- BIFF ----------------------------------- */

interface Rec { id: number; data: Uint8Array; pos: number }

function records(wb: Uint8Array): Rec[] {
  const out: Rec[] = [];
  const dv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);
  for (let p = 0; p + 4 <= wb.length;) {
    const id = dv.getUint16(p, true), len = dv.getUint16(p + 2, true);
    if (p + 4 + len > wb.length) break;
    out.push({ id, data: wb.subarray(p + 4, p + 4 + len), pos: p });
    p += 4 + len;
  }
  return out;
}

const latin1 = (b: Uint8Array) => Array.from(b, c => String.fromCharCode(c)).join('');
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const f64 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0, true);

function rk(v: number): number {
  let x: number;
  if (v & 2) x = (v | 0) >> 2;
  else { const d = new DataView(new ArrayBuffer(8)); d.setUint32(4, v & 0xfffffffc, true); x = d.getFloat64(0, true); }
  return v & 1 ? x / 100 : x;
}

/** Unicode string at o: flags byte, then 8- or 16-bit characters. */
function ustr(b: Uint8Array, o: number, cch: number): string {
  const wide = b[o] & 1;
  let s = '';
  for (let i = 0; i < cch; i++) s += String.fromCharCode(wide ? u16(b, o + 1 + 2 * i) : b[o + 1 + i]);
  return s;
}

/** Shared string table: strings may continue in CONTINUE records (with a new flags byte for the characters). */
function readSst(chunks: Uint8Array[]): string[] {
  let ci = 0, p = 8;
  const out: string[] = [];
  const total = u32(chunks[0], 4);
  const avail = () => chunks[ci].length - p;
  const next = () => { ci++; p = 0; return ci < chunks.length; };
  const skip = (n: number) => { while (n > 0) { if (avail() <= 0 && !next()) return; const k = Math.min(n, avail()); p += k; n -= k; } };
  while (out.length < total) {
    if (avail() <= 0 && !next()) break;
    if (avail() < 3) { if (!next()) break; }
    const c = chunks[ci];
    let cch = u16(c, p);
    const flags = c[p + 2];
    p += 3;
    let wide = flags & 1;
    const runs = flags & 8 ? u16(chunks[ci], p) : 0; if (flags & 8) p += 2;
    const ext = flags & 4 ? u32(chunks[ci], p) : 0; if (flags & 4) p += 4;
    let s = '';
    while (cch > 0) {
      if (avail() <= 0) { if (!next()) break; wide = chunks[ci][p] & 1; p += 1; }
      const cur = chunks[ci];
      const n = Math.min(cch, Math.floor(avail() / (wide ? 2 : 1)));
      if (n <= 0) { p = cur.length; continue; }
      for (let i = 0; i < n; i++) s += String.fromCharCode(wide ? u16(cur, p + 2 * i) : cur[p + i]);
      p += n * (wide ? 2 : 1);
      cch -= n;
    }
    skip(4 * runs + ext);
    out.push(s);
  }
  return out;
}

export function readXls(name: string, data: ArrayBuffer | Uint8Array): DataFile {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  let wb: Uint8Array;
  try { wb = readStream(buf, ['Workbook', 'Book']); } catch (e) { throw new Error(`„${name}“: ${(e as Error).message}`); }
  const recs = records(wb);
  if (!recs.length || recs[0].id !== 0x0809) throw new Error(`„${name}“: keine Excel-Arbeitsmappe`);
  const biff8 = u16(recs[0].data, 0) >= 0x0600;
  if (recs.some(r => r.id === 0x002f)) throw new Error(`„${name}“ ist kennwortgeschützt und kann nicht gelesen werden`);
  let sst: string[] = [];
  const bounds: { pos: number; name: string; type: number }[] = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.id === 0x00fc) {
      const chunks = [r.data];
      while (recs[i + 1]?.id === 0x003c) chunks.push(recs[++i].data);
      sst = readSst(chunks);
    } else if (r.id === 0x0085) {
      const cch = r.data[6];
      bounds.push({ pos: u32(r.data, 0), type: r.data[5], name: biff8 ? ustr(r.data, 7, cch) : latin1(r.data.subarray(7, 7 + cch)) });
    } else if (r.id === 0x000a) break;
  }
  const byPos = new Map(recs.map((r, i) => [r.pos, i]));
  const sheets: NonNullable<DataFile['sheets']> = [];
  for (const b of bounds) {
    if (b.type !== 0) continue;   // charts, macro sheets
    const start = byPos.get(b.pos);
    if (start === undefined) continue;
    const cells: (number | string | null)[][] = [];
    const put = (r: number, c: number, v: number | string | null) => {
      if (r > 1e5 || c > 2000) return;
      while (cells.length <= r) cells.push([]);
      const row = cells[r];
      while (row.length < c) row.push(null);
      row[c] = v;
    };
    let pending: [number, number] | null = null;
    for (let i = start + 1; i < recs.length; i++) {
      const { id, data: d } = recs[i];
      if (id === 0x000a) break;
      if (id === 0x0809) { // embedded substream (chart): skip to its EOF
        while (i < recs.length && recs[i].id !== 0x000a) i++;
        continue;
      }
      switch (id) {
        case 0x00fd: put(u16(d, 0), u16(d, 2), sst[u32(d, 6)] ?? ''); break;                       // LABELSST
        case 0x0203: put(u16(d, 0), u16(d, 2), f64(d, 6)); break;                                  // NUMBER
        case 0x027e: put(u16(d, 0), u16(d, 2), rk(u32(d, 6))); break;                              // RK
        case 0x00bd: {                                                                             // MULRK
          const row = u16(d, 0), c0 = u16(d, 2);
          for (let o = 4, c = c0; o + 6 <= d.length - 2; o += 6, c++) put(row, c, rk(u32(d, o + 2)));
          break;
        }
        case 0x0204: case 0x00d6: {                                                                // LABEL, RSTRING
          const cch = u16(d, 6);
          put(u16(d, 0), u16(d, 2), biff8 ? ustr(d, 8, cch) : latin1(d.subarray(8, 8 + cch)));
          break;
        }
        case 0x0205: put(u16(d, 0), u16(d, 2), d[7] ? null : d[6]); break;                         // BOOLERR
        case 0x0006: case 0x0206: case 0x0406: {                                                   // FORMULA: cached result
          const row = u16(d, 0), col = u16(d, 2);
          if (d[12] === 0xff && d[13] === 0xff) {
            if (d[6] === 0) pending = [row, col];            // string follows in a STRING record
            else if (d[6] === 1) put(row, col, d[8]);
            else put(row, col, d[6] === 3 ? '' : null);
          } else put(row, col, f64(d, 6));
          break;
        }
        case 0x0207: if (pending) {                                                                // STRING
          const cch = u16(d, 0);
          put(pending[0], pending[1], biff8 ? ustr(d, 2, cch) : latin1(d.subarray(2, 2 + cch)));
          pending = null;
        } break;
      }
    }
    sheets.push({ name: b.name || `Tabelle${sheets.length + 1}`, cells });
  }
  if (!sheets.length) throw new Error(`„${name}“: keine Tabellenblätter gefunden`);
  return { name, kind: 'xlsx', sheets };
}
