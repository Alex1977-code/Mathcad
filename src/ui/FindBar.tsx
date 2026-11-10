import { useEffect, useMemo, useRef, useState } from 'react';
import { store, useStore } from './store';
import { findMatches, replaceAll, replaceInRegion, type FindOptions } from './findReplace';
import { readPref, writePref } from './store';

/** Find (Ctrl+F) and replace (Ctrl+H) over formulas and texts. */
export function FindBar() {
  const find = useStore(s => s.find);
  const ws = useStore(s => s.ws);
  const [q, setQ] = useState<string>(() => readPref('findQuery', ''));
  const [r, setR] = useState('');
  const [opt, setOpt] = useState<FindOptions>(() => readPref('findOpts', {}));
  const [idx, setIdx] = useState(0);
  const [note, setNote] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => (find ? findMatches(ws, q, opt) : []), [find, ws, q, opt.caseSensitive, opt.wholeWord]);

  useEffect(() => { if (find) setTimeout(() => { input.current?.focus(); input.current?.select(); }, 0); }, [find]);
  useEffect(() => { writePref('findQuery', q); setIdx(0); setNote(''); }, [q]);
  useEffect(() => { writePref('findOpts', opt); }, [opt]);
  // keep the current match visible and selected
  const cur = matches.length ? matches[Math.min(idx, matches.length - 1)] : undefined;
  useEffect(() => {
    if (!find || !cur) return;
    store.set({ selection: [cur.regionId], focusRegion: { id: cur.regionId, n: Date.now() } });
  }, [find, cur?.regionId, cur?.index]);
  if (!find) return null;

  const close = () => { store.set({ find: null }); (document.querySelector('.scroller') as HTMLElement | null)?.focus({ preventScroll: true }); };
  const step = (d: number) => { if (matches.length) setIdx(i => (Math.min(i, matches.length - 1) + d + matches.length) % matches.length); };
  const replaceOne = () => {
    if (!cur) return;
    const region = ws.regions.find(x => x.id === cur.regionId);
    if (!region) return;
    const res = replaceInRegion(region, q, r, opt, cur.index);
    if (res.count) store.updateRegion(region.id, res.region);
    setNote(res.count ? '1 ersetzt' : '');
  };
  const replaceEvery = () => {
    const res = replaceAll(store.get().ws, q, r, opt);
    if (res.count) store.updateWs(() => res.ws);
    setNote(res.count ? `${res.count} ersetzt` : 'Nichts gefunden');
  };
  const toggle = (k: keyof FindOptions, label: string, title: string) => (
    <button className={`fb-opt${opt[k] ? ' on' : ''}`} aria-pressed={!!opt[k]} title={title} onClick={() => setOpt(o => ({ ...o, [k]: !o[k] }))}>{label}</button>
  );
  const keys = (e: React.KeyboardEvent, isReplace = false) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && isReplace) { e.preventDefault(); if (e.ctrlKey || e.metaKey) replaceEvery(); else replaceOne(); }
    else if (e.key === 'Enter' || e.key === 'F3') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') { e.preventDefault(); store.set({ find: { replace: !find.replace } }); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); input.current?.select(); }
  };
  return (
    <div className="findbar" role="search" onMouseDown={(e) => e.stopPropagation()}>
      <div className="fb-row">
        <button className="fb-twist" title={find.replace ? 'Ersetzen ausblenden' : 'Ersetzen (Strg+H)'} aria-expanded={find.replace} onClick={() => store.set({ find: { replace: !find.replace } })}>{find.replace ? '▾' : '▸'}</button>
        <input ref={input} value={q} placeholder="Suchen in Formeln und Texten" aria-label="Suchen" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => keys(e)} />
        {toggle('caseSensitive', 'Aa', 'Groß-/Kleinschreibung beachten')}
        {toggle('wholeWord', 'ab|', 'Nur ganze Wörter')}
        <span className="fb-count" aria-live="polite">{q ? (matches.length ? `${Math.min(idx, matches.length - 1) + 1} von ${matches.length}` : 'Keine Treffer') : ''}</span>
        <button title="Vorheriger Treffer (Umschalt+Enter)" onClick={() => step(-1)} disabled={!matches.length}>↑</button>
        <button title="Nächster Treffer (Enter)" onClick={() => step(1)} disabled={!matches.length}>↓</button>
        <button title="Schließen (Esc)" onClick={close}>✕</button>
      </div>
      {find.replace && (
        <div className="fb-row">
          <span className="fb-twist" />
          <input value={r} placeholder="Ersetzen durch" aria-label="Ersetzen durch" onChange={(e) => setR(e.target.value)} onKeyDown={(e) => keys(e, true)} />
          <button className="fb-wide" title="Diesen Treffer ersetzen (Enter)" onClick={replaceOne} disabled={!cur}>Ersetzen</button>
          <button className="fb-wide" title="Alle ersetzen (Strg+Enter) – ein Rückgängig-Schritt" onClick={replaceEvery} disabled={!matches.length}>Alle</button>
          <span className="fb-count">{note}</span>
        </div>
      )}
      {cur && (
        <div className="fb-ctx" title={cur.kind === 'math' ? 'Formel' : 'Text'}>
          <span className="fb-kind">{cur.kind === 'math' ? 'Formel' : 'Text'}</span>
          <span>{cur.before}<mark>{cur.hit}</mark>{cur.after}</span>
        </div>
      )}
    </div>
  );
}
