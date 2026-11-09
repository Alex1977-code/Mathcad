import { useEffect, useMemo, useRef, useState } from 'react';
import { emptyWorksheet, sortRegions, type MathRegion } from '../engine/model';
import { useCompute } from './compute';
import { store, useStore } from './store';
import { Sheet } from './Sheet';
import { Ribbon } from './Ribbon';
import { SidePanel } from './SidePanel';
import { ContextMenu, CommandPalette } from './Overlays';
import { autosave, exportHtml, loadAutosave, pickFile, readWorksheet, resetFileHandle, saveWorksheet } from './files';
import { exampleWorksheet } from './examples';
import {
  copySelection, duplicateSelection, paste, recalcNow, selectAll, separateAll, setAppHandlers, setZoom, showSide, toggleAutoCalc,
  toggleSide, zoomBy,
} from './actions';
import { IconImport, IconMoon, IconPanel, IconRedo, IconSave, IconSun, IconUndo } from './icons';

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
  const fileName = useStore(s => s.fileName);
  const zoom = useStore(s => s.zoom);
  const plotEditor = useStore(s => s.plotEditor);
  const sideOpen = useStore(s => s.sideOpen);
  const autoCalc = useStore(s => s.autoCalc);
  const recalcTick = useStore(s => s.recalcTick);
  const { result, busy, error, progress, recalc, computedWs } = useCompute(ws, 60, autoCalc);
  const [theme, toggleTheme] = useTheme();
  const [report, setReport] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const pendingSeparate = useRef(false);

  useEffect(() => { if (recalcTick) recalc(); }, [recalcTick]);
  const stale = !autoCalc && !!computedWs && computedWs !== ws;

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

  /* ------------------------------ file ops ----------------------------- */
  const confirmDiscard = () => !store.get().dirty || store.get().ws.regions.length === 0 || window.confirm('Ungespeicherte Änderungen verwerfen?');

  const openFile = async (file?: File | null) => {
    const f = file ?? await pickFile();
    if (!f) return;
    if (!confirmDiscard()) return;
    try {
      const doc = await readWorksheet(f);
      store.load(doc, f.name);
      if (doc.source) { pendingSeparate.current = true; setReport(true); }
      else notify(`„${f.name}“ geöffnet`);
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  const save = async (as = false) => {
    const name = await saveWorksheet(store.get().ws, as);
    if (name) { store.set({ dirty: false, fileName: name }); notify(`Gespeichert: ${name}`); }
  };
  const newDoc = () => { if (!confirmDiscard()) return; resetFileHandle(); store.load(emptyWorksheet(), null); };
  const openExample = () => { if (!confirmDiscard()) return; store.load(exampleWorksheet(), null); };

  setAppHandlers({
    openFile: () => openFile(), save: (as) => save(as), newDoc, openExample,
    exportHtml: () => exportHtml(store.get().ws), print: () => setTimeout(() => window.print(), 50),
    toggleTheme, showReport: () => setReport(true),
  });

  /* ---------------------------- shortcuts ------------------------------ */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const s = store.get();
      const k = e.key.toLowerCase();
      const inField = (e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable="true"], select');
      if (mod && k === 's') { e.preventDefault(); save(e.shiftKey); return; }
      if (mod && k === 'o') { e.preventDefault(); openFile(); return; }
      if (mod && k === 'p') { e.preventDefault(); window.print(); return; }
      if (mod && k === 'k') { e.preventDefault(); store.set({ palette: !s.palette }); return; }
      if (e.key === 'F9') { e.preventDefault(); recalcNow(); return; }
      if (e.key === 'F1') { e.preventDefault(); showSide('help'); return; }
      if (inField || s.editing) return;
      if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); return; }
      if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); store.redo(); return; }
      if (mod && k === 'a') { e.preventDefault(); selectAll(); return; }
      if (mod && k === 'c') { e.preventDefault(); copySelection(false); return; }
      if (mod && k === 'x') { e.preventDefault(); copySelection(true); return; }
      if (mod && k === 'v') { e.preventDefault(); paste(); return; }
      if (mod && k === 'd') { e.preventDefault(); duplicateSelection(); return; }
      if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomBy(0.1); return; }
      if (mod && e.key === '-') { e.preventDefault(); zoomBy(-0.1); return; }
      if (mod && e.key === '0') { e.preventDefault(); setZoom(1); return; }
    };
    window.addEventListener('keydown', onKey);
    const beforeUnload = (e: BeforeUnloadEvent) => { if (store.get().dirty && store.get().fileName) e.preventDefault(); };
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

  /* ---------------------------- status ---------------------------------- */
  const order = useMemo(() => sortRegions(ws.regions), [ws.regions]);
  const pending = useMemo(() => {
    if (!busy || !progress) return undefined;
    return new Set(order.slice(progress.done).map(r => r.id));
  }, [busy, progress, order]);
  const errorCount = result?.errorCount ?? 0;
  const mismatches = result?.verification?.mismatch ?? 0;
  const ver = result?.verification;
  const pct = progress && progress.total ? Math.round(100 * progress.done / progress.total) : null;

  return (
    <div className="app" onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }} onDrop={onDrop}>
      <header className="topbar">
        <div className="brand" title="FormelWerk – technische Berechnungen"><span className="brand-mark">ƒ</span><span className="brand-name">FormelWerk</span></div>
        <div className="qa">
          <button className="btn icon ghost" title="Speichern (Strg+S)" onClick={() => save(false)}><IconSave /></button>
          <button className="btn icon ghost" title="Rückgängig (Strg+Z)" onClick={() => store.undo()}><IconUndo /></button>
          <button className="btn icon ghost" title="Wiederholen (Strg+Y)" onClick={() => store.redo()}><IconRedo /></button>
        </div>
        <div className="doc-title">
          <input className="title-input" value={ws.title} aria-label="Titel des Arbeitsblatts" spellCheck={false}
            onChange={(e) => store.updateWs(w => ({ ...w, title: e.target.value }), false)} />
          <span className={`save-state${dirty ? ' dirty' : ''}`}>{dirty ? 'Nicht gespeichert' : fileName ? 'Gespeichert' : ''}</span>
        </div>
        <div className="spacer" />
        <button className="btn hide-narrow" onClick={() => openFile()} title="Öffnen oder Mathcad-Datei importieren (.fwk, .xmcd, .mcdx)"><IconImport />Öffnen / Importieren</button>
        <button className="btn primary" onClick={() => save(false)}><IconSave />Speichern</button>
        <button className="btn icon ghost" title={theme === 'dark' ? 'Helles Design' : 'Dunkles Design'} onClick={toggleTheme}>{theme === 'dark' ? <IconSun /> : <IconMoon />}</button>
        <button className={`btn icon ghost${sideOpen ? ' active' : ''}`} title="Seitenleiste ein/aus" onClick={toggleSide}><IconPanel /></button>
      </header>
      <Ribbon />
      <div className="main" style={{ gridTemplateColumns: sideOpen || plotEditor ? '1fr auto' : '1fr' }}>
        <Sheet result={result} onOpenExample={openExample} onImport={() => openFile()} pending={pending} />
        {(sideOpen || plotEditor) && <SidePanel result={result} />}
      </div>
      <footer className="statusbar">
        <span className="status-item calc-status" aria-live="polite">
          {busy ? (
            <><span className="spinner" />Berechne …{pct !== null && <><span className="progress"><i style={{ width: `${pct}%` }} /></span>{pct} %</>}</>
          ) : stale ? (
            <><span className="dot warn" />Nicht aktuell – <button className="linkbtn" onClick={recalcNow}>F9 berechnen</button></>
          ) : error ? (
            <><span className="dot err" />Fehler: {error}</>
          ) : (
            <><span className="dot ok" />Berechnet{result ? ` · ${result.millis} ms` : ''}</>
          )}
        </span>
        <button className={`status-item calc-mode${autoCalc ? '' : ' off'}`} onClick={toggleAutoCalc} title="Automatische Berechnung ein/aus">{autoCalc ? 'Automatisch' : 'Manuell'}</button>
        <span className="sep" />
        <button className="status-item" onClick={() => showSide('problems')} title="Probleme anzeigen">
          <span className={`pill ${errorCount ? 'err' : 'ok'}`}>{errorCount ? `${errorCount} Fehler` : 'Keine Fehler'}</span>
          {mismatches > 0 && <span className="pill warn">{mismatches} Abweichung{mismatches === 1 ? '' : 'en'}</span>}
        </button>
        {ver && (
          <button className="status-item" onClick={() => setReport(true)} title="Abgleich mit den in der Mathcad-Datei gespeicherten Ergebnissen">
            Mathcad-Abgleich <span className={`pill ${ver.mismatch ? 'warn' : 'ok'}`}>{ver.match}/{ver.total} ✓</span>
          </button>
        )}
        <span className="status-item hide-narrow">{ws.regions.length} Bereiche</span>
        <div className="spacer" />
        <span className="status-item hide-narrow muted">{ws.settings.decimals} Nachkommastellen · {ws.settings.decimalComma ? 'Komma' : 'Punkt'}</span>
        <span className="zoom">
          <button className="btn icon ghost" title="Verkleinern" onClick={() => zoomBy(-0.1)}>−</button>
          <input type="range" min={0.5} max={2} step={0.05} value={zoom} aria-label="Zoom" onChange={(e) => setZoom(parseFloat(e.target.value))} />
          <button className="btn icon ghost" title="Vergrößern" onClick={() => zoomBy(0.1)}>+</button>
          <button className="zoom-val" title="Zoom 100 %" onClick={() => setZoom(1)}>{Math.round(zoom * 100)} %</button>
        </span>
      </footer>
      {report && <ImportReport result={result} busy={busy} onClose={() => setReport(false)} />}
      <ContextMenu />
      <CommandPalette />
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
