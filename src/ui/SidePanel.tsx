import { useState } from 'react';
import type { PlotRegion, PlotTrace } from '../engine/model';
import type { ComputeResult } from '../engine/worksheet';
import { nameLatex } from '../engine/latex';
import { renderLatex } from './katex';
import { store, useStore } from './store';
import { PLOT_COLORS } from './regions/PlotRegionView';
import { IconClose, IconPlus, IconTrash } from './icons';

export type SideTab = 'vars' | 'format' | 'help';

export function SidePanel({ result, tab, setTab }: { result: ComputeResult | null; tab: SideTab; setTab: (t: SideTab) => void }) {
  const plotEditor = useStore(s => s.plotEditor);
  const plot = useStore(s => s.ws.regions.find(r => r.id === s.plotEditor && r.type === 'plot') as PlotRegion | undefined);
  if (plotEditor && plot) return <aside className="side"><PlotEditor region={plot} result={result} /></aside>;
  return (
    <aside className="side">
      <div className="side-tabs" role="tablist">
        <button role="tab" className={tab === 'vars' ? 'on' : ''} onClick={() => setTab('vars')}>Variablen</button>
        <button role="tab" className={tab === 'format' ? 'on' : ''} onClick={() => setTab('format')}>Format</button>
        <button role="tab" className={tab === 'help' ? 'on' : ''} onClick={() => setTab('help')}>Kurzreferenz</button>
      </div>
      <div className="side-body">
        {tab === 'vars' && <Variables result={result} />}
        {tab === 'format' && <FormatSettings />}
        {tab === 'help' && <Help />}
      </div>
    </aside>
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

function FormatSettings() {
  const settings = useStore(s => s.ws.settings);
  const showChecks = useStore(s => s.showChecks);
  const hasImport = useStore(s => !!s.ws.source);
  return (
    <>
      <div className="panel-title">Ergebnisformat</div>
      <div className="field">
        <label htmlFor="dec">Nachkommastellen</label>
        <input id="dec" type="number" min={0} max={12} value={settings.decimals}
          onChange={(e) => store.setSettings({ decimals: Math.max(0, Math.min(12, parseInt(e.target.value || '0', 10))) })} />
      </div>
      <div className="field">
        <label htmlFor="exp">Exponentialdarstellung ab 10^n</label>
        <input id="exp" type="number" min={1} max={15} value={settings.expThreshold}
          onChange={(e) => store.setSettings({ expThreshold: Math.max(1, Math.min(15, parseInt(e.target.value || '7', 10))) })} />
      </div>
      <div className="field">
        <label htmlFor="origin">Startindex von Vektoren (ORIGIN)</label>
        <select id="origin" value={settings.origin} onChange={(e) => store.setSettings({ origin: parseInt(e.target.value, 10) })}>
          <option value={0}>0 (Mathcad-Standard)</option>
          <option value={1}>1</option>
        </select>
      </div>
      <div className="panel-title" style={{ marginTop: 18 }}>Darstellung</div>
      <div className="field">
        <label htmlFor="fs">Schriftgröße der Formeln: {settings.fontSize ?? 15} px</label>
        <input id="fs" type="range" min={10} max={22} step={0.5} value={settings.fontSize ?? 15}
          onChange={(e) => store.setSettings({ fontSize: parseFloat(e.target.value) })} />
      </div>
      {hasImport && (
        <label className="check">
          <input type="checkbox" checked={showChecks} onChange={(e) => store.set({ showChecks: e.target.checked })} />
          Abgleich mit Mathcad-Ergebnissen anzeigen
        </label>
      )}
      <p className="empty-hint">Eine Anzeigeeinheit pro Ergebnis wählen Sie direkt in der Formel: <code>M = kN*m</code></p>
    </>
  );
}

function PlotEditor({ region, result }: { region: PlotRegion; result: ComputeResult | null }) {
  const upd = (patch: Partial<PlotRegion>) => store.updateRegion(region.id, patch);
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
        <tr><td>Tab</td><td>Vorschlag übernehmen</td></tr>
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
