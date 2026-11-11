import { useEffect, useRef, useState } from 'react';
import { newId, safeImageSrc, type Region } from '../engine/model';
import type { ComputeResult } from '../engine/worksheet';
import { store, useStore } from './store';
import { MARGIN, PAGE_H, PAGE_W, regionElements, snap } from './layout';
import { MathRegionView } from './regions/MathRegionView';
import { TextRegionView } from './regions/TextRegionView';
import { PlotRegionView } from './regions/PlotRegionView';
import { TableRegionView } from './regions/TableRegionView';
import { SliderRegionView } from './regions/SliderRegionView';
import { insertSnippet, newMathRegion } from './actions';
import { quickPlotAtCursor } from './smart';
import { RecentList } from './RecentList';

interface Props { result: ComputeResult | null; onOpenExample: () => void; onImport: () => void; pending?: Set<string> }

interface DragState {
  kind: 'move' | 'rubber' | 'resize';
  startX: number; startY: number;
  orig: Map<string, { x: number; y: number; w?: number; h?: number }>;
  moved: boolean;
  regionId?: string;
  shift?: boolean;
}

export { newMathRegion };

export function Sheet({ result, onOpenExample, onImport, pending }: Props) {
  const ws = useStore(s => s.ws);
  const selection = useStore(s => s.selection);
  const editing = useStore(s => s.editing);
  const cursor = useStore(s => s.cursor);
  const zoom = useStore(s => s.zoom);
  const showChecks = useStore(s => s.showChecks);
  const focusRegion = useStore(s => s.focusRegion);
  const showGrid = useStore(s => s.showGrid);
  const scroller = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const [rubber, setRubber] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const fontSize = ws.settings.fontSize ?? 15;
  const maxBottom = Math.max(0, ...ws.regions.map(r => r.y + (r.h ?? 40)));
  const pages = Math.max(1, Math.ceil((maxBottom + 240) / PAGE_H));
  const pageHeight = pages * PAGE_H;
  const selSet = new Set(selection);

  // keep keyboard focus on the sheet when nothing is edited
  useEffect(() => { if (!editing) scroller.current?.focus({ preventScroll: true }); }, [editing]);

  const docId = useStore(s => s.docId);
  useEffect(() => { scroller.current?.scrollTo({ top: 0, left: 0 }); }, [docId]);

  // scroll a region into view on request
  useEffect(() => {
    if (!focusRegion) return;
    const el = regionElements.get(focusRegion.id);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusRegion]);

  const toPage = (e: { clientX: number; clientY: number }) => {
    const rect = page.current!.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  };

  const startEdit = (r: Region) => {
    if (r.type !== 'math' && r.type !== 'text') return;
    store.beginEdit(r.id);
    store.set({ editing: r.id, editOriginal: r.type === 'math' ? r.src : null, selection: [r.id] });
  };

  const commitEdit = (id: string, height: number) => {
    const s = store.get();
    const r = s.ws.regions.find(x => x.id === id);
    if (!r) { store.set({ editing: null }); return; }
    const empty = (r.type === 'math' && !r.src.trim()) || (r.type === 'text' && !r.html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').trim());
    if (empty) {
      store.discardRegion(id);
      store.set({ editing: null, selection: [], cursor: { x: r.x, y: r.y } });
      return;
    }
    store.set({ editing: null, selection: [id], cursor: { x: r.x, y: snap(r.y + height + 14) } });
  };

  /** End the current edit (e.g. when clicking elsewhere). */
  const finishEditing = () => {
    const id = store.get().editing;
    if (!id) return;
    const el = regionElements.get(id);
    commitEdit(id, (el?.offsetHeight ?? 30));
  };

  /* ---------------------------- mouse ----------------------------- */

  const onPageMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (store.get().editing) finishEditing();
    const p = toPage(e);
    drag.current = { kind: 'rubber', startX: p.x, startY: p.y, orig: new Map(), moved: false, shift: e.shiftKey };
    e.preventDefault();
    scroller.current?.focus({ preventScroll: true });
  };

  const onRegionMouseDown = (e: React.MouseEvent, r: Region) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (store.get().editing === r.id) return;
    if (store.get().editing) finishEditing();
    // click on a result (Mathcad: unit placeholder) → choose the display unit
    const hit = (e.target as HTMLElement).closest?.('.fw-result');
    if (hit && r.type === 'math' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const res = result?.results[r.id];
      if (res?.resultLatex && !res.error && res.src === r.src) {
        e.preventDefault();
        const b = hit.getBoundingClientRect();
        store.set({ selection: [r.id], unitPicker: { regionId: r.id, x: b.left, y: b.bottom + 6 } });
        return;
      }
    }
    let sel = store.get().selection;
    if (e.shiftKey || e.ctrlKey || e.metaKey) sel = sel.includes(r.id) ? sel.filter(x => x !== r.id) : [...sel, r.id];
    else if (!sel.includes(r.id)) sel = [r.id];
    store.set({ selection: sel });
    const p = toPage(e);
    const orig = new Map<string, { x: number; y: number }>();
    for (const x of store.get().ws.regions) if (sel.includes(x.id)) orig.set(x.id, { x: x.x, y: x.y });
    drag.current = { kind: 'move', startX: p.x, startY: p.y, orig, moved: false, regionId: r.id, shift: e.shiftKey || e.ctrlKey || e.metaKey };
    e.preventDefault();
    scroller.current?.focus({ preventScroll: true });
  };

  const onResizeMouseDown = (e: React.MouseEvent, r: Region) => {
    e.stopPropagation(); e.preventDefault();
    const p = toPage(e);
    const el = regionElements.get(r.id);
    drag.current = { kind: 'resize', startX: p.x, startY: p.y, orig: new Map([[r.id, { x: r.x, y: r.y, w: r.w ?? el?.offsetWidth ?? 200, h: r.h ?? el?.offsetHeight ?? 100 }]]), moved: false, regionId: r.id };
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const p = toPage(e);
      const dx = p.x - d.startX, dy = p.y - d.startY;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      if (!d.moved) { d.moved = true; if (d.kind !== 'rubber') store.checkpoint(); }
      if (d.kind === 'move') {
        // the group keeps its shape: limited by its leftmost/topmost region
        const os = [...d.orig.values()];
        const sx = Math.max(snap(dx), -Math.min(...os.map(o => o.x))), sy = Math.max(snap(dy), -Math.min(...os.map(o => o.y)));
        store.updateWs(ws => ({
          ...ws,
          regions: ws.regions.map(r => {
            const o = d.orig.get(r.id);
            return o ? { ...r, x: Math.max(0, o.x + sx), y: Math.max(0, o.y + sy) } as Region : r;
          }),
        }), false);
      } else if (d.kind === 'resize') {
        const o = d.orig.get(d.regionId!)!;
        // plots need room for axis labels; text and images can be narrower
        const isPlot = store.get().ws.regions.find(x => x.id === d.regionId)?.type === 'plot';
        store.updateRegion(d.regionId!, { w: Math.max(isPlot ? 240 : 120, snap(o.w! + dx)), h: Math.max(isPlot ? 160 : 80, snap(o.h! + dy)) }, false);
      } else {
        setRubber({ x: Math.min(d.startX, p.x), y: Math.min(d.startY, p.y), w: Math.abs(dx), h: Math.abs(dy) });
      }
    };
    const up = (e: MouseEvent) => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      if (d.kind === 'rubber') {
        setRubber(null);
        const p = toPage(e);
        if (!d.moved) {
          store.set({ selection: [], cursor: { x: snap(Math.max(0, d.startX)), y: snap(Math.max(0, d.startY)) } });
          return;
        }
        const x0 = Math.min(d.startX, p.x), x1 = Math.max(d.startX, p.x), y0 = Math.min(d.startY, p.y), y1 = Math.max(d.startY, p.y);
        const hit = store.get().ws.regions.filter(r => {
          const el = regionElements.get(r.id);
          const w = el?.offsetWidth ?? 40, h = el?.offsetHeight ?? 20;
          const rx = el?.offsetLeft ?? r.x;
          return rx < x1 && rx + w > x0 && r.y < y1 && r.y + h > y0;
        }).map(r => r.id);
        store.set({ selection: d.shift ? [...new Set([...store.get().selection, ...hit])] : hit });
      } else if (d.kind === 'move' && !d.moved && !d.shift) {
        const r = store.get().ws.regions.find(x => x.id === d.regionId);
        if (r && (r.type === 'math' || r.type === 'text')) startEdit(r);
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [zoom]);

  /* --------------------------- keyboard --------------------------- */

  const onKeyDown = (e: React.KeyboardEvent) => {
    const s = store.get();
    if (s.editing || s.palette || s.contextMenu || s.unitPicker) return;
    // AltGr (German keyboard: [ ] { } \ | @ € µ ~) arrives as Ctrl+Alt and must still start a formula
    const altGr = e.getModifierState?.('AltGraph') || (e.ctrlKey && e.altKey && e.key.length === 1);
    if ((e.ctrlKey || e.metaKey || e.altKey) && !altGr) return;
    const cur = s.cursor ?? { x: MARGIN, y: MARGIN };
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (s.selection.length) { e.preventDefault(); store.deleteRegions(s.selection); }
      return;
    }
    if (e.key === 'Escape') { store.set({ selection: [] }); return; }
    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const step = e.shiftKey ? 48 : 12;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (s.selection.length) store.moveRegions(s.selection, dx, dy);
      else store.set({ cursor: { x: Math.max(0, cur.x + dx), y: Math.max(0, cur.y + dy) } });
      return;
    }
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      if (s.selection.length === 1) {
        const r = s.ws.regions.find(x => x.id === s.selection[0]);
        if (r) {
          if (r.type === 'plot') store.set({ plotEditor: r.id }); else startEdit(r);
        }
        return;
      }
      store.addRegion(newMathRegion(cur.x, cur.y), true);
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      if (e.key === '"') {
        store.addRegion({ id: newId(), type: 'text', x: cur.x, y: cur.y, w: 360, html: '' }, true);
        return;
      }
      // Mathcad: "@" X-Y plot, "$" sum, "&" integral
      if (e.key === '@') { quickPlotAtCursor(); return; }
      if (e.key === '$' || e.key === '&') {
        store.set({ selection: [] });
        insertSnippet(e.key === '$' ? 'sum(?, i, 1, n)' : 'int(?, x, a, b)');
        return;
      }
      const r = newMathRegion(cur.x, cur.y, e.key === ' ' ? '' : e.key);
      store.addRegion(r, true);
      store.set({ editOriginal: '' });
    }
  };

  const results = result?.results ?? {};
  const isEmpty = ws.regions.length === 0;

  return (
    <div className="scroller" ref={scroller} tabIndex={0} onKeyDown={onKeyDown} aria-label="Arbeitsblatt">
      <div className="page-outer">
        <div style={{ width: PAGE_W * zoom, height: pageHeight * zoom }}>
          <div
            ref={page}
            className={`page${showGrid ? '' : ' no-grid'}`}
            onContextMenu={(e) => {
              if (e.target !== page.current) return;
              e.preventDefault();
              const p = toPage(e);
              store.set({ selection: [], contextMenu: { x: e.clientX, y: e.clientY, page: { x: snap(p.x), y: snap(p.y) } } });
            }}
            style={{ width: PAGE_W, height: pageHeight, transform: `scale(${zoom})`, transformOrigin: 'top left', fontSize: fontSize }}
            onMouseDown={onPageMouseDown}
            onDoubleClick={(e) => {
              if (e.target !== page.current) return;
              const p = toPage(e);
              store.addRegion(newMathRegion(snap(p.x), snap(p.y)), true);
            }}
          >
            <div className="page-margin" style={{ left: MARGIN }} />
            <div className="page-margin" style={{ left: PAGE_W - MARGIN }} />
            {Array.from({ length: Math.min(Math.max(pages - 1, 0), 2000) }, (_, i) => (
              <div key={i} className="page-break-line" style={{ top: (i + 1) * PAGE_H }}><span>Seite {i + 2}</span></div>
            ))}
            {ws.regions.map(r => {
              const res = results[r.id];
              const sel = selSet.has(r.id);
              const ed = editing === r.id;
              const err = (r.type === 'math' || r.type === 'table' || r.type === 'slider') && !!res?.error && !ed;
              const cls = ['region', `${r.type}-region`, sel ? 'selected' : '', ed ? 'editing' : '', err ? 'error' : '',
                r.type === 'math' && r.disabled ? 'disabled-calc' : '', pending?.has(r.id) && !ed ? 'pending' : ''].filter(Boolean).join(' ');
              return (
                <div
                  key={r.id}
                  data-region={r.id}
                  ref={(el) => { if (el) regionElements.set(r.id, el); else regionElements.delete(r.id); }}
                  className={cls}
                  style={{ left: r.x, top: r.y }}
                  onMouseDown={(e) => onRegionMouseDown(e, r)}
                  onDoubleClick={(e) => { e.stopPropagation(); if (r.type === 'plot') store.set({ plotEditor: r.id, selection: [r.id] }); }}
                  onContextMenu={(e) => {
                    if (store.get().editing === r.id) return;
                    e.preventDefault(); e.stopPropagation();
                    if (store.get().editing) finishEditing();
                    if (!store.get().selection.includes(r.id)) store.set({ selection: [r.id] });
                    store.set({ contextMenu: { x: e.clientX, y: e.clientY, regionId: r.id } });
                  }}
                >
                  {r.type !== 'pagebreak' && <span className="grip" title="Verschieben" />}
                  {r.type === 'math' && (
                    <MathRegionView region={r} result={res} editing={ed} variables={result?.variables ?? []} showCheck={showChecks} onCommit={commitEdit} />
                  )}
                  {r.type === 'text' && <TextRegionView region={r} editing={ed} onCommit={commitEdit} />}
                  {r.type === 'plot' && (
                    <>
                      <PlotRegionView region={r} data={res?.plot} onEdit={() => store.set({ plotEditor: r.id, selection: [r.id] })} />
                      {sel && <span className="resize-handle" title="Größe ändern" onMouseDown={(e) => onResizeMouseDown(e, r)} style={{ position: 'absolute', right: -5, bottom: -5, width: 12, height: 12, borderRadius: 3, background: 'var(--accent)', cursor: 'nwse-resize' }} />}
                    </>
                  )}
                  {r.type === 'image' && (
                    <div className="image-region-inner">
                      <img src={safeImageSrc(r.src) ?? ''} alt={r.alt ?? ''} style={{ width: r.w || undefined }} draggable={false} />
                      {r.alt && /Mathcad/.test(r.alt) && <div className="caption">{r.alt}</div>}
                    </div>
                  )}
                  {r.type === 'table' && <TableRegionView region={r} result={res} />}
                  {r.type === 'slider' && <SliderRegionView region={r} result={res} selected={sel && selection.length === 1} />}
                  {r.type === 'pagebreak' && <span>Seitenumbruch</span>}
                </div>
              );
            })}
            {cursor && !editing && <div className="crosshair blink" style={{ left: cursor.x, top: cursor.y + 10 }} />}
            {rubber && <div className="rubber" style={{ left: rubber.x, top: rubber.y, width: rubber.w, height: rubber.h }} />}
            {isEmpty && (
              <div className="welcome" onMouseDown={(e) => e.stopPropagation()}>
                <h2>Leeres Arbeitsblatt</h2>
                <p>Klicken Sie irgendwo auf das Blatt und tippen Sie los – z. B. <code>F := 12 kN</code> und <kbd>Enter</kbd>,<br />dann <code>F*2.5 m =</code> für ein Ergebnis. Mit <code>"</code> beginnen Sie einen Textbereich.</p>
                <div className="actions">
                  <button className="btn primary" onClick={() => { store.addRegion(newMathRegion(cursor?.x ?? MARGIN, cursor?.y ?? MARGIN), true); }}>Erste Formel eingeben</button>
                  <button className="btn" onClick={onOpenExample}>Beispiel öffnen</button>
                  <button className="btn" onClick={onImport}>Mathcad-Datei importieren</button>
                </div>
                <RecentList max={6} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
