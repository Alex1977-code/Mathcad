import { useEffect, useMemo, useRef, useState } from 'react';
import { store, useStore } from './store';
import {
  alignSelection, canPaste, commands, copyImageWithToast, copySelection, deleteSelection, duplicateSelection, editSelection, insertRegion, paste,
  selectAll, separateAll, toggleDisabled,
} from './actions';
import { compatibleUnits, copyResult, currentUnit, equationUnknown, plotFunction, plottableFunction, resultOf, setDisplayUnit, solveEquation, toggleShowValue, toggleValue, withDisplayUnit } from './smart';

interface Item { label: string; keys?: string; run: () => void; disabled?: boolean; danger?: boolean }
type Entry = Item | 'sep';

/** Right-click menu for regions and the empty page. */
export function ContextMenu() {
  const cm = useStore(s => s.contextMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!cm) return;
    const close = (e: Event) => { if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) store.set({ contextMenu: null }); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') store.set({ contextMenu: null }); };
    window.addEventListener('mousedown', close); window.addEventListener('keydown', key); window.addEventListener('resize', close);
    document.querySelector('.scroller')?.addEventListener('scroll', close);
    return () => {
      window.removeEventListener('mousedown', close); window.removeEventListener('keydown', key); window.removeEventListener('resize', close);
      document.querySelector('.scroller')?.removeEventListener('scroll', close);
    };
  }, [cm]);
  useEffect(() => {
    if (!cm || !ref.current) { setPos(null); return; }
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(cm.x, window.innerWidth - r.width - 8), y: Math.min(cm.y, window.innerHeight - r.height - 8) });
  }, [cm]);
  if (!cm) return null;
  const s = store.get();
  const region = cm.regionId ? s.ws.regions.find(r => r.id === cm.regionId) : undefined;
  const multi = s.selection.length > 1;
  const run = (f: () => void) => () => { store.set({ contextMenu: null }); f(); };
  let items: Entry[];
  if (region) {
    // smart actions for the formula under the mouse (one click instead of retyping)
    const smart: Item[] = [];
    if (region.type === 'math' && !multi) {
      const res = resultOf(region.id);
      const fn = plottableFunction(region.src);
      if (fn) smart.push({ label: `Diagramm von ${fn.name}(${fn.param}) einfügen`, keys: '@', run: () => plotFunction(region.id) });
      const tog = toggleShowValue(region.src);
      if (tog !== null) smart.push({ label: tog.endsWith('=') ? 'Wert anzeigen' : 'Wert ausblenden', run: () => toggleValue(region.id) });
      if (res?.resultLatex && !res.error && withDisplayUnit(region.src, null) !== null) {
        smart.push({ label: 'Einheit des Ergebnisses …', run: () => store.set({ unitPicker: { regionId: region.id, x: cm.x, y: cm.y } }) });
      }
      if ((res?.resultText || res?.valueText) && !res.error) smart.push({ label: 'Ergebnis kopieren', run: () => copyResult(region.id) });
      const u = equationUnknown(region);
      if (u) smart.push({ label: `Gleichung nach ${u} lösen`, run: () => solveEquation(region.id) });
    }
    items = [
      ...smart, ...(smart.length ? ['sep' as const] : []),
      ...(region.type === 'math' || region.type === 'text' ? [{ label: 'Bearbeiten', keys: 'Enter', run: editSelection, disabled: multi }] : []),
      ...(region.type === 'plot' ? [{ label: 'Diagramm bearbeiten …', run: () => store.set({ plotEditor: region.id }) }] : []),
      ...(region.type === 'math' ? [{ label: region.disabled ? 'Auswertung aktivieren' : 'Auswertung deaktivieren', run: toggleDisabled }] : []),
      'sep',
      { label: 'Ausschneiden', keys: 'Strg+X', run: () => copySelection(true) },
      { label: 'Kopieren', keys: 'Strg+C', run: () => copySelection(false) },
      { label: 'Als Bild kopieren', run: copyImageWithToast },
      { label: 'Duplizieren', keys: 'Strg+D', run: duplicateSelection },
      ...(multi ? ['sep' as const, { label: 'Links ausrichten', run: () => alignSelection('left') }, { label: 'Oben ausrichten', run: () => alignSelection('top') }] : []),
      'sep',
      { label: multi ? `${s.selection.length} Bereiche löschen` : 'Löschen', keys: 'Entf', run: deleteSelection, danger: true },
    ];
  } else {
    const at = cm.page;
    items = [
      { label: 'Formel hier einfügen', run: () => insertRegion('math', at) },
      { label: 'Text hier einfügen', run: () => insertRegion('text', at) },
      { label: 'Diagramm hier einfügen', run: () => insertRegion('plot', at) },
      'sep',
      { label: 'Einfügen', keys: 'Strg+V', run: () => paste(at), disabled: !canPaste() },
      { label: 'Alles auswählen', keys: 'Strg+A', run: selectAll },
      { label: 'Bereiche trennen', run: () => separateAll() },
    ];
  }
  return (
    <div ref={ref} className="ctxmenu" role="menu" style={{ left: pos?.x ?? cm.x, top: pos?.y ?? cm.y, visibility: pos ? 'visible' : 'hidden' }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) => it === 'sep'
        ? <hr key={i} />
        : <button key={i} role="menuitem" disabled={it.disabled} className={it.danger ? 'danger' : ''} onClick={run(it.run)}>{it.label}{it.keys && <kbd>{it.keys}</kbd>}</button>)}
    </div>
  );
}

/** Ctrl+K: search and run any command. */
export function CommandPalette() {
  const open = useStore(s => s.palette);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => {
    if (!open) return [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return commands().filter(c => (!c.when || c.when()) && words.every(w => `${c.group} ${c.label} ${c.tags ?? ''} ${c.id}`.toLowerCase().includes(w)));
  }, [q, open]);
  useEffect(() => { if (open) { setQ(''); setIdx(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  useEffect(() => { setIdx(0); }, [q]);
  if (!open) return null;
  const close = () => store.set({ palette: false });
  const exec = (i: number) => { const c = list[i]; if (!c) return; close(); setTimeout(c.run, 0); };
  return (
    <div className="backdrop palette-backdrop" onMouseDown={close}>
      <div className="palette" role="dialog" aria-label="Befehle" onMouseDown={(e) => e.stopPropagation()}>
        <input ref={input} autoFocus value={q} placeholder="Befehl suchen – z. B. „speichern“, „diagramm“, „komma“ …" onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(list.length - 1, i + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); exec(idx); }
            else if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) { e.preventDefault(); close(); }
            e.stopPropagation();
          }} />
        <div className="palette-list" role="listbox">
          {list.length === 0 && <div className="empty-hint">Kein Befehl gefunden.</div>}
          {list.map((c, i) => (
            <div key={c.id} role="option" aria-selected={i === idx} className={i === idx ? 'sel' : ''} onMouseEnter={() => setIdx(i)} onClick={() => exec(i)}>
              <span className="grp">{c.group}</span><span className="lbl">{c.label}</span>{c.keys && <kbd>{c.keys}</kbd>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The sheet takes the keyboard again (typing, arrows, Delete). */
const focusSheet = () => (document.querySelector('.scroller') as HTMLElement | null)?.focus({ preventScroll: true });

/** Click on a result: choose the display unit (compatible units only) – Mathcad's unit placeholder. */
export function UnitPicker() {
  const up = useStore(s => s.unitPicker);
  const ws = useStore(s => s.ws);
  const ref = useRef<HTMLDivElement>(null);
  const [custom, setCustom] = useState('');
  const [bad, setBad] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const region = up ? ws.regions.find(r => r.id === up.regionId) : undefined;
  const src = region?.type === 'math' ? region.src : '';
  const res = up ? resultOf(up.regionId) : undefined;
  const units = useMemo(() => (res?.dims ? compatibleUnits(res.dims) : ['deg', '%']), [res?.dims?.join(',')]);
  useEffect(() => {
    if (!up) return;
    setCustom(''); setBad(false);
    const close = (e: Event) => { if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) store.set({ unitPicker: null }); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); store.set({ unitPicker: null }); focusSheet(); } };
    window.addEventListener('mousedown', close); window.addEventListener('keydown', key, true); window.addEventListener('resize', close);
    document.querySelector('.scroller')?.addEventListener('scroll', close);
    return () => {
      window.removeEventListener('mousedown', close); window.removeEventListener('keydown', key, true); window.removeEventListener('resize', close);
      document.querySelector('.scroller')?.removeEventListener('scroll', close);
    };
  }, [up]);
  useEffect(() => {
    if (!up || !ref.current) { setPos(null); return; }
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(up.x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(up.y, window.innerHeight - r.height - 8)) });
  }, [up]);
  if (!up || !region || region.type !== 'math') return null;
  const cur = currentUnit(src);
  const pick = (u: string | null) => { if (setDisplayUnit(up.regionId, u)) { store.set({ unitPicker: null }); focusSheet(); } else setBad(true); };
  return (
    <div ref={ref} className="unit-picker" role="dialog" aria-label="Einheit wählen"
      style={{ left: pos?.x ?? up.x, top: pos?.y ?? up.y, visibility: pos ? 'visible' : 'hidden' }} onContextMenu={(e) => e.preventDefault()}>
      <div className="up-head">Ergebnis anzeigen in</div>
      <div className="up-units">
        <button className={!cur ? 'sel' : ''} onClick={() => pick(null)} title="Ohne Anzeigeeinheit: SI-Grundeinheiten">Auto (SI)</button>
        {units.map(u => <button key={u} className={cur === u ? 'sel' : ''} onClick={() => pick(u)}>{u.replace(/\*/g, '·')}</button>)}
      </div>
      <form className="up-custom" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) pick(custom.trim()); }}>
        <input value={custom} placeholder="andere Einheit, z. B. kN*m" aria-label="Eigene Einheit" className={bad ? 'bad' : ''}
          onChange={(e) => { setCustom(e.target.value); setBad(false); }} onKeyDown={(e) => e.stopPropagation()} />
        <button type="submit" className="btn">OK</button>
      </form>
      <div className="up-foot">
        <button onClick={() => { copyResult(up.regionId); store.set({ unitPicker: null }); }}>Kopieren</button>
        <span className="up-spacer" />
        <span className="muted">Stellen</span>
        <button title="Weniger Nachkommastellen" onClick={() => store.setSettings({ decimals: Math.max(0, ws.settings.decimals - 1) })}>−</button>
        <b>{ws.settings.decimals}</b>
        <button title="Mehr Nachkommastellen" onClick={() => store.setSettings({ decimals: Math.min(12, ws.settings.decimals + 1) })}>+</button>
      </div>
    </div>
  );
}
