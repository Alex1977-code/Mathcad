import { useEffect, useState } from 'react';
import { store, useStore } from './store';
import { DEFAULT_PAGE_INFO, PLACEHOLDERS, fillTemplate, pageVars } from '../engine/pageinfo';
import type { PageInfo } from '../engine/model';

type Three = [string, string, string];

/** Header, footer and project data for print, PDF and Word. */
export function PageSetupDialog() {
  const open = useStore(s => s.pageSetup);
  const ws = useStore(s => s.ws);
  const fileName = useStore(s => s.fileName);
  const [p, setP] = useState<Required<PageInfo>>({ project: '', author: '', header: DEFAULT_PAGE_INFO.header, footer: DEFAULT_PAGE_INFO.footer });
  const [title, setTitle] = useState('');
  useEffect(() => {
    if (!open) return;
    const cur = ws.settings.page ?? {};
    setP({ project: cur.project ?? '', author: cur.author ?? '', header: (cur.header ?? DEFAULT_PAGE_INFO.header).slice() as Three, footer: (cur.footer ?? DEFAULT_PAGE_INFO.footer).slice() as Three });
    setTitle(ws.title ?? '');
  }, [open]);
  if (!open) return null;
  const close = () => store.set({ pageSetup: false });
  const apply = () => {
    store.updateWs(w => ({ ...w, title: title.trim() || w.title, settings: { ...w.settings, page: { ...(p.project ? { project: p.project } : {}), ...(p.author ? { author: p.author } : {}), header: p.header, footer: p.footer } } }));
    close();
  };
  const setPart = (kind: 'header' | 'footer', i: number, v: string) => setP(q => { const t = q[kind].slice() as Three; t[i] = v; return { ...q, [kind]: t }; });
  const vars = { ...pageVars({ ...ws, title, settings: { ...ws.settings, page: p } }, fileName) };
  const preview = (t: Three) => t.map(x => fillTemplate(x, vars, 1, 3));
  const row = (kind: 'header' | 'footer', label: string) => (
    <div className="ps-row">
      <span className="ps-label">{label}</span>
      {(['links', 'Mitte', 'rechts'] as const).map((pos, i) => (
        <input key={pos} aria-label={`${label} ${pos}`} placeholder={pos} value={p[kind][i]} onChange={(e) => setPart(kind, i, e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      ))}
    </div>
  );
  return (
    <div className="backdrop" onMouseDown={close}>
      <div className="dialog page-setup" role="dialog" aria-modal="true" aria-labelledby="ps-title" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') apply(); }}>
        <header><h2 id="ps-title">Kopf- und Fußzeile</h2></header>
        <div className="body">
          <div className="ps-fields">
            <label>Titel<input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></label>
            <label>Projekt<input value={p.project} placeholder="z. B. Neubau Halle 3" onChange={(e) => setP(q => ({ ...q, project: e.target.value }))} onKeyDown={(e) => e.stopPropagation()} /></label>
            <label>Bearbeiter<input value={p.author} placeholder="Name" onChange={(e) => setP(q => ({ ...q, author: e.target.value }))} onKeyDown={(e) => e.stopPropagation()} /></label>
          </div>
          {row('header', 'Kopfzeile')}
          {row('footer', 'Fußzeile')}
          <p className="small muted">Platzhalter: {PLACEHOLDERS.map(([k, d]) => <code key={k} title={d} className="ps-ph" onClick={() => navigator.clipboard?.writeText(k).catch(() => undefined)}>{k}</code>)}</p>
          <div className="ps-preview" aria-label="Vorschau">
            <div className="ps-line top">{preview(p.header).map((t, i) => <span key={i}>{t}</span>)}</div>
            <div className="ps-sheet">Seite 1 von 3</div>
            <div className="ps-line">{preview(p.footer).map((t, i) => <span key={i}>{t}</span>)}</div>
          </div>
        </div>
        <footer>
          <button className="btn" onClick={() => setP(q => ({ ...q, header: DEFAULT_PAGE_INFO.header.slice() as Three, footer: DEFAULT_PAGE_INFO.footer.slice() as Three }))}>Standard</button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={close}>Abbrechen</button>
          <button className="btn primary" onClick={apply}>Übernehmen</button>
        </footer>
      </div>
    </div>
  );
}
