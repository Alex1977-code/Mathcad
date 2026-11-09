/**
 * "Few clicks, much result": formula rewrites behind the result unit picker and the smart context-menu
 * actions (show a definition's value, plot a function, solve an equation). The text functions are pure
 * and tested; the actions apply them to the document as one undo step each.
 */
import { tokenize, findTopLevel, parseMathRegion, type Token } from '../engine/parser';
import { ComputeSession, type ComputeResult, type RegionResult } from '../engine/worksheet';
import { COMMON_UNITS, EXTRA_DISPLAY_UNITS, lookupUnit, unitDimensions } from '../engine/units';
import { isBuiltinFunction } from '../engine/builtins';
import { newId, sortRegions, type MathRegion, type Region, type Worksheet } from '../engine/model';
import { store } from './store';
import { regionElements, snap } from './layout';

/* ------------------------------ latest result ------------------------------ */

let latest: ComputeResult | null = null;
/** The app keeps the latest calculation here, so that menus and shortcuts can use it. */
export function setLatestResult(r: ComputeResult | null) { latest = r; }
export function resultOf(id: string): RegionResult | undefined { return latest?.results[id]; }

/* ------------------------------- text rewrites ----------------------------- */

/** Position of the "=" that shows a value (eval  "a + b = unit"  or  "x := 5 m = unit"), single-line formulas only. */
function showEq(src: string): Token | null {
  if (src.includes('\n')) return null;
  let toks: Token[];
  try { toks = tokenize(src); } catch { return null; }
  const def = findTopLevel(toks, t => t.v === ':=' || t.v === '≡');
  const eq = findTopLevel(toks, t => t.v === '=', def >= 0 ? def + 1 : 0);
  return eq >= 0 ? toks[eq] : null;
}

/** Display unit currently written after the "=" (empty = automatic / SI). */
export function currentUnit(src: string): string {
  const eq = showEq(src);
  return eq ? src.slice(eq.end).trim() : '';
}

/** Replace the display unit of a result (null / '' = back to the automatic SI display). */
export function withDisplayUnit(src: string, unit: string | null): string | null {
  const eq = showEq(src);
  if (!eq) return null;
  const next = src.slice(0, eq.end) + (unit ? ' ' + unit : '');
  try { parseMathRegion(next); } catch { return null; }
  return next;
}

/** "x := 5 m"  ⇄  "x := 5 m =" (show / hide the value of a definition). */
export function toggleShowValue(src: string): string | null {
  let st;
  try { st = parseMathRegion(src); } catch { return null; }
  if (st.kind !== 'define' || src.includes('\n') || st.target.params) return null;
  if (st.show) {
    const eq = showEq(src);
    return eq ? src.slice(0, eq.pos).trimEnd() : null;
  }
  return src.trimEnd() + ' =';
}

/** Function definition with exactly one parameter: name and parameter ("f(x) := …"). */
export function plottableFunction(src: string): { name: string; param: string } | null {
  try {
    const st = parseMathRegion(src);
    if (st.kind === 'define' && st.target.params?.length === 1 && !st.target.index) return { name: st.target.name, param: st.target.params[0] };
  } catch { /* not a formula */ }
  return null;
}

/** "lhs == rhs" (or "lhs = rhs" that failed because of an unknown name): the two sides. */
export function equationSides(src: string): { lhs: string; rhs: string } | null {
  if (src.includes('\n')) return null;
  let toks: Token[];
  try { toks = tokenize(src); } catch { return null; }
  if (findTopLevel(toks, t => t.v === ':=' || t.v === '≡' || t.v === '←') >= 0) return null;
  let i = findTopLevel(toks, t => t.v === '==');
  if (i < 0) i = findTopLevel(toks, t => t.v === '=');
  if (i < 0 || findTopLevel(toks, t => t.v === '==' || t.v === '=', i + 1) >= 0) return null;
  const lhs = src.slice(0, toks[i].pos).trim(), rhs = src.slice(toks[i].end).trim();
  return lhs && rhs ? { lhs, rhs } : null;
}

/** Names in an equation that are not known (no variable, function, unit or constant): candidates for the unknown. */
export function unknownNames(eq: string, known: Set<string>): string[] {
  let toks: Token[];
  try { toks = tokenize(eq); } catch { return []; }
  const out: string[] = [];
  toks.forEach((t, k) => {
    if (t.t !== 'id' || known.has(t.v) || out.includes(t.v)) return;
    if (toks[k + 1]?.v === '(' && isBuiltinFunction(t.v)) return;
    if (['e', 'π', 'pi', 'i', 'j', '∞', 'g'].includes(t.v) || lookupUnit(t.v) !== null) return;
    out.push(t.v);
  });
  return out;
}

/** Compatible units for a dimension vector, for the unit picker. */
export function compatibleUnits(dims: number[] | undefined): string[] {
  if (!dims) return [];
  // names the engine reads as variables ("t") are offered in their unambiguous spelling
  const all = [...COMMON_UNITS.flatMap(g => g.units), ...EXTRA_DISPLAY_UNITS].map(u => u.replace(/\bt\b/g, 'tonne'));
  return [...new Set(all)].filter(u => {
    if (!(u.match(/[\p{L}°]+/gu) ?? []).every(n => lookupUnit(n) !== null)) return false;
    const d = unitDimensions(u);
    return d && d.length === dims.length && d.every((x, i) => Math.abs(x - dims[i]) < 1e-9);
  });
}

/* --------------------------------- actions --------------------------------- */

const heightOf = (r: Region) => regionElements.get(r.id)?.offsetHeight ?? r.h ?? 28;

/**
 * Insert regions below an existing one, pushing everything underneath down (like inserting lines in Mathcad),
 * as one undo step. `replace` removes the anchor region itself.
 */
function insertBelow(anchor: Region, make: (y: number) => Region[], height: number, replace = false) {
  const bottom = anchor.y + heightOf(anchor);
  const top = replace ? anchor.y : snap(bottom + 12);
  const fresh = make(top);
  const shift = snap(replace ? top + height - bottom : height + 12);
  store.updateWs(ws => ({
    ...ws,
    regions: [
      ...ws.regions.filter(r => !(replace && r.id === anchor.id)).map(r => (r.id !== anchor.id && r.y >= bottom - 2 ? { ...r, y: r.y + shift } as Region : r)),
      ...fresh,
    ],
  }));
  store.set({ selection: fresh.map(r => r.id), editing: null, contextMenu: null });
}

export function setDisplayUnit(id: string, unit: string | null) {
  const r = store.get().ws.regions.find(x => x.id === id);
  if (!r || r.type !== 'math') return false;
  const next = withDisplayUnit(r.src, unit);
  if (next === null) return false;
  if (next !== r.src) store.updateRegion(id, { src: next });
  return true;
}

export function toggleValue(id: string) {
  const r = store.get().ws.regions.find(x => x.id === id);
  if (!r || r.type !== 'math') return;
  const next = toggleShowValue(r.src);
  if (next !== null) store.updateRegion(id, { src: next });
}

/** Free variable for a quick plot: the function's parameter unless that name is defined. */
function quickVar(param: string): string {
  const known = new Set((latest?.variables ?? []).map(v => v.name));
  return [param, 'x', 't', 'u', 'ξ'].find(n => !known.has(n)) ?? param;
}

/** X-Y plot of a function f(x) right below its definition. */
export function plotFunction(id: string) {
  const r = store.get().ws.regions.find(x => x.id === id);
  if (!r || r.type !== 'math') return;
  const f = plottableFunction(r.src);
  if (!f) return;
  const v = quickVar(f.param);
  insertBelow(r, y => [{ id: newId(), type: 'plot', x: r.x, y, w: 440, h: 270, traces: [{ x: v, y: `${f.name}(${v})` }], xmin: '-10', xmax: '10' }], 270);
}

/** Empty plot at the cursor (Mathcad "@"), prefilled with a selected function. */
export function quickPlotAtCursor() {
  const s = store.get();
  const sel = s.selection.length === 1 ? s.ws.regions.find(r => r.id === s.selection[0]) : undefined;
  if (sel?.type === 'math' && plottableFunction(sel.src)) { plotFunction(sel.id); return; }
  const cur = s.cursor ?? { x: 48, y: 48 };
  const p: Region = { id: newId(), type: 'plot', x: cur.x, y: cur.y, w: 440, h: 270, traces: [{ x: 'x', y: '' }], xmin: '-10', xmax: '10' };
  store.addRegion(p);
  store.set({ plotEditor: p.id, cursor: { x: cur.x, y: snap(cur.y + 290) } });
}

/** Unknown of an equation region: the name the calculation stumbled over, else the first unknown name. */
export function equationUnknown(r: MathRegion): string | null {
  const sides = equationSides(r.src);
  if (!sides) return null;
  const culprit = resultOf(r.id)?.error?.culprit;
  const known = new Set((latest?.variables ?? []).filter(v => v.regionId !== r.id).map(v => v.name));
  const cands = unknownNames(`${sides.lhs} == ${sides.rhs}`, known);
  if (culprit && cands.includes(culprit)) return culprit;
  return cands[0] ?? null;
}

const GUESS_UNITS = ['m', 's', 'kg', 'N', 'kN', 'Pa', 'MPa', 'J', 'W', 'A', 'V', 'K', 'm^2', 'm^3', 'm^4', 'kN*m', 'm/s', 'm/s^2', 'kg/m^3', 'N/m', 'kN/m', 'mol', 'Hz'];

/**
 * Lines of the solve block for an equation: guess, Given, equation, unknown := Find(unknown) =.
 * The guess gets the unit that makes the block solvable (Mathcad needs a guess with the right unit);
 * only the regions above the equation are calculated for this.
 */
export function solveBlockLines(ws: Worksheet, anchorId: string, unknown: string, sides: { lhs: string; rhs: string }): string[] {
  const make = (g: string) => [`${unknown} := ${g}`, 'Given', `${sides.lhs} == ${sides.rhs}`, `${unknown} := Find(${unknown}) =`];
  const order = sortRegions(ws.regions);
  const at = order.findIndex(r => r.id === anchorId);
  if (at < 0) return make('1');
  const before = order.slice(0, at).filter(r => r.type === 'math');
  const y0 = order[at].y;
  const session = new ComputeSession();
  const candidates = ['1', ...GUESS_UNITS.flatMap(u => [`1 ${u}`, `1/${u.includes('*') || u.includes('/') ? `(${u})` : u}`])];
  for (const g of candidates) {
    const block = make(g).map((src, k) => ({ id: `solve${k}`, type: 'math' as const, x: 0, y: y0 + k, src }));
    const res = session.runToEnd({ ...ws, regions: [...before, ...block] });
    const r = res.results.solve3;
    if (r && !r.error) return make(g);
  }
  return make('1');
}

/** Turn an equation into a solve block (guess, Given, equation, Find) in place. */
export function solveEquation(id: string) {
  const s = store.get();
  const r = s.ws.regions.find(x => x.id === id);
  if (!r || r.type !== 'math') return;
  const sides = equationSides(r.src);
  const u = equationUnknown(r);
  if (!sides || !u) return;
  const step = 36;
  const lines = solveBlockLines(s.ws, id, u, sides);
  insertBelow(r, y => lines.map((src, k) => ({ id: newId(), type: 'math', x: r.x, y: y + k * step, src }) as Region), lines.length * step - 12, true);
}

/** Copy the shown result as text. */
export function copyResult(id: string) {
  const res = resultOf(id);
  const t = res?.resultText ?? res?.valueText;
  if (t) navigator.clipboard?.writeText(t).catch(() => undefined);
}
