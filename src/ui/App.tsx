import { useEffect, useRef, useState } from 'react';
import { emptyWorksheet, type MathRegion, type Region, type Worksheet } from '../engine/model';
import { useCompute } from './compute';
import { store, useStore } from './store';
import { Sheet } from './Sheet';
import { Ribbon, separateAll } from './Ribbon';
import { SidePanel, type SideTab } from './SidePanel';
import { autosave, exportHtml, loadAutosave, pickFile, readWorksheet, resetFileHandle, saveWorksheet } from './files';
import { exampleWorksheet } from './examples';
import { regionElements } from './layout';
import {
  IconExample, IconExport, IconHelp, IconImport, IconMoon, IconNew, IconOpen, IconPanel, IconPrint, IconRedo, IconSave, IconSun, IconUndo,
} from './icons';

type Theme = 'light' | 'dark';

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try { const t = localStorage.getItem('formelwerk.theme'); if (t === 'light' || t === 'dark') return t; } catch { /* ignore */ }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('formelwerk.theme', theme); } catch { /* ignore */ }
  }, [theme]);
  return [theme, () => setTheme(t => (t === 'dark' ? 'light' : 'dark'))];
}

interface Toast { text: string; err?: boolean; id: number }

export function App() {
  const ws = useStore(s => s.ws);
  const dirty = useStore(s => s.dirty);
  const zoom = useStore(s => s.zoom);
  const plotEditor = useStore(s => s.plotEditor);
  const { result, busy, error } = useCompute(ws);
  const [theme, toggleTheme] = useTheme();
  const [sideOpen, setSideOpen] = useState(() => window.innerWidth > 900);
  const [sideTab, setSideTab] = useState<SideTab>('vars');
  const [fileMenu, setFileMenu] = useState(false);
  const [report, setReport] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const pendingSeparate = useRef(false);
  const fileMenuRef = useRef<HTMLDivElement>(null);

  const notify = (text: string, err = false) => {
    const id = Date.now();
    setToast({ text, err, id });
    setTimeout(() => setToast(t => (t?.id === id ? null : t)), err ? 6000 : 3200);
  };

  /* ------------------------------ startup ------------------------------ */
  useEffect(() => {
    // small screens: fit the A4 page to the width
    if (window.innerWidth < 900) store.set({ zoom: Math.max(0.4, Math.min(1, (window.innerWidth - 24) / 794)) });
    const saved = loadAutosave();
    if (saved && saved.regions.length) { store.load(saved, null); store.set({ dirty: true }); }
    else store.load(exampleWorksheet(), null);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => autosave(ws), 600);
    return () => clearTimeout(t);
  }, [ws]);

  useEffect(() => {
    document.title = `${ws.title || 'Unbenannt'}${dirty ? ' •' : ''} – FormelWerk`;
  }, [ws.title, dirty]);

  // after an import: once rendered, separate overlapping regions (fonts differ from Mathcad)
  useEffect(() => {
    if (!pendingSeparate.current || !result) return;
    pendingSeparate.current = false;
    requestAnimationFrame(() => requestAnimationFrame(() => separateAll(false)));
  }, [result]);

  useEffect(() => {
    if (!fileMenu) return;
    const h = (e: MouseEvent) => { if (!fileMenuRef.current?.contains(e.target as Node)) setFileMenu(false); };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [fileMenu]);

  /* ------------------------------ file ops ----------------------------- */
  const confirmDiscard = () => !store.get().dirty || store.get().ws.regions.length === 0 || window.confirm('Ungespeicherte Änderungen verwerfen?');

  const openFile = async (file?: File | null) => {
    setFileMenu(false);
    const f = file ?? await pickFile();
    if (!f) return;
    if (!confirmDiscard()) return;
    try {
      const doc = await readWorksheet(f);
      store.load(doc, f.name);
      if (doc.source) {
        pendingSeparate.current = true;
        setReport(true);
      } else notify(`„${f.name}“ geöffnet`);
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const save = async (as = false) => {
    setFileMenu(false);
    const s = store.get();
    const toSave: Worksheet = s.ws.source ? { ...s.ws } : s.ws;
    const name = await saveWorksheet(toSave, as);
    if (name) { store.set({ dirty: false, fileName: name }); notify(`Gespeichert: ${name}`); }
  };

  const newDoc = () => {
    setFileMenu(false);
    if (!confirmDiscard()) return;
    resetFileHandle();
    store.load(emptyWorksheet(), null);
  };

  const openExample = () => {
    setFileMenu(false);
    if (!confirmDiscard()) return;
    store.load(exampleWorksheet(), null);
  };

  /* ---------------------------- clipboard ------------------------------ */
  const clip = useRef<Region[]>([]);
  const copy = (cut: boolean) => {
    const s = store.get();
    const regs = s.ws.regions.filter(r => s.selection.includes(r.id));
    if (!regs.length) return;
    clip.current = regs;
    const text = regs.filter(r => r.type === 'math').map(r => (r as MathRegion).src).join('\n');
    navigator.clipboard?.writeText(text).catch(() => undefined);
    if (cut) store.deleteRegions(s.selection);
  };
  const paste = () => {
    const s = store.get();
    if (!clip.current.length) return;
    const minX = Math.min(...clip.current.map(r => r.x)), minY = Math.min(...clip.current.map(r => r.y));
    const cur = s.cursor ?? { x: minX + 24, y: minY + 24 };
    const copies = store.cloneRegions(clip.current, cur.x - minX, cur.y - minY);
    store.updateWs(w => ({ ...w, regions: [...w.regions, ...copies] }));
    store.set({ selection: copies.map(r => r.id) });
  };
  const duplicate = () => {
    const s = store.get();
    const regs = s.ws.regions.filter(r => s.selection.includes(r.id));
    if (!regs.length) return;
    const h = Math.max(...regs.map(r => r.y + (regionElements.get(r.id)?.offsetHeight ?? 24))) - Math.min(...regs.map(r => r.y));
    const copies = store.cloneRegions(regs, 0, h + 12);
    store.updateWs(w => ({ ...w, regions: [...w.regions, ...copies] }));
    store.set({ selection: copies.map(r => r.id) });
  };

  /* ---------------------------- shortcuts ------------------------------ */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const s = store.get();
      const inField = (e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable="true"], select');
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(e.shiftKey); return; }
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openFile(); return; }
      if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); window.print(); return; }
      if (inField || s.editing) return;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); return; }
      if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); store.redo(); return; }
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); store.set({ selection: s.ws.regions.map(r => r.id) }); return; }
      if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copy(false); return; }
      if (mod && e.key.toLowerCase() === 'x') { e.preventDefault(); copy(true); return; }
      if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); paste(); return; }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(); return; }
      if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); store.set({ zoom: Math.min(2, +(s.zoom + 0.1).toFixed(2)) }); return; }
      if (mod && e.key === '-') { e.preventDefault(); store.set({ zoom: Math.max(0.5, +(s.zoom - 0.1).toFixed(2)) }); return; }
      if (mod && e.key === '0') { e.preventDefault(); store.set({ zoom: 1 }); return; }
    };
    window.addEventListener('keydown', onKey);
    const beforeUnload = (e: BeforeUnloadEvent) => { if (store.get().dirty && store.get().fileName) { e.preventDefault(); } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', beforeUnload); };
  }, []);

  /* ---------------------------- drag & drop ----------------------------- */
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) openFile(f);
  };

  const errorCount = result?.errorCount ?? 0;
  const ver = result?.verification;
  const jumpToFirstError = () => {
    if (!result) return;
    const ids = Object.values(result.results).filter(r => r.error || r.plot?.error).map(r => r.id);
    const order = store.get().ws.regions.filter(r => ids.includes(r.id)).sort((a, b) => a.y - b.y);
    if (order[0]) store.set({ selection: [order[0].id], focusRegion: { id: order[0].id, n: Date.now() } });
  };

  return (
    <div className="app" onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }} onDrop={onDrop}>
      <header className="topbar">
        <div className="brand"><span className="brand-mark">ƒ</span>FormelWerk <small>Technische Berechnungen</small></div>
        <div className="sep" />
        <div className="menu-wrap" ref={fileMenuRef}>
          <button className="btn ghost" onClick={() => setFileMenu(o => !o)} aria-haspopup="menu">Datei</button>
          {fileMenu && (
            <div className="menu" role="menu">
              <button onClick={newDoc}><IconNew />Neu</button>
              <button onClick={() => openFile()}><IconOpen />Öffnen …<kbd>Strg+O</kbd></button>
              <button onClick={() => openFile()}><IconImport />Mathcad-Datei importieren …<span className="hint">.xmcd .mcdx</span></button>
              <hr />
              <button onClick={() => save(false)}><IconSave />Speichern<kbd>Strg+S</kbd></button>
              <button onClick={() => save(true)}><IconSave />Speichern unter …</button>
              <hr />
              <button onClick={() => { setFileMenu(false); exportHtml(store.get().ws); }}><IconExport />Als HTML exportieren</button>
              <button onClick={() => { setFileMenu(false); setTimeout(() => window.print(), 50); }}><IconPrint />Drucken / als PDF<kbd>Strg+P</kbd></button>
              <hr />
              <button onClick={openExample}><IconExample />Beispiel öffnen</button>
            </div>
          )}
        </div>
        <input className="title-input" value={ws.title} aria-label="Titel des Arbeitsblatts"
          onChange={(e) => store.updateWs(w => ({ ...w, title: e.target.value }), false)} />
        {dirty && <span className="dirty-dot" title="Ungespeicherte Änderungen" />}
        <div className="spacer" />
        <button className="btn icon ghost" title="Rückgängig (Strg+Z)" onClick={() => store.undo()}><IconUndo /></button>
        <button className="btn icon ghost" title="Wiederholen (Strg+Y)" onClick={() => store.redo()}><IconRedo /></button>
        <div className="sep" />
        <button className="btn hide-narrow" onClick={() => openFile()}><IconImport />Importieren</button>
        <button className="btn primary" onClick={() => save(false)}><IconSave />Speichern</button>
        <button className="btn icon ghost" title={theme === 'dark' ? 'Helles Design' : 'Dunkles Design'} onClick={toggleTheme}>{theme === 'dark' ? <IconSun /> : <IconMoon />}</button>
        <button className="btn icon ghost" title="Kurzreferenz" onClick={() => { setSideOpen(true); setSideTab('help'); store.set({ plotEditor: null }); }}><IconHelp /></button>
        <button className={`btn icon ghost${sideOpen ? ' active' : ''}`} title="Seitenleiste ein/aus" onClick={() => setSideOpen(o => !o)}><IconPanel /></button>
      </header>
      <Ribbon />
      <div className="main" style={{ gridTemplateColumns: sideOpen || plotEditor ? '1fr auto' : '1fr' }}>
        <Sheet result={result} onOpenExample={openExample} onImport={() => openFile()} />
        {(sideOpen || plotEditor) && <SidePanel result={result} tab={sideTab} setTab={setSideTab} />}
      </div>
      <footer className="statusbar">
        <span className="status-item" aria-live="polite">
          <span className={`dot ${busy ? 'busy' : error ? 'err' : 'ok'}`} />
          {busy ? 'Berechne …' : error ? `Fehler: ${error}` : `Berechnet${result ? ` in ${result.millis} ms` : ''}`}
        </span>
        <button className="status-item" onClick={jumpToFirstError} disabled={!errorCount} title={errorCount ? 'Zum ersten Fehler springen' : ''}>
          <span className={`pill ${errorCount ? 'err' : 'ok'}`}>{errorCount ? `${errorCount} Fehler` : 'Keine Fehler'}</span>
        </button>
        {ver && (
          <button className="status-item" onClick={() => setReport(true)} title="Abgleich mit den in der Mathcad-Datei gespeicherten Ergebnissen">
            Mathcad-Abgleich <span className={`pill ${ver.mismatch ? 'warn' : 'ok'}`}>{ver.match}/{ver.total} ✓</span>
          </button>
        )}
        <span className="status-item hide-narrow">{ws.regions.length} Bereiche</span>
        <div className="spacer" />
        <span className="zoom">
          <button className="btn icon ghost" title="Verkleinern" onClick={() => store.set({ zoom: Math.max(0.5, +(zoom - 0.1).toFixed(2)) })}>−</button>
          <input type="range" min={0.5} max={2} step={0.05} value={zoom} aria-label="Zoom" onChange={(e) => store.set({ zoom: parseFloat(e.target.value) })} />
          <button className="btn icon ghost" title="Vergrößern" onClick={() => store.set({ zoom: Math.min(2, +(zoom + 0.1).toFixed(2)) })}>+</button>
          <span style={{ width: 40, textAlign: 'right' }}>{Math.round(zoom * 100)} %</span>
        </span>
      </footer>
      {report && <ImportReport result={result} busy={busy} onClose={() => setReport(false)} />}
      {toast && <div className={`toast${toast.err ? ' err' : ''}`} role="status">{toast.text}</div>}
      {dragOver && <div className="drop-overlay">Datei hier ablegen – .fwk, .xmcd oder .mcdx</div>}
    </div>
  );
}

function ImportReport({ result, busy, onClose }: { result: ReturnType<typeof useCompute>['result']; busy: boolean; onClose: () => void }) {
  const ws = useStore(s => s.ws);
  const src = ws.source;
  const ver = result?.verification;
  const mism = result ? Object.values(result.results).filter(r => r.check?.status === 'mismatch') : [];
  const math = ws.regions.filter(r => r.type === 'math') as MathRegion[];
  const notConverted = math.filter(m => m.imported?.original);
  const jump = (id: string) => { store.set({ selection: [id], focusRegion: { id, n: Date.now() } }); onClose(); };
  const pct = ver && ver.total ? Math.round(100 * ver.match / ver.total) : null;
  return (
    <div className="backdrop" onMouseDown={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="rep-title" onMouseDown={(e) => e.stopPropagation()}>
        <header><h2 id="rep-title">Import: {src?.name ?? ws.title}</h2></header>
        <div className="body">
          <p className="muted small">{src?.kind === 'mcdx' ? 'Mathcad-Prime-Dokument' : 'Mathcad-11–15-Arbeitsblatt'} – alle Formeln wurden übernommen und mit FormelWerk neu berechnet.</p>
          <div className="stat-grid">
            <div className="stat"><b>{ws.regions.length}</b><span>Bereiche</span></div>
            <div className="stat"><b>{math.length}</b><span>Formeln</span></div>
            <div className="stat"><b>{busy && !ver ? '…' : ver ? `${ver.match}/${ver.total}` : '–'}</b><span>Ergebnisse wie in Mathcad</span></div>
          </div>
          {pct !== null && <div className="bar" title={`${pct} %`}><i style={{ width: `${pct}%` }} /></div>}
          {ver && <p className="small muted">Jedes in der Datei gespeicherte Mathcad-Ergebnis wurde mit der eigenen Berechnung verglichen (Toleranz 10⁻⁴ relativ, bei iterativen Verfahren Mathcads TOL = 10⁻³). Bereiche sind mit ✓ bzw. ! markiert.</p>}
          {mism.length > 0 && (
            <>
              <h4>Abweichungen ({mism.length})</h4>
              <div className="list">
                {mism.slice(0, 50).map(r => {
                  const reg = math.find(m => m.id === r.id);
                  return (
                    <div key={r.id} className="click" onClick={() => jump(r.id)}>
                      <code>{reg?.src.split('\n')[0]}</code>
                      <span className="muted">Mathcad: {r.check!.expected} · FormelWerk: {r.error ? r.error.message : r.resultText}</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {(notConverted.length > 0 || (src?.warnings.length ?? 0) > 0) && (
            <>
              <h4>Hinweise</h4>
              <div className="list">
                {notConverted.slice(0, 30).map(m => <div key={m.id} className="click" onClick={() => jump(m.id)}><span>{m.imported!.original}</span><span className="muted small">Bereich deaktiviert übernommen</span></div>)}
                {[...new Set(src?.warnings ?? [])].filter(w => !w.startsWith('Bereich bei')).slice(0, 30).map((w, i) => <div key={i}>{w}</div>)}
              </div>
            </>
          )}
        </div>
        <footer><button className="btn primary" onClick={onClose}>Weiter</button></footer>
      </div>
    </div>
  );
}
