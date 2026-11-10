import { useRef } from 'react';
import type { TableRegion } from '../../engine/model';
import type { RegionResult } from '../../engine/worksheet';
import { store, useStore } from '../store';
import { parseDelimited } from '../../engine/datafiles';

interface Props { region: TableRegion; result?: RegionResult }

/** Spreadsheet-like data table: name, column names and units, cells; paste from Excel fills the grid. */
export function TableRegionView({ region, result }: Props) {
  const origin = useStore(s => s.ws.settings.origin ?? 0);
  const box = useRef<HTMLDivElement>(null);
  /** One undo step per edited cell (recorded on the first change after focusing it). */
  const dirty = useRef(false);
  const ncol = region.columns.length;

  const update = (patch: Partial<TableRegion>) => {
    if (!dirty.current) { store.checkpoint(); dirty.current = true; }
    store.updateRegion(region.id, patch, false);
  };
  const setCell = (i: number, j: number, v: string) => {
    const rows = region.rows.map(r => r.slice());
    while (rows.length <= i) rows.push([]);
    while (rows[i].length < ncol) rows[i].push('');
    rows[i][j] = v;
    // a row is always available at the end for typing
    if (i === rows.length - 1 && v.trim()) rows.push(Array(ncol).fill(''));
    update({ rows });
  };
  const setCol = (j: number, key: 'name' | 'unit', v: string) => {
    const columns = region.columns.map((c, k) => (k === j ? { ...c, [key]: v || undefined } : c));
    update({ columns });
  };
  const addCol = () => { store.checkpoint(); store.updateRegion(region.id, { columns: [...region.columns, {}], rows: region.rows.map(r => [...r, '']) }, false); };
  const delCol = (j: number) => { if (ncol <= 1) return; store.checkpoint(); store.updateRegion(region.id, { columns: region.columns.filter((_, k) => k !== j), rows: region.rows.map(r => r.filter((_, k) => k !== j)) }, false); };
  const addRow = () => { store.checkpoint(); store.updateRegion(region.id, { rows: [...region.rows, Array(ncol).fill('')] }, false); };
  const delRow = (i: number) => { store.checkpoint(); store.updateRegion(region.id, { rows: region.rows.filter((_, k) => k !== i) }, false); };

  const focusCell = (i: number, j: number) => setTimeout(() => (box.current?.querySelector(`input[data-cell="${i}:${j}"]`) as HTMLInputElement | null)?.focus(), 0);

  /** Paste of several cells (from Excel, LibreOffice, CSV): fills from the cell on. */
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>, i: number, j: number) => {
    const text = e.clipboardData.getData('text/plain');
    if (!/[\t\n]/.test(text.trim())) return;
    e.preventDefault();
    e.stopPropagation();
    const raw = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map(l => l.split('\t'));
    const lines = raw.length && raw.every(r => r.length === 1) ? parseDelimited(text).map(r => r.map(String)) : raw;
    let data = lines;
    let columns = region.columns.slice();
    // first line with texts only above numbers: column names
    const isNum = (s: string) => /^[+-]?[\d.,]+([eE][+-]?\d+)?$/.test(s.trim());
    if (i === 0 && data.length > 1 && data[0].every(c => c.trim() && !isNum(c)) && data[1].some(isNum)) {
      data[0].forEach((name, k) => {
        while (columns.length <= j + k) columns.push({});
        const unit = /\[(.+)\]|\((.+)\)/.exec(name);
        const clean = name.replace(/\s*[[(].*[\])]\s*/, '').trim().replace(/[^\p{L}\p{N}_]/gu, '_').replace(/^(\d)/, '_$1');
        columns[j + k] = { name: clean || columns[j + k].name, unit: unit ? (unit[1] ?? unit[2]).trim() : columns[j + k].unit };
      });
      data = data.slice(1);
    }
    const width = Math.max(...data.map(r => r.length));
    while (columns.length < j + width) columns.push({});
    const rows = region.rows.map(r => r.slice());
    data.forEach((r, a) => {
      while (rows.length <= i + a) rows.push([]);
      const row = rows[i + a];
      while (row.length < columns.length) row.push('');
      r.forEach((c, b) => { row[j + b] = c.trim(); });
    });
    for (const r of rows) while (r.length < columns.length) r.push('');
    rows.push(Array(columns.length).fill(''));
    store.checkpoint();
    store.updateRegion(region.id, { columns, rows }, false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, i: number, j: number) => {
    e.stopPropagation();
    if (e.key === 'Enter' || (e.key === 'ArrowDown' && !e.altKey)) { e.preventDefault(); if (i + 1 >= region.rows.length) addRow(); focusCell(i + 1, j); }
    else if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); focusCell(i - 1, j); }
    else if (e.key === 'Escape') (e.currentTarget as HTMLInputElement).blur();
  };

  const err = result?.error;
  return (
    <div className="table-region" ref={box} onKeyDown={(e) => e.stopPropagation()}>
      <div className="tr-head">
        <input className="tr-name" aria-label="Name der Tabelle" value={region.name} spellCheck={false}
          onMouseDown={(e) => e.stopPropagation()} onFocus={() => { dirty.current = false; }}
          onChange={(e) => update({ name: e.target.value.replace(/\s+/g, '') })} />
        <span className="tr-def">:=</span>
        <span className="tr-meta">{err ? '' : result?.resultText ?? ''}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th className="tr-idx" />
            {region.columns.map((c, j) => (
              <th key={j}>
                <input className="tr-col" placeholder="Name" aria-label={`Spalte ${j + 1} Name`} value={c.name ?? ''} spellCheck={false}
                  onMouseDown={(e) => e.stopPropagation()} onFocus={() => { dirty.current = false; }} onChange={(e) => setCol(j, 'name', e.target.value.replace(/\s+/g, ''))} />
                <input className="tr-unit" placeholder="Einheit" aria-label={`Spalte ${j + 1} Einheit`} value={c.unit ?? ''} spellCheck={false}
                  onMouseDown={(e) => e.stopPropagation()} onFocus={() => { dirty.current = false; }} onChange={(e) => setCol(j, 'unit', e.target.value)} />
                {ncol > 1 && <button className="tr-del" title="Spalte löschen" onMouseDown={(e) => e.stopPropagation()} onClick={() => delCol(j)}>×</button>}
              </th>
            ))}
            <th className="tr-add"><button title="Spalte hinzufügen" onMouseDown={(e) => e.stopPropagation()} onClick={addCol}>+</button></th>
          </tr>
        </thead>
        <tbody>
          {region.rows.map((row, i) => (
            <tr key={i}>
              <td className="tr-idx">
                <span>{origin + i}</span>
                <button className="tr-del" title="Zeile löschen" onMouseDown={(e) => e.stopPropagation()} onClick={() => delRow(i)}>×</button>
              </td>
              {region.columns.map((_, j) => (
                <td key={j}>
                  <input data-cell={`${i}:${j}`} value={row[j] ?? ''} spellCheck={false} aria-label={`Zeile ${origin + i}, Spalte ${j + 1}`}
                    onMouseDown={(e) => e.stopPropagation()} onFocus={() => { dirty.current = false; store.set({ selection: [region.id] }); }}
                    onChange={(e) => setCell(i, j, e.target.value)} onKeyDown={(e) => onKeyDown(e, i, j)} onPaste={(e) => onPaste(e, i, j)} />
                </td>
              ))}
              <td />
            </tr>
          ))}
          <tr><td className="tr-idx" /><td colSpan={ncol}><button className="tr-addrow" onMouseDown={(e) => e.stopPropagation()} onClick={addRow}>+ Zeile</button></td></tr>
        </tbody>
      </table>
      {err && <div className="error-chip">{err.message}</div>}
    </div>
  );
}
