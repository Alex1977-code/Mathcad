import { useState } from 'react';
import type { PlotRegion, PlotTrace } from '../engine/model';
import type { ComputeResult } from '../engine/worksheet';
import { nameLatex } from '../engine/latex';
import { renderLatex } from './katex';
import { store, useStore } from './store';
import { PLOT_COLORS } from './regions/PlotRegionView';
import { IconCheck, IconClose, IconPlus, IconTrash } from './icons';
import { sortRegions } from '../engine/model';

export type SideTab = 'vars' | 'problems' | 'outline' | 'format' | 'help';

export function SidePanel({ result }: { result: ComputeResult | null }) {
  const plotEditor = useStore(s => s.plotEditor);
  const tab = useStore(s => s.sideTab);
  const plot = useStore(s => s.ws.regions.find(r => r.id === s.plotEditor && r.type === 'plot') as PlotRegion | undefined);
  if (plotEditor && plot) return <aside className="side"><PlotEditor region={plot} result={result} /></aside>;
  const problems = result ? Object.values(result.results).filter(r => r.error || r.plot?.error || r.check?.status === 'mismatch').length : 0;
  const setTab = (t: SideTab) => store.set({ sideTab: t });
  return (
    <aside className="side">
      <div className="side-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'vars'} className={tab === 'vars' ? 'on' : ''} onClick={() => setTab('vars')}>Variablen</button>
        <button role="tab" aria-selected={tab === 'problems'} className={tab === 'problems' ? 'on' : ''} onClick={() => setTab('problems')}>
          Probleme{problems > 0 && <span className="count">{problems}</span>}
        </button>
        <button role="tab" aria-selected={tab === 'outline'} className={tab === 'outline' ? 'on' : ''} onClick={() => setTab('outline')}>Gliederung</button>
        <button role="tab" aria-selected={tab === 'help' || tab === 'format'} className={tab === 'help' || tab === 'format' ? 'on' : ''} onClick={() => setTab('help')}>Hilfe</button>
        <span className="spacer" />
        <button className="side-close" title="Seitenleiste schließen" onClick={() => store.set({ sideOpen: false })}><IconClose /></button>
      </div>
      <div className="side-body">
        {tab === 'vars' && <Variables result={result} />}
        {tab === 'problems' && <Problems result={result} />}
        {tab === 'outline' && <Outline />}
        {(tab === 'help' || tab === 'format') && <Help />}
      </div>
    </aside>
  );
}

const jump = (id: string) => store.set({ selection: [id], focusRegion: { id, n: Date.now() } });

function Problems({ result }: { result: ComputeResult | null }) {
  const regions = useStore(s => s.ws.regions);
  if (!result) return <div className="empty-hint">Wird berechnet …</div>;
  const order = sortRegions(regions);
  const items = order.map(r => ({ r, res: result.results[r.id] })).filter(({ res }) => res && (res.error || res.plot?.error || res.check?.status === 'mismatch'));
  if (!items.length) return <div className="ok-hint"><IconCheck />Keine Fehler{result.verification ? ` – alle ${result.verification.total} Mathcad-Ergebnisse stimmen überein` : ''}.</div>;
  return (
    <div className="problems">
      {items.map(({ r, res }) => {
        const src = r.type === 'math' ? r.src.split('\n')[0] : r.type === 'plot' ? 'Diagramm' : r.type;
        const isErr = !!(res!.error || res!.plot?.error);
        return (
          <button key={r.id} className={`problem ${isErr ? 'err' : 'warn'}`} onClick={() => jump(r.id)} title="Zum Bereich springen">
            <span className="pico">{isErr ? '✕' : '!'}</span>
            <span className="ptext">
              <code>{src}</code>
              <span>{res!.error?.message ?? res!.plot?.error ?? `Mathcad: ${res!.check!.expected} · FormelWerk: ${res!.resultText ?? '–'}`}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Outline() {
  const regions = useStore(s => s.ws.regions);
  const items: { id: string; level: number; text: string }[] = [];
  for (const r of sortRegions(regions)) {
    if (r.type !== 'text') continue;
    const doc = new DOMParser().parseFromString(r.html, 'text/html');
    doc.querySelectorAll('h1, h2, h3').forEach(h => {
      const text = (h.textContent ?? '').trim();
      if (text) items.push({ id: r.id, level: h.tagName === 'H3' ? 2 : 1, text });
    });
  }
  if (!items.length) return <div className="empty-hint">Keine Überschriften. Überschriften in Textbereichen (Schaltfläche „H“ beim Bearbeiten) erscheinen hier als Inhaltsverzeichnis.</div>;
  return (
    <div className="outline">
      {items.map((it, i) => <button key={i} className={`lvl${it.level}`} onClick={() => jump(it.id)}>{it.text}</button>)}
    </div>
  );
}

function Variables({ result }: { result: ComputeResult | null }) {
  const [q, setQ] = useState('');
  const vars = (result?.variables ?? []).filter(v => !q || v.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <input className="search" placeholder="Variablen suchen …" value={q} onChange={(e) => setQ(e.target.value)} />
      {!vars.length && <div className="empty-hint">{q ? 'Keine Treffer.' : 'Noch keine Variablen definiert. Definitionen wie a := 5 m erscheinen hier mit ihrem aktuellen Wert.'}</div>}
      {vars.map(v => (
        <div key={v.name} className="var-item" title="Zur Definition springen"
          onClick={() => v.regionId && store.set({ selection: [v.regionId], focusRegion: { id: v.regionId, n: Date.now() } })}>
          <span className="var-name" dangerouslySetInnerHTML={{ __html: renderLatex(nameLatex(v.name)) }} />
          <span className="var-kind">{v.kind}</span>
          <span className="var-val" title={v.text}>{v.text}</span>
        </div>
      ))}
    </>
  );
}

function PlotEditor({ region, result }: { region: PlotRegion; result: ComputeResult | null }) {
  // no undo step per keystroke: the store records one step for the whole plot editing session
  const upd = (patch: Partial<PlotRegion>) => store.updateRegion(region.id, patch, false);
  const setTrace = (i: number, patch: Partial<PlotTrace>) => upd({ traces: region.traces.map((t, k) => (k === i ? { ...t, ...patch } : t)) });
  const err = result?.results[region.id]?.plot?.error;
  return (
    <div className="side-body">
      <div className="panel-title">
        Diagramm bearbeiten
        <span className="spacer" />
        <button className="btn icon ghost" title="Schließen" onClick={() => store.set({ plotEditor: null })}><IconClose /></button>
      </div>
      <div className="field">
        <label>Titel</label>
        <input value={region.title ?? ''} placeholder="optional" onChange={(e) => upd({ title: e.target.value })} />
      </div>
      {region.traces.map((t, i) => (
        <div key={i} className="trace-card">
          <div className="trace-head">
            <input type="color" value={t.color ?? PLOT_COLORS[i % PLOT_COLORS.length]} onChange={(e) => setTrace(i, { color: e.target.value })} title="Farbe" />
            Kurve {i + 1}
            <span className="spacer" />
            <select value={t.style ?? 'line'} onChange={(e) => setTrace(i, { style: e.target.value as PlotTrace['style'] })}>
              <option value="line">Linie</option><option value="points">Punkte</option><option value="both">Linie + Punkte</option>
            </select>
            {region.traces.length > 1 && <button className="btn icon ghost" title="Kurve entfernen" onClick={() => upd({ traces: region.traces.filter((_, k) => k !== i) })}><IconTrash /></button>}
          </div>
          <div className="field row">
            <div className="field"><label>x-Ausdruck</label><input value={t.x} placeholder="x" spellCheck={false} onChange={(e) => setTrace(i, { x: e.target.value })} /></div>
            <div className="field"><label>y-Ausdruck</label><input value={t.y} placeholder="z. B. sin(x)" spellCheck={false} onChange={(e) => setTrace(i, { y: e.target.value })} /></div>
          </div>
        </div>
      ))}
      <button className="btn" onClick={() => upd({ traces: [...region.traces, { x: region.traces[0]?.x ?? 'x', y: '' }] })}><IconPlus />Kurve hinzufügen</button>
      <div className="panel-title" style={{ marginTop: 16 }}>Achsen</div>
      <div className="field row">
        <div className="field"><label>x von</label><input value={region.xmin ?? ''} placeholder="auto" onChange={(e) => upd({ xmin: e.target.value })} /></div>
        <div className="field"><label>x bis</label><input value={region.xmax ?? ''} placeholder="auto" onChange={(e) => upd({ xmax: e.target.value })} /></div>
      </div>
      <div className="field row">
        <div className="field"><label>y von</label><input value={region.ymin ?? ''} placeholder="auto" onChange={(e) => upd({ ymin: e.target.value })} /></div>
        <div className="field"><label>y bis</label><input value={region.ymax ?? ''} placeholder="auto" onChange={(e) => upd({ ymax: e.target.value })} /></div>
      </div>
      <div className="field row">
        <div className="field"><label>Einheit x</label><input value={region.xUnit ?? ''} placeholder="z. B. m" onChange={(e) => upd({ xUnit: e.target.value })} /></div>
        <div className="field"><label>Einheit y</label><input value={region.yUnit ?? ''} placeholder="z. B. kN*m" onChange={(e) => upd({ yUnit: e.target.value })} /></div>
      </div>
      <label className="check"><input type="checkbox" checked={!!region.logX} onChange={(e) => upd({ logX: e.target.checked })} />x logarithmisch</label>
      <label className="check"><input type="checkbox" checked={!!region.logY} onChange={(e) => upd({ logY: e.target.checked })} />y logarithmisch</label>
      {err && <div className="plot-error" style={{ marginTop: 10 }}>⚠ {err}</div>}
      <p className="empty-hint">
        Ist die x-Variable nicht definiert, wird sie automatisch zwischen „x von“ und „x bis“ abgetastet (Schnelldiagramm).
        Bereichsvariablen (<code>i := 0..10</code>) und Vektoren werden direkt gezeichnet.
      </p>
    </div>
  );
}

const HELP: [string, string][] = [
  ['a := 5 m', 'Definition (Taste : fügt := ein)'],
  ['a =', 'Ergebnis anzeigen'],
  ['F = kN', 'Ergebnis in Wunscheinheit'],
  ['b := 2 a = cm', 'Definieren und anzeigen'],
  ['g ≡ 9.81 m/s^2', 'Globale Definition (Taste ~)'],
  ['f(x) := x^2 + 1', 'Funktion'],
  ['F_max', 'Index im Namen (Unterstrich)'],
  ['v[2]  A[1, 0]', 'Vektor-/Matrixelement (ORIGIN 0)'],
  ['[1, 2; 3, 4]', 'Matrix (, Spalten · ; Zeilen)'],
  ['A^T  A^-1  |A|', 'Transponierte, Inverse, Determinante'],
  ['A<<1>>', 'Spalte einer Matrix'],
  ['i := 0..10', 'Bereichsvariable'],
  ['x := 0, 0.1 .. 1', 'Bereich mit Schrittweite'],
  ['sum(i^2, i, 1, n)', 'Summe Σ'],
  ['int(f(x), x, 0, 1)', 'Bestimmtes Integral'],
  ['deriv(f(x), x)', 'Ableitung an der Stelle x'],
  ['root(f(x), x)', 'Nullstelle (Startwert x definieren)'],
  ['Given … Find(x, y)', 'Gleichungssystem (Bedingungen mit ==)'],
  ['vec(a*b)', 'Elementweise Rechnung'],
  ['1.5e-3   2 + 3i', 'Exponent, komplexe Zahl'],
  ['"Text"', 'Zeichenkette / neuer Textbereich'],
  ["'m", 'Einheit erzwingen (falls Variable m existiert)'],
];

function Help() {
  return (
    <div className="help">
      <p>Klicken Sie auf das Blatt und tippen Sie. <kbd>Enter</kbd> schließt eine Formel ab, das rote Kreuz springt darunter.</p>
      <table><tbody>{HELP.map(([a, b]) => <tr key={a}><td>{a}</td><td>{b}</td></tr>)}</tbody></table>
      <h4>Programme (mehrzeilig)</h4>
      <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-sunken)', padding: 8, borderRadius: 7, border: '1px solid var(--border)' }}>{`f(x) :=
  if x < 0
    -x
  else
    x`}</pre>
      <p>Weitere Anweisungen: <code>for i ∈ 1..n</code>, <code>while</code>, <code>return</code>, <code>break</code>, lokale Zuweisung mit <code>←</code> (oder <code>&lt;-</code>).</p>
      <h4>Tastenkürzel</h4>
      <table><tbody>
        <tr><td>Strg+G</td><td>Buchstabe → griechisch (a → α)</td></tr>
        <tr><td>\alpha + Leer</td><td>α (auch \Delta, \sum …)</td></tr>
        <tr><td>Tab</td><td>Vorschlag übernehmen / nächster Platzhalter</td></tr>
        <tr><td>Klick aufs Ergebnis</td><td>Einheit wählen, kopieren, Stellen ±</td></tr>
        <tr><td>Rechtsklick</td><td>Diagramm von f(x), Gleichung lösen, Wert anzeigen</td></tr>
        <tr><td>@ · $ · &amp;</td><td>Diagramm · Summe · Integral</td></tr>
        <tr><td>Strg+M</td><td>Matrix 3×3</td></tr>
        <tr><td>Strg+Z / Strg+Y</td><td>Rückgängig / Wiederholen</td></tr>
        <tr><td>Strg+C/X/V/D</td><td>Kopieren, Ausschneiden, Einfügen, Duplizieren</td></tr>
        <tr><td>Pfeiltasten</td><td>Auswahl oder Kreuz verschieben</td></tr>
        <tr><td>Strg+S / Strg+O</td><td>Speichern / Öffnen</td></tr>
      </tbody></table>
      <h4>Mathcad-Dateien</h4>
      <p>Importiert werden Mathcad 11–15 (<code>.xmcd</code>) und Mathcad Prime (<code>.mcdx</code>). Gespeicherte Mathcad-Ergebnisse werden mit der eigenen Berechnung verglichen (✓ / ! am Bereich). Alte <code>.mcd</code>-Dateien bitte in Mathcad als .xmcd speichern.</p>
    </div>
  );
}
