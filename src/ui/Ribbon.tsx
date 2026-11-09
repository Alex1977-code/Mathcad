import { useEffect, useRef, useState, type ReactNode } from 'react';
import { newId, sortRegions, type Region } from '../engine/model';
import { COMMON_UNITS } from '../engine/units';
import { renderLatex } from './katex';
import { store } from './store';
import { getActiveEditor } from './editing';
import { MARGIN, regionElements, separateRegions, snap } from './layout';
import { newMathRegion } from './Sheet';
import {
  IconAlignLeft, IconAlignTop, IconBreak, IconChart, IconChevron, IconImage, IconMath, IconSeparate, IconText, IconTrash,
} from './icons';
import { pickFile } from './files';

/** Insert a snippet into the active formula or start a new formula with it. */
export function insertSnippet(snippet: string) {
  const ed = getActiveEditor();
  if (ed) { ed.insert(snippet); return; }
  const s = store.get();
  const cur = s.cursor ?? { x: MARGIN, y: MARGIN };
  if (s.editing) return;
  store.addRegion(newMathRegion(cur.x, cur.y, snippet), true);
  store.set({ editOriginal: '' });
}

export function insertRegion(kind: 'math' | 'text' | 'plot' | 'pagebreak') {
  const s = store.get();
  const cur = s.cursor ?? { x: MARGIN, y: MARGIN };
  if (kind === 'math') store.addRegion(newMathRegion(cur.x, cur.y), true);
  else if (kind === 'text') store.addRegion({ id: newId(), type: 'text', x: cur.x, y: cur.y, w: 380, html: '' }, true);
  else if (kind === 'plot') {
    const r: Region = { id: newId(), type: 'plot', x: cur.x, y: cur.y, w: 440, h: 270, traces: [{ x: 'x', y: '' }], xmin: '-10', xmax: '10' };
    store.addRegion(r);
    store.set({ plotEditor: r.id, cursor: { x: cur.x, y: snap(cur.y + 290) } });
  } else {
    store.addRegion({ id: newId(), type: 'pagebreak', x: 0, y: cur.y });
    store.set({ cursor: { x: cur.x, y: cur.y + 30 } });
  }
}

export async function insertImage() {
  const f = await pickFile('image/*');
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    const s = store.get();
    const cur = s.cursor ?? { x: MARGIN, y: MARGIN };
    const img = new Image();
    img.onload = () => {
      const w = Math.min(img.width, 600);
      store.addRegion({ id: newId(), type: 'image', x: cur.x, y: cur.y, w, src: String(reader.result), alt: f.name });
    };
    img.src = String(reader.result);
  };
  reader.readAsDataURL(f);
}

export function alignSelection(dir: 'left' | 'top') {
  const s = store.get();
  const sel = s.ws.regions.filter(r => s.selection.includes(r.id));
  if (sel.length < 2) return;
  const v = dir === 'left' ? Math.min(...sel.map(r => r.x)) : Math.min(...sel.map(r => r.y));
  store.updateWs(ws => ({ ...ws, regions: ws.regions.map(r => (s.selection.includes(r.id) ? { ...r, [dir === 'left' ? 'x' : 'y']: v } as Region : r)) }));
}

export function separateAll(history = true) {
  const s = store.get();
  const next = separateRegions(sortRegions(s.ws.regions), (r) => {
    const el = regionElements.get(r.id);
    return el ? { x: r.x, y: r.y, w: el.offsetWidth, h: el.offsetHeight } : null;
  });
  const byId = new Map(next.map(r => [r.id, r]));
  store.updateWs(ws => ({ ...ws, regions: ws.regions.map(r => byId.get(r.id) ?? r) }), history);
}

const tex = (l: string) => <span dangerouslySetInnerHTML={{ __html: renderLatex(l) }} />;

function RB({ title, onClick, children, big }: { title: string; onClick: () => void; children: ReactNode; big?: boolean }) {
  return (
    <button className={`rbtn${big ? ' big' : ''}`} title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{children}</button>
  );
}

function Dropdown({ label, title, children }: { label: ReactNode; title: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="rbtn" title={title} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(o => !o)}>{label}<IconChevron /></button>
      {open && <div className="menu" onMouseDown={(e) => e.preventDefault()}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

const GREEK = 'αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ∞°';

function Group({ label, children }: { label: string; children: ReactNode }) {
  return <div className="rgroup"><div className="rgroup-items">{children}</div><div className="rgroup-label">{label}</div></div>;
}

export function Ribbon() {
  return (
    <div className="ribbon" role="toolbar" aria-label="Werkzeuge">
      <Group label="Einfügen">
        <RB big title="Formel einfügen (oder einfach auf das Blatt klicken und tippen)" onClick={() => insertRegion('math')}><IconMath />Formel</RB>
        <RB big title="Text einfügen (Taste &quot;)" onClick={() => insertRegion('text')}><IconText />Text</RB>
        <RB big title="Diagramm einfügen" onClick={() => insertRegion('plot')}><IconChart />Diagramm</RB>
        <Dropdown title="Weitere Elemente" label={<IconImage />}>
          {(close) => (
            <>
              <button onClick={() => { close(); insertImage(); }}><IconImage />Bild einfügen …</button>
              <button onClick={() => { close(); insertRegion('pagebreak'); }}><IconBreak />Seitenumbruch</button>
            </>
          )}
        </Dropdown>
      </Group>
      <Group label="Rechnen">
        <RB title="Definition  :=  (Taste :)" onClick={() => insertSnippet(' := ')}>{tex('\\coloneqq')}</RB>
        <RB title="Auswerten  =" onClick={() => insertSnippet(' =')}>{tex('=')}</RB>
        <RB title="Globale Definition  ≡  (Taste ~)" onClick={() => insertSnippet(' ≡ ')}>{tex('\\equiv')}</RB>
        <RB title="Bruch" onClick={() => insertSnippet('(?)/(?)')}>{tex('\\tfrac{a}{b}')}</RB>
        <RB title="Quadrat" onClick={() => insertSnippet('^2')}>{tex('x^2')}</RB>
        <RB title="Quadratwurzel" onClick={() => insertSnippet('√(?)')}>{tex('\\sqrt{x}')}</RB>
        <RB title="n-te Wurzel" onClick={() => insertSnippet('nthroot(?, ?)')}>{tex('\\sqrt[n]{x}')}</RB>
        <RB title="Betrag / Determinante" onClick={() => insertSnippet('|?|')}>{tex('|x|')}</RB>
      </Group>
      <Group label="Analysis">
        <RB title="Summe  sum(Ausdruck, i, Start, Ende)" onClick={() => insertSnippet('sum(?, i, 1, n)')}>{tex('\\sum')}</RB>
        <RB title="Produkt" onClick={() => insertSnippet('prod(?, i, 1, n)')}>{tex('\\prod')}</RB>
        <RB title="Bestimmtes Integral  int(f, x, a, b)" onClick={() => insertSnippet('int(?, x, a, b)')}>{tex('\\int')}</RB>
        <RB title="Ableitung an der Stelle x  deriv(f, x)" onClick={() => insertSnippet('deriv(?, x)')}>{tex('\\tfrac{d}{dx}')}</RB>
        <RB title="Nullstelle  root(f(x), x)" onClick={() => insertSnippet('root(?, x)')}>root</RB>
        <RB title="Bereichsvariable  i := 0..10" onClick={() => insertSnippet('0..?')}>{tex('m..n')}</RB>
      </Group>
      <Group label="Matrix">
        <RB title="Matrix 2×2 ( , trennt Spalten · ; trennt Zeilen )" onClick={() => insertSnippet('[?, ?; ?, ?]')}>{tex('\\begin{bmatrix}\\cdot&\\cdot\\\\\\cdot&\\cdot\\end{bmatrix}')}</RB>
        <RB title="Spaltenvektor" onClick={() => insertSnippet('[?; ?; ?]')}>{tex('\\begin{bmatrix}\\cdot\\\\\\cdot\\end{bmatrix}')}</RB>
        <RB title="Transponieren" onClick={() => insertSnippet('^T')}>{tex('A^{\\mathsf T}')}</RB>
        <RB title="Inverse" onClick={() => insertSnippet('^-1')}>{tex('A^{-1}')}</RB>
        <Dropdown title="Weitere Matrixoperationen" label={tex('\\times')}>
          {(close) => (
            <>
              <button onClick={() => { insertSnippet(' × '); close(); }}>{tex('a\\times b')}<span>Kreuzprodukt</span></button>
              <button onClick={() => { insertSnippet('<<?>>'); close(); }}>{tex('A^{\\langle j\\rangle}')}<span>Spalte j</span></button>
              <button onClick={() => { insertSnippet('vec(?)'); close(); }}>{tex('\\overrightarrow{f}')}<span>Vektorisieren (elementweise)</span></button>
              <button onClick={() => { insertSnippet('identity(?)'); close(); }}>identity(n)<span>Einheitsmatrix</span></button>
              <button onClick={() => { insertSnippet('lsolve(?, ?)'); close(); }}>lsolve(A, b)<span>Gleichungssystem</span></button>
              <button onClick={() => { insertSnippet('eigenvals(?)'); close(); }}>eigenvals(A)<span>Eigenwerte</span></button>
            </>
          )}
        </Dropdown>
      </Group>
      <Group label="Logik">
        <Dropdown title="Vergleiche und Logik" label={tex('\\le\\,\\wedge')}>
          {(close) => (
            <>
              {([['==', 'gleich (Bedingung)', '\\mathbf{=}'], ['≠', 'ungleich', '\\neq'], ['<', 'kleiner', '<'], ['>', 'größer', '>'], ['≤', 'kleiner gleich', '\\le'], ['≥', 'größer gleich', '\\ge'], ['∧', 'und', '\\wedge'], ['∨', 'oder', '\\vee'], ['¬', 'nicht', '\\neg']] as const).map(([op, label, l]) => (
                <button key={op} onClick={() => { insertSnippet(op === '¬' ? '¬' : ` ${op} `); close(); }}>{tex(l)}<span>{label}</span></button>
              ))}
            </>
          )}
        </Dropdown>
      </Group>
      <Group label="Programm">
        <Dropdown title="Programmbausteine" label={<>{tex('\\left|\\,\\right.')}if/for</>}>
          {(close) => (
            <>
              <div className="menu-label">Vorlagen (mehrzeilig, eingerückt)</div>
              <button onClick={() => { insertSnippet('f(x) :=\n  if x > 0\n    ?\n  else\n    ?'); close(); }}>Fallunterscheidung <span className="hint">if / else</span></button>
              <button onClick={() => { insertSnippet('s(n) :=\n  summe ← 0\n  for i ∈ 1..n\n    summe ← summe + ?\n  summe'); close(); }}>Schleife <span className="hint">for</span></button>
              <button onClick={() => { insertSnippet('g(x) :=\n  while ?\n    x ← x/2\n  x'); close(); }}>Bedingte Schleife <span className="hint">while</span></button>
              <hr />
              <div className="menu-label">Einzelne Anweisungen</div>
              <button onClick={() => { insertSnippet(' ← '); close(); }}>Lokale Zuweisung <span className="hint">←</span></button>
              <button onClick={() => { insertSnippet('\nif ?'); close(); }}>if</button>
              <button onClick={() => { insertSnippet('\nelse'); close(); }}>else</button>
              <button onClick={() => { insertSnippet('\nfor i ∈ ?'); close(); }}>for</button>
              <button onClick={() => { insertSnippet('\nreturn ?'); close(); }}>return</button>
              <hr />
              <div className="menu-label">Solve-Block</div>
              <button onClick={() => { insertSnippet('Given'); close(); }}>Given <span className="hint">danach Bedingungen mit ==, dann Find(x)</span></button>
            </>
          )}
        </Dropdown>
      </Group>
      <Group label="Symbole">
        <Dropdown title="Griechische Buchstaben (im Editor auch Strg+G oder \alpha)" label={tex('\\alpha\\beta')}>
          {(close) => (
            <div className="greek-grid">
              {GREEK.split('').map(g => <button key={g} onClick={() => { insertSnippet(g); close(); }}>{g}</button>)}
            </div>
          )}
        </Dropdown>
        <Dropdown title="Einheiten" label={tex('\\mathrm{kN}')}>
          {(close) => (
            <div className="unit-menu">
              {COMMON_UNITS.map(g => (
                <div key={g.group}>
                  <div className="menu-label">{g.group}</div>
                  <div className="unit-row">{g.units.map(u => <button key={u} onClick={() => { insertSnippet(' ' + u); close(); }}>{u}</button>)}</div>
                </div>
              ))}
            </div>
          )}
        </Dropdown>
      </Group>
      <Group label="Anordnen">
        <RB title="Links ausrichten (Mehrfachauswahl)" onClick={() => alignSelection('left')}><IconAlignLeft /></RB>
        <RB title="Oben ausrichten (Mehrfachauswahl)" onClick={() => alignSelection('top')}><IconAlignTop /></RB>
        <RB title="Überlappende Bereiche trennen" onClick={() => separateAll()}><IconSeparate /></RB>
        <RB title="Auswahl löschen (Entf)" onClick={() => store.deleteRegions(store.get().selection)}><IconTrash /></RB>
      </Group>
    </div>
  );
}
