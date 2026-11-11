import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MathRegion } from '../../engine/model';
import type { RegionResult, VariableInfo } from '../../engine/worksheet';
import { parseMathRegion, ParseError } from '../../engine/parser';
import { stmtLatex, nameLatex, toLatex } from '../../engine/latex';
import type { Node } from '../../engine/ast';
import { isUnitName, COMMON_UNITS } from '../../engine/units';
import { BUILTIN_NAMES, isBuiltinFunction } from '../../engine/builtins';
import { renderLatex } from '../katex';
import { store, useStore } from '../store';
import { GREEK_NAMES, IDENT_RE, insertSnippet, setActiveEditor, toGreek } from '../editing';
import { downloadDataFile, insertMatrix } from '../actions';

/* ------------------------------------------------------------------ */
/* LaTeX composition                                                    */
/* ------------------------------------------------------------------ */

const localCtx = {
  isUnit: (n: string) => n.startsWith("'") || (isUnitName(n) && n.length > 1 && !['in', 'min', 'day'].includes(n)) || ['m', 's', 'N', 'W', 'J', 'A', 'V', 'K', 'Pa'].includes(n),
  isBuiltin: (n: string) => isBuiltinFunction(n),
};

export function composeLatex(src: string, res: RegionResult | undefined, preferLocal = false, defValue = false): { latex: string; parseError?: ParseError } {
  if (!src.trim()) return { latex: '' };
  if (/^\s*given\s*$/i.test(src)) return { latex: '\\textbf{Given}' };
  let base = preferLocal ? undefined : res?.latex;
  let parseError: ParseError | undefined;
  let kind = res?.kind;
  let show = false;
  let sym: { kw?: { name: string; args: Node[] } } | undefined;
  try {
    const st = parseMathRegion(src);
    if (!base) base = stmtLatex(st, localCtx);
    kind = st.kind;
    sym = st.kind === 'eval' ? st.sym : undefined;
    show = (st.kind === 'eval' && !sym) || (st.kind === 'define' && !!st.show);
  } catch (e) {
    if (e instanceof ParseError) parseError = e;
    return { latex: base ?? '', parseError };
  }
  let latex = base ?? '';
  if (show) {
    if (res?.resultLatex && !res.error) latex += ` = \\htmlClass{fw-result}{${res.resultLatex}}`;
    else latex += ' = \\htmlClass{fw-result}{\\,\\cdot\\,}';
  }
  if (sym) {
    // Mathcad: keyword above the arrow
    const arrow = sym.kw ? `\\xrightarrow{\\textsf{${sym.kw.name}}${sym.kw.args.map(a => ',\\,' + toLatex(a, localCtx)).join('')}}` : '\\rightarrow';
    latex += ` ${arrow} ` + (res?.symbolicLatex && !res.error ? `\\htmlClass{fw-sym}{${res.symbolicLatex}}` : '\\htmlClass{fw-sym}{\\,\\cdot\\,}');
  } else if (res?.symbolicLatex) latex += ` \\rightarrow ${res.symbolicLatex}`;
  // optional: value of a plain definition, greyed (the region itself stays a pure definition)
  if (defValue && !show && kind === 'define' && res?.valueLatex && !res.literal && !res.error && res.valueLatex.length < 600) {
    latex += ` \\htmlClass{fw-defval}{\\;=\\;${res.valueLatex}}`;
  }
  void kind;
  return { latex };
}

/* ------------------------------------------------------------------ */
/* Autocomplete                                                         */
/* ------------------------------------------------------------------ */

interface Suggestion { text: string; label: string; kind: string }
const UNIT_LIST = [...new Set(COMMON_UNITS.flatMap(g => g.units).filter(u => /^[\p{L}°]+$/u.test(u)))];
const FN_DESCR: Record<string, string> = {
  root: 'Nullstelle', Find: 'Solve-Block lösen', sum: 'Summe Σ', prod: 'Produkt Π', int: 'Integral ∫', deriv: 'Ableitung d/dx',
  if: 'if(Bedingung, dann, sonst)', max: 'Maximum', min: 'Minimum', mean: 'Mittelwert', sqrt: 'Quadratwurzel', nthroot: 'n-te Wurzel',
  lsolve: 'lineares Gleichungssystem', linterp: 'lineare Interpolation', identity: 'Einheitsmatrix', vec: 'Vektorisieren',
};

function suggestions(prefix: string, vars: VariableInfo[]): Suggestion[] {
  if (!prefix) return [];
  if (prefix.startsWith('\\')) {
    const p = prefix.slice(1);
    return Object.entries(GREEK_NAMES).filter(([k]) => k.startsWith(p)).slice(0, 8).map(([k, v]) => ({ text: v, label: `${v}  \\${k}`, kind: 'Symbol' }));
  }
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (s: Suggestion) => { if (!seen.has(s.text) && s.text !== prefix) { seen.add(s.text); out.push(s); } };
  for (const v of vars) if (v.name.startsWith(prefix)) add({ text: v.kind === 'Funktion' ? v.name + '(' : v.name, label: v.kind === 'Funktion' ? v.text : v.name, kind: v.kind });
  for (const f of BUILTIN_NAMES) if (f.startsWith(prefix) && prefix.length >= 2) add({ text: f + '(', label: f + '(…)', kind: FN_DESCR[f] ?? 'Funktion' });
  for (const u of UNIT_LIST) if (u.startsWith(prefix) && prefix.length >= 2) add({ text: u, label: u, kind: 'Einheit' });
  return out.slice(0, 8);
}

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

interface Props {
  region: MathRegion;
  result?: RegionResult;
  editing: boolean;
  variables: VariableInfo[];
  showCheck: boolean;
  onCommit: (id: string, height: number) => void;
}

export function MathRegionView({ region, result, editing, variables, showCheck, onCommit }: Props) {
  const defValues = useStore(s => s.showDefValues);
  if (editing) return <MathEditor region={region} result={result} variables={variables} onCommit={onCommit} />;
  // result of an older text (recalculation still running): show the new formula without the old value
  const stale = !!result && result.src !== undefined && result.src !== region.src;
  const { latex } = composeLatex(region.src, stale ? { id: region.id } : result, false, defValues);
  const err = stale ? undefined : result?.error;
  const tip = !stale && result?.valueText && !result.literal && !err ? `= ${result.valueText}` : !stale && result?.resultLatex && !err ? 'Klick auf das Ergebnis: Einheit wählen' : undefined;
  return (
    <>
      {latex
        ? <div className="math-view" title={tip} dangerouslySetInnerHTML={{ __html: renderLatex(latex) }} />
        : <div className="math-view math-placeholder">{region.src.trim() ? region.src : 'leer'}</div>}
      {err && <div className="error-chip">{err.message}</div>}
      {!stale && !err && result?.files?.map(f => (
        <button key={f.name} className="file-chip" title={`„${f.name}“ herunterladen`} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); void downloadDataFile(f); }}>⬇ {f.name}</button>
      ))}
      {showCheck && !stale && result?.check && result.check.status !== 'skipped' && (
        <span
          className={`check-badge ${result.check.status === 'match' ? 'ok' : 'bad'}`}
          title={result.check.status === 'match'
            ? `Stimmt mit Mathcad überein (${result.check.expected})`
            : `Abweichung zu Mathcad – Mathcad: ${result.check.expected} · FormelWerk: ${result.resultText ?? result.error?.message ?? '–'}`}
        >{result.check.status === 'match' ? '✓' : '!'}</span>
      )}
    </>
  );
}

function MathEditor({ region, result, variables, onCommit }: Omit<Props, 'editing' | 'showCheck'>) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [acIndex, setAcIndex] = useState(0);
  /** Enter accepts a suggestion only after the user navigated the list with the arrow keys. */
  const acNavigated = useRef(false);
  const [prefix, setPrefix] = useState('');
  const expanded = useRef(false);
  const pendingSel = useRef<[number, number] | null>(null);
  const src = region.src;

  const setSrc = (v: string, caret?: number, caretEnd?: number) => {
    if (caret !== undefined) pendingSel.current = [caret, caretEnd ?? caret];
    store.updateRegion(region.id, { src: v }, false);
  };

  useEffect(() => {
    const el = ta.current!;
    el.focus();
    const end = el.value.length;
    const ph = el.value.indexOf('?');
    if (ph >= 0) el.setSelectionRange(ph, ph + 1); else el.setSelectionRange(end, end);
    setActiveEditor({
      insert: (text: string) => {
        const next = insertSnippet(el, text);
        setSrc(next);
      },
    });
    return () => setActiveEditor(null);
  }, []);

  useLayoutEffect(() => {
    const el = ta.current!;
    if (pendingSel.current) {
      // restore the caret synchronously (before the next key event is processed)
      if (el.value === src) el.setSelectionRange(pendingSel.current[0], pendingSel.current[1]);
      pendingSel.current = null;
    }
    el.style.height = '0px';
    el.style.height = el.scrollHeight + 'px';
    el.style.width = '0px';
    el.style.width = Math.max(200, el.scrollWidth + 12) + 'px';
  }, [src]);

  /** Name being typed before the caret (without leading digits: "3\al" → "\al"). */
  const identBefore = (before: string) => { const m = IDENT_RE.exec(before); return m ? m[0].replace(/^[0-9.]+/, '') : ''; };
  const sugg = useMemo(() => suggestions(prefix, variables), [prefix, variables]);
  const { latex, parseError } = composeLatex(src, result);

  const updatePrefix = () => {
    const el = ta.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    setPrefix(identBefore(before));
    setAcIndex(0);
    acNavigated.current = false;
  };

  const accept = (s: { text: string }) => {
    const el = ta.current!;
    const pos = el.selectionStart;
    // measured again: the state may lag behind the last keystroke
    const start = pos - identBefore(el.value.slice(0, pos)).length;
    const next = el.value.slice(0, start) + s.text + el.value.slice(pos);
    setSrc(next, start + s.text.length);
    setPrefix('');
    el.focus();
  };

  const commit = () => {
    // height of the formula as it will be shown (not of the editor with its hints)
    const pv = box.current?.querySelector('.preview') as HTMLElement | null;
    const h = Math.max(pv?.getBoundingClientRect().height ?? 0, box.current?.querySelector('textarea')?.getBoundingClientRect().height ?? 0) || 30;
    onCommit(region.id, h / store.get().zoom);
  };

  const multiline = (v: string, pos: number) => {
    const line = v.slice(0, pos).split('\n').pop() ?? '';
    return v.includes('\n') || /:=\s*$|≡\s*$/.test(line);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // keys typed into the editor must not reach the sheet's shortcuts
    e.stopPropagation();
    const el = e.currentTarget;
    const v = el.value, s = el.selectionStart, end = el.selectionEnd;
    if (sugg.length && prefix) {
      if (e.key === 'ArrowDown') { e.preventDefault(); acNavigated.current = true; setAcIndex(i => (i + 1) % sugg.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); acNavigated.current = true; setAcIndex(i => (i - 1 + sugg.length) % sugg.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && acNavigated.current && !e.ctrlKey && !e.metaKey && !e.shiftKey)) { e.preventDefault(); accept(sugg[acIndex]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setPrefix(''); return; }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      const orig = store.get().editOriginal;
      if (!orig || !orig.trim()) {
        // cancelling a new formula removes it again
        store.discardRegion(region.id);
        store.set({ editing: null, selection: [] });
        return;
      }
      setSrc(orig);
      store.set({ editing: null });
      return;
    }
    if (e.key === 'Enter') {
      if (e.ctrlKey || e.metaKey || (!e.shiftKey && !multiline(v, s))) { e.preventDefault(); commit(); return; }
      // new line with automatic indentation (programs)
      e.preventDefault();
      const line = v.slice(0, s).split('\n').pop() ?? '';
      let indent = (/^\s*/.exec(line)?.[0] ?? '');
      if (/:=\s*$|≡\s*$/.test(line) && !indent) indent = '  ';
      else if (/^\s*(if|else|elseif|otherwise|for|while|try|on error)\b/.test(line)) indent += '  ';
      const next = v.slice(0, s) + '\n' + indent + v.slice(end);
      setSrc(next, s + 1 + indent.length);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      // templates: Tab / Shift+Tab jump to the next / previous placeholder „?“
      if (v.includes('?')) {
        const after = v.indexOf('?', end > s ? end : s + (v[s] === '?' ? 1 : 0));
        const before = v.lastIndexOf('?', s - 1);
        const k = e.shiftKey ? (before >= 0 ? before : v.lastIndexOf('?')) : (after >= 0 ? after : v.indexOf('?'));
        if (k >= 0) { ta.current!.setSelectionRange(k, k + 1); return; }
      }
      const next = v.slice(0, s) + '  ' + v.slice(end);
      setSrc(next, s + 2);
      return;
    }
    // Mathcad templates: "$" sum, "&" integral, Ctrl+M matrix (not inside a string)
    const inString = ((v.slice(v.lastIndexOf('\n', s - 1) + 1, s).match(/"/g)?.length ?? 0) % 2) === 1;
    if ((e.key === '$' || e.key === '&') && !inString && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const ins = e.key === '$' ? 'sum(?, i, 1, n)' : 'int(?, x, a, b)';
      const k = s + ins.indexOf('?');
      setSrc(v.slice(0, s) + ins + v.slice(end), k, k + 1);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'm') { e.preventDefault(); insertMatrix(3, 3); return; }
    // symbolic evaluation: Ctrl+. (Mathcad) or "->"
    if (((e.ctrlKey || e.metaKey) && e.key === '.') || (e.key === '>' && v[s - 1] === '-' && s === end && !inString)) {
      e.preventDefault();
      const from = e.key === '>' ? s - 1 : s;
      const ins = (v[from - 1] === ' ' ? '' : ' ') + '→ ';
      setSrc(v.slice(0, from) + ins + v.slice(end), from + ins.length);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g' && s === end && s > 0) {
      e.preventDefault();
      const g = toGreek(v[s - 1]);
      if (g) setSrc(v.slice(0, s - 1) + g + v.slice(s), s);
      return;
    }
    // Mathcad style:  ":"  →  ":="   and  "~" → "≡"
    // only the current line counts (program lines: "a:" → "a ← "); nothing to define at the start of a line
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const linePrefix = v.slice(lineStart, s);
    if (e.key === ':' && v[s] !== '=' && v[s - 1] !== ':' && linePrefix.trim() !== '' && !/:=|←/.test(linePrefix)) {
      e.preventDefault();
      const ins = (v[s - 1] === ' ' ? '' : ' ') + (lineStart > 0 ? '← ' : ':= ');
      setSrc(v.slice(0, s) + ins + v.slice(end), s + ins.length);
      expanded.current = true;
      return;
    }
    if (e.key === '=' && expanded.current && v.slice(s - 3, s) === ':= ') { e.preventDefault(); expanded.current = false; return; }
    expanded.current = false;
    if (e.key === '~') {
      e.preventDefault();
      const ins = ' ≡ ';
      setSrc(v.slice(0, s) + ins + v.slice(end), s + ins.length);
      return;
    }
    // "\alpha" followed by space → α
    if (e.key === ' ' && s === end) {
      const m = /\\([A-Za-z]+)$/.exec(v.slice(0, s));
      if (m && GREEK_NAMES[m[1]]) {
        e.preventDefault();
        const g = GREEK_NAMES[m[1]];
        setSrc(v.slice(0, s - m[0].length) + g + v.slice(s), s - m[0].length + g.length);
      }
    }
  };

  const isProgram = src.includes('\n') || /:=\s*$/.test(src);
  const errMsg = parseError?.message ?? result?.error?.message;

  return (
    <div className="math-editor" ref={box} onMouseDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ta}
        value={src}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        aria-label="Formel bearbeiten"
        rows={1}
        onChange={(e) => { setSrc(e.target.value, e.target.selectionStart, e.target.selectionEnd); requestAnimationFrame(updatePrefix); }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updatePrefix(); }}
        onClick={updatePrefix}
        onBlur={() => setTimeout(() => { if (store.get().editing === region.id && document.activeElement !== ta.current) commit(); }, 120)}
      />
      {/* preview and hints float below the input: they neither push nor block the formulas underneath */}
      <div className="me-below">
        <div className="preview" dangerouslySetInnerHTML={{ __html: latex ? renderLatex(latex) : '<span class="editor-hint">Vorschau</span>' }} />
        {errMsg && <div className="editor-error">⚠ {errMsg}</div>}
        <div className="editor-hint">
          {isProgram ? <>Enter = neue Zeile · <kbd>Strg</kbd>+<kbd>Enter</kbd> = fertig</> : <><kbd>Enter</kbd> fertig · <kbd>:</kbd> definiert · <kbd>=</kbd> am Ende rechnet · <kbd>Esc</kbd> abbrechen</>}
        </div>
      </div>
      {sugg.length > 0 && prefix && (
        <div className="ac" style={{ top: '100%', left: 0 }}>
          {sugg.map((s, i) => (
            <div key={s.text + i} className={i === acIndex ? 'sel' : ''} onMouseDown={(e) => { e.preventDefault(); accept(s); }}>
              <b>{s.label}</b><span>{s.kind}{i === acIndex ? ' · Tab' : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function varLatex(name: string) { return renderLatex(nameLatex(name)); }
