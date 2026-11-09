import { useEffect, useRef, useState, type ReactNode } from 'react';
import { COMMON_UNITS } from '../engine/units';
import { renderLatex } from './katex';
import { store, useStore, readPref, writePref } from './store';
import {
  alignSelection, app, canPaste, changeDecimals, copySelection, deleteSelection, duplicateSelection, insertImage, insertMatrix,
  insertRegion, insertSnippet, paste, recalcNow, separateAll, setZoom, showSide, toggleAutoCalc, toggleDefValues, toggleDisabled, toggleGrid,
  toggleSide, zoomBy, zoomPageWidth,
} from './actions';
import {
  IconAlignLeft, IconAlignTop, IconBreak, IconChart, IconChevron, IconImage, IconMath, IconSeparate, IconText, IconTrash,
  IconUndo, IconRedo, IconCopy, IconCut, IconPaste, IconDuplicate, IconCalc, IconAuto, IconGrid, IconPanel, IconMoon,
  IconReport, IconSearch, IconPower, IconList, IconAlert, IconBook, IconHelp, IconCheckCircle, IconMatrix,
} from './icons';

export { insertSnippet, insertRegion, separateAll } from './actions';

type Tab = 'start' | 'math' | 'matrix' | 'calc' | 'view';
const TABS: [Tab, string][] = [['start', 'Start'], ['math', 'Mathematik'], ['matrix', 'Matrizen & Programme'], ['calc', 'Berechnung'], ['view', 'Ansicht']];

const tex = (l: string) => <span className="tex" dangerouslySetInnerHTML={{ __html: renderLatex(l) }} />;
const keep = (e: React.MouseEvent) => e.preventDefault();

function Big({ icon, label, title, onClick, active, disabled }: { icon: ReactNode; label: string; title?: string; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <button className={`rbig${active ? ' on' : ''}`} title={title ?? label} onMouseDown={keep} onClick={onClick} disabled={disabled} aria-pressed={active}>
      <span className="ico">{icon}</span><span className="lbl">{label}</span>
    </button>
  );
}
function Small({ icon, label, title, onClick, disabled, active }: { icon?: ReactNode; label?: string; title: string; onClick: () => void; disabled?: boolean; active?: boolean }) {
  return (
    <button className={`rsmall${active ? ' on' : ''}`} title={title} onMouseDown={keep} onClick={onClick} disabled={disabled} aria-pressed={active}>
      {icon && <span className="ico">{icon}</span>}{label && <span className="lbl">{label}</span>}
    </button>
  );
}
function Sym({ l, title, snippet }: { l: string; title: string; snippet: string }) {
  return <button className="rsym" title={title} onMouseDown={keep} onClick={() => insertSnippet(snippet)}>{tex(l)}</button>;
}
function Group({ label, children }: { label: string; children: ReactNode }) {
  return <div className="rgroup"><div className="rgroup-items">{children}</div><div className="rgroup-label">{label}</div></div>;
}
const Stack = ({ children }: { children: ReactNode }) => <div className="rstack">{children}</div>;
const SymGrid = ({ children }: { children: ReactNode }) => <div className="rsymgrid">{children}</div>;

export function Dropdown({ trigger, title, children, wide }: { trigger: (open: boolean) => ReactNode; title: string; children: (close: () => void) => ReactNode; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', h); window.addEventListener('keydown', k);
    return () => { window.removeEventListener('mousedown', h); window.removeEventListener('keydown', k); };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      {/* the tooltip belongs to the button only, not to every entry of the open menu */}
      <div onMouseDown={keep} onClick={() => setOpen(o => !o)} title={open ? undefined : title}>{trigger(open)}</div>
      {open && <div className={`menu${wide ? ' wide' : ''}`} onMouseDown={keep}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

function MatrixPicker({ close }: { close: () => void }) {
  const [hv, setHv] = useState<[number, number]>([2, 2]);
  return (
    <div className="mpick">
      <div className="mpick-grid">
        {Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => (
          <span key={`${i}-${j}`} className={i < hv[0] && j < hv[1] ? 'on' : ''} onMouseEnter={() => setHv([i + 1, j + 1])}
            onClick={() => { insertMatrix(i + 1, j + 1); close(); }} />
        )))}
      </div>
      <div className="mpick-label">{hv[0]} × {hv[1]} {hv[0] === 1 && hv[1] === 1 ? 'Element' : hv[1] === 1 ? 'Spaltenvektor' : hv[0] === 1 ? 'Zeilenvektor' : 'Matrix'}</div>
    </div>
  );
}

const GREEK = 'αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ';
const CONSTS: [string, string][] = [
  ['π', 'Kreiszahl'], ['e', 'Eulersche Zahl'], ['g', 'Erdbeschleunigung 9,80665 m/s²'], ['∞', 'Unendlich'],
  ["'c", 'Lichtgeschwindigkeit'], ["'G", 'Gravitationskonstante'], ["'k", 'Boltzmann-Konstante'], ["'R", 'Universelle Gaskonstante'],
  ["'N_A", 'Avogadro-Konstante'], ["'h", 'Planck-Konstante'], ["'ε_0", 'Elektrische Feldkonstante'], ["'μ_0", 'Magnetische Feldkonstante'],
];
const MATRIX_FUNCS: [string, string, string][] = [
  ['identity(n)', 'Einheitsmatrix', 'identity(?)'], ['augment(A, B)', 'Spaltenweise verbinden', 'augment(?, ?)'], ['stack(A, B)', 'Zeilenweise verbinden', 'stack(?, ?)'],
  ['submatrix(A, i₁, i₂, j₁, j₂)', 'Teilmatrix', 'submatrix(?, ?, ?, ?, ?)'], ['lsolve(A, b)', 'Lineares Gleichungssystem', 'lsolve(?, ?)'],
  ['eigenvals(A)', 'Eigenwerte', 'eigenvals(?)'], ['eigenvecs(A)', 'Eigenvektoren', 'eigenvecs(?)'], ['rows(A), cols(A)', 'Zeilen- / Spaltenzahl', 'rows(?)'],
  ['length(v), last(v)', 'Länge, letzter Index', 'length(?)'], ['sort(v), reverse(v)', 'Sortieren', 'sort(?)'], ['max(A), min(A)', 'Extremwerte', 'max(?)'],
  ['diag(v)', 'Diagonalmatrix', 'diag(?)'], ['rank(A), tr(A)', 'Rang, Spur', 'rank(?)'], ['linterp(vx, vy, x)', 'Lineare Interpolation', 'linterp(?, ?, ?)'],
];

export function Ribbon() {
  const [tab, setTab] = useState<Tab>(() => readPref<Tab>('tab', 'start'));
  const select = (t: Tab) => { setTab(t); writePref('tab', t); };
  const sel = useStore(s => s.selection.length);
  const canUndo = useStore(s => s.canUndo), canRedo = useStore(s => s.canRedo), editingNow = useStore(s => !!s.editing);
  const settings = useStore(s => s.ws.settings);
  const autoCalc = useStore(s => s.autoCalc);
  const showGrid = useStore(s => s.showGrid);
  const showDefValues = useStore(s => s.showDefValues);
  const sideOpen = useStore(s => s.sideOpen);
  const zoom = useStore(s => s.zoom);
  const showChecks = useStore(s => s.showChecks);
  const hasImport = useStore(s => !!s.ws.source);
  const anyDisabled = useStore(s => s.ws.regions.some(r => s.selection.includes(r.id) && r.type === 'math' && !!r.disabled));

  return (
    <div className="ribbon-wrap">
      <div className="rtabs" role="tablist" aria-label="Menüband">
        <Dropdown title="Datei" trigger={(o) => <button className={`rtab file${o ? ' on' : ''}`}>Datei</button>}>
          {(close) => (
            <>
              <button onClick={() => { close(); app.newDoc(); }}>Neu</button>
              <button onClick={() => { close(); app.openFile(); }}>Öffnen / Mathcad importieren …<kbd>Strg+O</kbd></button>
              <hr />
              <button onClick={() => { close(); app.save(); }}>Speichern<kbd>Strg+S</kbd></button>
              <button onClick={() => { close(); app.save(true); }}>Speichern unter …<kbd>Strg+⇧+S</kbd></button>
              <hr />
              <button onClick={() => { close(); app.exportHtml(); }}>Als HTML exportieren</button>
              <button onClick={() => { close(); app.print(); }}>Drucken / als PDF<kbd>Strg+P</kbd></button>
              <hr />
              <button onClick={() => { close(); app.openExample(); }}>Beispiel öffnen</button>
            </>
          )}
        </Dropdown>
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`rtab${tab === id ? ' on' : ''}`} onMouseDown={keep} onClick={() => select(id)}>{label}</button>
        ))}
        <div className="spacer" />
        <button className="palette-btn" onMouseDown={keep} onClick={() => store.set({ palette: true })} title="Alle Befehle durchsuchen">
          <IconSearch /><span>Befehl suchen …</span><kbd>Strg+K</kbd>
        </button>
      </div>
      <div className="rbody" role="toolbar" aria-label={TABS.find(t => t[0] === tab)?.[1]}>
        {tab === 'start' && (
          <>
            <Group label="Zwischenablage">
              <Big icon={<IconPaste />} label="Einfügen" title="Einfügen (Strg+V)" onClick={() => paste()} disabled={!canPaste()} />
              <Stack>
                <Small icon={<IconCut />} label="Ausschneiden" title="Ausschneiden (Strg+X)" onClick={() => copySelection(true)} disabled={!sel} />
                <Small icon={<IconCopy />} label="Kopieren" title="Kopieren (Strg+C)" onClick={() => copySelection(false)} disabled={!sel} />
                <Small icon={<IconDuplicate />} label="Duplizieren" title="Duplizieren (Strg+D)" onClick={duplicateSelection} disabled={!sel} />
              </Stack>
            </Group>
            <Group label="Bereiche">
              <Big icon={<IconMath />} label="Formel" title="Formel einfügen – oder einfach aufs Blatt klicken und tippen" onClick={() => insertRegion('math')} />
              <Big icon={<IconText />} label="Text" title="Textbereich einfügen (Taste &quot;)" onClick={() => insertRegion('text')} />
              <Big icon={<IconChart />} label="Diagramm" title="X-Y-Diagramm einfügen" onClick={() => insertRegion('plot')} />
              <Stack>
                <Small icon={<IconImage />} label="Bild" title="Bild einfügen" onClick={insertImage} />
                <Small icon={<IconBreak />} label="Seitenumbruch" title="Seitenumbruch einfügen" onClick={() => insertRegion('pagebreak')} />
              </Stack>
            </Group>
            <Group label="Bearbeiten">
              <Stack>
                <Small icon={<IconUndo />} label="Rückgängig" title="Rückgängig (Strg+Z)" onClick={() => store.undo()} disabled={!canUndo && !editingNow} />
                <Small icon={<IconRedo />} label="Wiederholen" title="Wiederholen (Strg+Y)" onClick={() => store.redo()} disabled={!canRedo} />
                <Small icon={<IconTrash />} label="Löschen" title="Auswahl löschen (Entf)" onClick={deleteSelection} disabled={!sel} />
              </Stack>
              <Big icon={<IconPower />} label={anyDisabled ? 'Aktivieren' : 'Deaktivieren'} title="Auswertung der gewählten Formeln deaktivieren / wieder aktivieren" onClick={toggleDisabled} disabled={!sel} active={anyDisabled} />
            </Group>
            <Group label="Anordnen">
              <Stack>
                <Small icon={<IconAlignLeft />} label="Links ausrichten" title="Mehrfachauswahl links ausrichten" onClick={() => alignSelection('left')} disabled={sel < 2} />
                <Small icon={<IconAlignTop />} label="Oben ausrichten" title="Mehrfachauswahl oben ausrichten" onClick={() => alignSelection('top')} disabled={sel < 2} />
                <Small icon={<IconSeparate />} label="Bereiche trennen" title="Überlappende Bereiche auseinanderschieben" onClick={() => separateAll()} />
              </Stack>
            </Group>
          </>
        )}
        {tab === 'math' && (
          <>
            <Group label="Definition">
              <SymGrid>
                <Sym l="\coloneqq" title="Definition := (Taste :)" snippet=" := " />
                <Sym l="=" title="Auswerten =" snippet=" =" />
                <Sym l="\equiv" title="Globale Definition ≡ (Taste ~)" snippet=" ≡ " />
                <Sym l="\leftarrow" title="Lokale Zuweisung im Programm" snippet=" ← " />
              </SymGrid>
            </Group>
            <Group label="Operatoren">
              <SymGrid>
                <Sym l="\tfrac{a}{b}" title="Bruch" snippet="(?)/(?)" />
                <Sym l="x^2" title="Quadrat" snippet="^2" />
                <Sym l="x^n" title="Potenz" snippet="^(?)" />
                <Sym l="\sqrt{x}" title="Quadratwurzel" snippet="√(?)" />
                <Sym l="\sqrt[n]{x}" title="n-te Wurzel" snippet="nthroot(?, ?)" />
                <Sym l="|x|" title="Betrag / Länge / Determinante" snippet="|?|" />
                <Sym l="x_i" title="Index (Vektorelement)" snippet="[?]" />
                <Sym l="n!" title="Fakultät" snippet="!" />
                <Sym l="\%" title="Prozent" snippet="%" />
                <Sym l="\cdot" title="Multiplikation" snippet="*" />
                <Sym l="\mathrm{i}" title="Imaginäre Einheit (1i)" snippet="1i" />
                <Sym l="e^x" title="Exponentialfunktion" snippet="exp(?)" />
              </SymGrid>
            </Group>
            <Group label="Analysis">
              <SymGrid>
                <Sym l="\sum" title="Summe  sum(f, i, a, b)" snippet="sum(?, i, 1, n)" />
                <Sym l="\int" title="Bestimmtes Integral  int(f, x, a, b)" snippet="int(?, x, a, b)" />
                <Sym l="\prod" title="Produkt" snippet="prod(?, i, 1, n)" />
                <Sym l="\tfrac{d}{dx}" title="Ableitung an der Stelle x  deriv(f, x)" snippet="deriv(?, x)" />
                <Sym l="m..n" title="Bereichsvariable  i := 0..10" snippet="0..?" />
                <Sym l="\text{root}" title="Nullstelle  root(f(x), x)" snippet="root(?, x)" />
              </SymGrid>
            </Group>
            <Group label="Symbolik">
              <SymGrid>
                <Sym l="\rightarrow" title="Symbolisch auswerten (Strg+.)  x^2 + 2*x*x →" snippet=" → " />
                <Sym l="\xrightarrow{\textsf{expand}}" title="Ausmultiplizieren  (x+1)^2 → expand" snippet=" → expand" />
                <Sym l="\xrightarrow{\textsf{solve}}" title="Symbolisch lösen  a*x + b == 0 → solve, x" snippet=" → solve, x" />
                <Sym l="\xrightarrow{\textsf{float}}" title="Gleitkomma mit n Stellen  π → float, 6" snippet=" → float, 6" />
                <Sym l="\xrightarrow{\textsf{subst}}" title="Einsetzen  x^2 → substitute, x = a + 1" snippet=" → substitute, x = ?" />
                <Sym l="\xrightarrow{\textsf{factor}}" title="Faktorisieren  x^2 - 5*x + 6 → factor" snippet=" → factor" />
                <Sym l="\xrightarrow{\textsf{series}}" title="Taylorreihe  exp(x) → series, x = 0, 6" snippet=" → series, x = 0, 6" />
                <Sym l="\int\!\mathrm{d}x" title="Unbestimmtes Integral (symbolisch)  int(f, x) →" snippet="int(?, x) →" />
              </SymGrid>
            </Group>
            <Group label="Vergleich & Logik">
              <SymGrid>
                <Sym l="\mathbf{=}" title="Gleich (Bedingung)" snippet=" == " />
                <Sym l="<" title="Kleiner" snippet=" < " />
                <Sym l="\le" title="Kleiner gleich" snippet=" ≤ " />
                <Sym l="\wedge" title="Und" snippet=" ∧ " />
                <Sym l="\neq" title="Ungleich" snippet=" ≠ " />
                <Sym l=">" title="Größer" snippet=" > " />
                <Sym l="\ge" title="Größer gleich" snippet=" ≥ " />
                <Sym l="\vee" title="Oder" snippet=" ∨ " />
              </SymGrid>
            </Group>
            <Group label="Symbole">
              <Dropdown title="Griechische Buchstaben (im Editor auch \alpha oder Strg+G)" trigger={() => <button className="rbig"><span className="ico">{tex('\\alpha\\beta')}</span><span className="lbl">Griechisch<IconChevron /></span></button>}>
                {(close) => <div className="greek-grid">{GREEK.split('').map(g => <button key={g} onClick={() => { insertSnippet(g); close(); }}>{g}</button>)}</div>}
              </Dropdown>
              <Dropdown title="Einheiten" wide trigger={() => <button className="rbig"><span className="ico">{tex('\\mathrm{kN}')}</span><span className="lbl">Einheiten<IconChevron /></span></button>}>
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
              <Dropdown title="Konstanten" wide trigger={() => <button className="rbig"><span className="ico">{tex('\\pi')}</span><span className="lbl">Konstanten<IconChevron /></span></button>}>
                {(close) => <>{CONSTS.map(([s, d]) => <button key={s} onClick={() => { insertSnippet(s); close(); }}><code>{s}</code><span className="hint">{d}</span></button>)}</>}
              </Dropdown>
            </Group>
          </>
        )}
        {tab === 'matrix' && (
          <>
            <Group label="Matrizen">
              <Dropdown title="Matrix einfügen – Größe wählen" trigger={() => <button className="rbig"><span className="ico"><IconMatrix /></span><span className="lbl">Matrix<IconChevron /></span></button>}>
                {(close) => <MatrixPicker close={close} />}
              </Dropdown>
              <SymGrid>
                <Sym l="A^{\mathsf T}" title="Transponieren" snippet="^T" />
                <Sym l="A^{-1}" title="Inverse" snippet="^-1" />
                <Sym l="|A|" title="Determinante / Betrag" snippet="|?|" />
                <Sym l="A_{i,j}" title="Element" snippet="[?, ?]" />
                <Sym l="A^{\langle j\rangle}" title="Spalte j" snippet="<<?>>" />
                <Sym l="\times" title="Kreuzprodukt" snippet=" × " />
                <Sym l="\overrightarrow{f}" title="Vektorisieren (elementweise)" snippet="vec(?)" />
                <Sym l="\Sigma v" title="Summe der Elemente" snippet="sum(?)" />
              </SymGrid>
              <Dropdown title="Matrixfunktionen" wide trigger={() => <button className="rbig"><span className="ico"><IconList /></span><span className="lbl">Funktionen<IconChevron /></span></button>}>
                {(close) => <>{MATRIX_FUNCS.map(([s, d, snip]) => <button key={s} onClick={() => { insertSnippet(snip); close(); }}><code>{s}</code><span className="hint">{d}</span></button>)}</>}
              </Dropdown>
            </Group>
            <Group label="Programmierung">
              <Big icon={tex('\\left|\\,\\text{if}\\right.')} label="Wenn / Sonst" title="Fallunterscheidung (mehrzeilig, eingerückt)" onClick={() => insertSnippet('f(x) :=\n  if x > 0\n    ?\n  else\n    ?')} />
              <Big icon={tex('\\left|\\,\\text{for}\\right.')} label="Schleife" title="for-Schleife" onClick={() => insertSnippet('s(n) :=\n  summe ← 0\n  for i ∈ 1..n\n    summe ← summe + ?\n  summe')} />
              <Big icon={tex('\\left|\\,\\text{while}\\right.')} label="Solange" title="while-Schleife" onClick={() => insertSnippet('g(x) :=\n  while ?\n    x ← x/2\n  x')} />
              <Stack>
                <Small label="return" title="Rückgabe eines Werts" onClick={() => insertSnippet('\nreturn ?')} />
                <Small label="break" title="Schleife verlassen" onClick={() => insertSnippet('\nbreak')} />
                <Small label="try / on error" title="Fehlerbehandlung" onClick={() => insertSnippet('\ntry\n  ?\non error\n  ?')} />
              </Stack>
            </Group>
            <Group label="Gleichungssysteme">
              <Big icon={tex('\\text{Given}')} label="Solve-Block" title="Given – darunter Bedingungen mit ==, dann Find(x, y)" onClick={() => insertSnippet('Given')} />
              <Stack>
                <Small label="Find(x, y)" title="Lösung des Solve-Blocks" onClick={() => insertSnippet('Find(?)')} />
                <Small label="Minerr(x)" title="Näherungslösung (kleinste Abweichung)" onClick={() => insertSnippet('Minerr(?)')} />
                <Small label="polyroots(v)" title="Nullstellen eines Polynoms" onClick={() => insertSnippet('polyroots(?)')} />
              </Stack>
            </Group>
          </>
        )}
        {tab === 'calc' && (
          <>
            <Group label="Berechnen">
              <Big icon={<IconCalc />} label="Jetzt berechnen" title="Arbeitsblatt neu berechnen (F9)" onClick={recalcNow} />
              <Big icon={<IconAuto />} label="Automatisch" title="Automatische Berechnung bei jeder Änderung" onClick={toggleAutoCalc} active={autoCalc} />
            </Group>
            <Group label="Ergebnisformat">
              <div className="rfield">
                <label>Nachkommastellen</label>
                <div className="stepper">
                  <button onMouseDown={keep} onClick={() => changeDecimals(-1)} aria-label="weniger Nachkommastellen">−</button>
                  <span>{settings.decimals}</span>
                  <button onMouseDown={keep} onClick={() => changeDecimals(1)} aria-label="mehr Nachkommastellen">+</button>
                </div>
              </div>
              <div className="rfield">
                <label>Exponent ab 10ⁿ</label>
                <div className="stepper">
                  <button onMouseDown={keep} onClick={() => store.setSettings({ expThreshold: Math.max(1, settings.expThreshold - 1) })} aria-label="kleiner">−</button>
                  <span>{settings.expThreshold}</span>
                  <button onMouseDown={keep} onClick={() => store.setSettings({ expThreshold: Math.min(15, settings.expThreshold + 1) })} aria-label="größer">+</button>
                </div>
              </div>
              <div className="rfield">
                <label>Dezimalzeichen</label>
                <div className="segmented">
                  <button className={!settings.decimalComma ? 'on' : ''} onMouseDown={keep} onClick={() => store.setSettings({ decimalComma: false })}>1.5</button>
                  <button className={settings.decimalComma ? 'on' : ''} onMouseDown={keep} onClick={() => store.setSettings({ decimalComma: true })}>1,5</button>
                </div>
              </div>
              <div className="rfield">
                <label>Startindex</label>
                <div className="segmented">
                  <button className={settings.origin === 0 ? 'on' : ''} onMouseDown={keep} onClick={() => store.setSettings({ origin: 0 })}>0</button>
                  <button className={settings.origin === 1 ? 'on' : ''} onMouseDown={keep} onClick={() => store.setSettings({ origin: 1 })}>1</button>
                </div>
              </div>
            </Group>
            <Group label="Mathcad-Import">
              <Big icon={<IconReport />} label="Importbericht" title="Bericht des Mathcad-Imports mit Ergebnisabgleich" onClick={() => app.showReport()} disabled={!hasImport} />
              <Big icon={<IconCheckCircle />} label="Abgleich zeigen" title="✓/!-Markierungen des Ergebnisabgleichs anzeigen" onClick={() => store.set({ showChecks: !showChecks })} active={showChecks && hasImport} disabled={!hasImport} />
            </Group>
          </>
        )}
        {tab === 'view' && (
          <>
            <Group label="Zoom">
              <Big icon={<span className="zoomval">{Math.round(zoom * 100)}%</span>} label="100 %" title="Zoom 100 % (Strg+0)" onClick={() => setZoom(1)} />
              <Stack>
                <Small label="Vergrößern" title="Vergrößern (Strg +)" onClick={() => zoomBy(0.1)} />
                <Small label="Verkleinern" title="Verkleinern (Strg −)" onClick={() => zoomBy(-0.1)} />
                <Small label="Seitenbreite" title="Auf Fensterbreite zoomen" onClick={zoomPageWidth} />
              </Stack>
            </Group>
            <Group label="Anzeigen">
              <Big icon={<IconGrid />} label="Raster" title="Raster ein/aus" onClick={toggleGrid} active={showGrid} />
              <Big icon={<span className="ico-text">:=·</span>} label="Werte zeigen" title="Werte aller Definitionen grau daneben anzeigen" onClick={toggleDefValues} active={showDefValues} />
              <Big icon={<IconPanel />} label="Seitenleiste" title="Seitenleiste ein/aus" onClick={toggleSide} active={sideOpen} />
              <Big icon={<IconMoon />} label="Hell / Dunkel" title="Farbschema umschalten" onClick={() => app.toggleTheme()} />
            </Group>
            <Group label="Seitenleiste">
              <Big icon={<span className="ico-text">x=</span>} label="Variablen" title="Alle Variablen mit Werten" onClick={() => showSide('vars')} />
              <Big icon={<IconAlert />} label="Probleme" title="Fehler und Abweichungen zu Mathcad" onClick={() => showSide('problems')} />
              <Big icon={<IconBook />} label="Gliederung" title="Überschriften des Dokuments" onClick={() => showSide('outline')} />
              <Big icon={<IconHelp />} label="Referenz" title="Kurzreferenz der Syntax (F1)" onClick={() => showSide('help')} />
            </Group>
          </>
        )}
      </div>
    </div>
  );
}
