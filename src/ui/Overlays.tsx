import { useEffect, useMemo, useRef, useState } from 'react';
import { store, useStore } from './store';
import {
  alignSelection, canPaste, commands, copySelection, deleteSelection, duplicateSelection, editSelection, insertRegion, paste,
  selectAll, separateAll, toggleDisabled,
} from './actions';

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
    items = [
      ...(region.type === 'math' || region.type === 'text' ? [{ label: 'Bearbeiten', keys: 'Enter', run: editSelection, disabled: multi }] : []),
      ...(region.type === 'plot' ? [{ label: 'Diagramm bearbeiten …', run: () => store.set({ plotEditor: region.id }) }] : []),
      ...(region.type === 'math' ? [{ label: region.disabled ? 'Auswertung aktivieren' : 'Auswertung deaktivieren', run: toggleDisabled }] : []),
      'sep',
      { label: 'Ausschneiden', keys: 'Strg+X', run: () => copySelection(true) },
      { label: 'Kopieren', keys: 'Strg+C', run: () => copySelection(false) },
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
    return commands().filter(c => (!c.when || c.when()) && words.every(w => `${c.group} ${c.label}`.toLowerCase().includes(w)));
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
            else if (e.key === 'Escape') { e.preventDefault(); close(); }
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
