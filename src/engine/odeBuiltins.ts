/**
 * Mathcad's ODE functions.
 *   Odesolve(t, b [, n]) / Odesolve([x; y], t, b [, n])  – after a Given block with y'(t) == …, y(0) == …
 *   rkfixed(y0, x1, x2, n, D) – classical Runge–Kutta, n equal steps; D(x, y) returns the derivatives
 *   Rkadapt / Bulstoer / Radau (same arguments) – adaptive integration, results at n equal steps
 * Values with units are integrated in SI; the solution functions return SI numbers.
 */
import type { Unit } from 'mathjs';
import type { Node } from './ast';
import { walk } from './ast';
import { CalcError, Scope, isMatrix, isUnit, makeMatrix, matrixRows, toNumber, type FnVal, type Val } from './values';
import type { Evaluator } from './evaluator';
import { dopri, evalSolution, rk4Fixed, type OdeRhs } from './ode';
import { gaussSolve, solveSystem } from './numeric';
import { mkQ, qParts, sameDims } from './quantity';

type Lazy = (args: Node[], scope: Scope, ev: Evaluator) => Val;

const num = (v: Val, what = 'Wert'): number => (isUnit(v) ? ((v as Unit).value as number) : toNumber(v, what));
const vecOf = (v: Val): number[] => (isMatrix(v) ? matrixRows(v as Matrix).flat().map(x => num(x)) : [num(v)]);
type Matrix = import('mathjs').Matrix;

/** Base name and number of primes of a call name: "y''" → ["y", 2]. */
function primeSplit(name: string): [string, number] {
  const m = /^(.*?)('+|′+)$/.exec(name);
  return m ? [m[1], m[2].length] : [name, 0];
}

/** d/dt y(t) written with the derivative operator → the prime form y'(t) (both are accepted, as in Mathcad). */
function primeForm(n: Node, tName: string): Node {
  const go = (x: Node): Node => primeForm(x, tName);
  switch (n.k) {
    case 'deriv':
      if (n.v === tName && n.body.k === 'call' && n.body.args.length === 1) return { k: 'call', name: n.body.name + "'".repeat(n.order ?? 1), args: n.body.args.map(go) };
      return { ...n, body: go(n.body) };
    case 'bin': return { ...n, a: go(n.a), b: go(n.b) };
    case 'un': case 'paren': return { ...n, a: go(n.a) };
    case 'nroot': return { ...n, n: go(n.n), a: go(n.a) };
    case 'call': return { ...n, args: n.args.map(go) };
    case 'index': return { ...n, a: go(n.a), idx: n.idx.map(go) };
    case 'matrix': return { ...n, rows: n.rows.map(r => r.map(go)) };
    default: return n;
  }
}

const ZERO9 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
const dimsOf = (v: Val): number[] | null => { const q = qParts(v); return q?.d && q.d.some(x => x !== 0) ? q.d.slice() : null; };
/** dims(y) − k·dims(t) */
const derivDims = (y: number[] | null, t: number[] | null, k: number): number[] => (y ?? ZERO9).map((d, i) => d - k * (t ?? ZERO9)[i]);
const fmtN = (x: number) => String(+x.toPrecision(6));

/**
 * Mathcad's Odesolve: solve the ODE system of the preceding Given block.
 *   initial value problems: all conditions at one point;
 *   boundary value problems: conditions at the start and at the end point (shooting method).
 * Units: the independent variable takes the unit of the end point / the condition points, every function
 * the unit of its conditions; the equations are checked for consistent dimensions while integrating.
 */
const odesolve: Lazy = (args, outer, ev) => {
  if (args.length < 2 || args.length > 4) throw new CalcError('Odesolve(t, b) oder Odesolve([x; y], t, b) erwartet');
  let explicit: string[] | null = null;
  let rest = args;
  if (args[0].k === 'matrix') {
    explicit = args[0].rows.flat().map(n => { if (n.k !== 'id') throw new CalcError('Odesolve: Vektor der gesuchten Funktionen, z. B. [x; y]'); return n.name; });
    rest = args.slice(1);
  }
  const tv = rest[0];
  if (!tv || tv.k !== 'id') throw new CalcError('Odesolve: Integrationsvariable, z. B. Odesolve(t, 10)');
  const tName = tv.name;
  const bVal = ev.eval(rest[1], outer);
  const b = num(bVal, 'Endpunkt');
  let tD = dimsOf(bVal);
  const constraints = ev.constraints.map(c => primeForm(c.node.k === 'paren' ? c.node.a : c.node, tName)).filter(n => n.k === 'bin' && n.op === '==') as (Node & { k: 'bin' })[];
  if (!constraints.length) throw new CalcError('Odesolve: keine Gleichungen – „Given“, dann z. B. y\'(t) == −y(t) und y(0) == 1');

  // unknown functions and their orders
  const order = new Map<string, number>();
  const usesT = (n: Node) => { let u = false; walk(n, x => { if (x.k === 'id' && x.name === tName) u = true; }); return u; };
  for (const c of constraints) walk(c, x => {
    if (x.k !== 'call') return;
    const [base, k] = primeSplit(x.name);
    if (k > 0 || (explicit?.includes(base))) order.set(base, Math.max(order.get(base) ?? 0, k));
  });
  const names = explicit ?? [...order.keys()];
  if (!names.length) throw new CalcError('Odesolve: keine Ableitung gefunden – Schreibweise y\'(t), y\'\'(t)');
  for (const u of names) if (!order.get(u)) throw new CalcError(`Odesolve: keine Ableitung von ${u} in den Gleichungen`);

  // conditions at points (calls without t) and the differential equations (with t)
  const eqs: (Node & { k: 'bin' })[] = [];
  const conds: { u: string; k: number; at: number; v: Val }[] = [];
  for (const c of constraints) {
    const lhs = c.a;
    const [base, k] = lhs.k === 'call' ? primeSplit(lhs.name) : ['', 0];
    if (lhs.k === 'call' && names.includes(base) && lhs.args.length === 1 && !usesT(lhs) && !usesT(c.b)) {
      const p = ev.eval(lhs.args[0], outer);
      tD = tD ?? dimsOf(p);
      if (k >= (order.get(base) ?? 0)) throw new CalcError(`Odesolve: Bedingung für die höchste Ableitung von ${base} ist überzählig`);
      conds.push({ u: base, k, at: num(p, 'Punkt der Bedingung'), v: ev.eval(c.b, outer) });
    } else eqs.push(c);
  }
  if (!conds.length) throw new CalcError('Odesolve: Anfangsbedingungen fehlen, z. B. y(0) == 1');
  if (eqs.length !== names.length) throw new CalcError(`Odesolve: ${eqs.length} Differentialgleichung(en) für ${names.length} gesuchte Funktion(en)`);

  // units of the functions from their conditions
  const yD = new Map<string, number[] | null>();
  for (const c of conds) {
    const d = dimsOf(c.v);
    const dy = d || tD ? derivDims(d, tD, -c.k) : null;
    const known = yD.get(c.u);
    if (known === undefined) yD.set(c.u, dy && dy.some(x => x !== 0) ? dy : null);
    else if (!sameDims(known, dy)) throw new CalcError(`Odesolve: die Bedingungen für ${c.u} haben unterschiedliche Einheiten`);
  }
  const slots: [string, number][] = [];
  for (const u of names) for (let k = 0; k < order.get(u)!; k++) slots.push([u, k]);
  const slotDims = slots.map(([u, k]) => derivDims(yD.get(u) ?? null, tD, k));
  const hiDims = names.map(u => derivDims(yD.get(u) ?? null, tD, order.get(u)!));

  // start point a: the condition point that is not the end point
  const same = (p: number, q: number) => Math.abs(p - q) <= 1e-12 * Math.max(1, Math.abs(p), Math.abs(q));
  const points = conds.map(c => c.at).filter((p, i, arr) => arr.findIndex(q => same(p, q)) === i);
  if (points.length > 2) throw new CalcError('Odesolve: Bedingungen an mehr als zwei Punkten werden nicht unterstützt');
  if (points.length === 2 && !points.some(p => same(p, b))) throw new CalcError(`Odesolve: bei Randwertproblemen muss der Endpunkt ${fmtN(b)} einer der beiden Punkte der Randbedingungen sein`);
  const a = points.length === 2 ? points.find(p => !same(p, b))! : points[0];
  const slotIndex = (u: string, k: number) => slots.findIndex(([v, j]) => v === u && j === k);
  const y0: (number | undefined)[] = slots.map(() => undefined);
  const atEnd: { slot: number; target: number }[] = [];
  for (const c of conds) {
    const i = slotIndex(c.u, c.k), v = num(c.v, 'Wert der Bedingung');
    if (same(c.at, a)) { if (y0[i] !== undefined) throw new CalcError(`Odesolve: ${c.u}${"'".repeat(c.k)}(${fmtN(a)}) ist doppelt vorgegeben`); y0[i] = v; }
    else atEnd.push({ slot: i, target: v });
  }
  const free = y0.map((v, i) => (v === undefined ? i : -1)).filter(i => i >= 0);
  if (free.length !== atEnd.length) {
    const miss = free.length > atEnd.length ? slots[free[0]] : null;
    throw new CalcError(miss ? `Odesolve: Anfangswert ${miss[0]}${"'".repeat(miss[1])}(${fmtN(a)}) fehlt` : 'Odesolve: zu viele Bedingungen');
  }

  // right-hand side: the highest derivatives solve the equations at every point (Newton; linear in one step)
  const local = new Scope(outer);
  let cur: number[] = slots.map(() => 0), hi: number[] = names.map(() => 0);
  const fn = (name: string, get: () => Val): FnVal => ({ kind: 'fn', name, params: [tName], builtin: () => get() });
  slots.forEach(([u, k], i) => local.set(u + "'".repeat(k), fn(u, () => mkQ(cur[i], slotDims[i].slice()))));
  names.forEach((u, j) => local.set(u + "'".repeat(order.get(u)!), fn(u, () => mkQ(hi[j], hiDims[j].slice()))));
  const residual = (t: number, y: number[], h: number[]) => {
    cur = y; hi = h;
    local.set(tName, mkQ(t, (tD ?? ZERO9).slice()));
    return eqs.map(e => num(ev.binary('-', ev.eval(e.a, local), ev.eval(e.b, local))));
  };
  const rhs: OdeRhs = (t, y) => {
    let h = names.map(() => 0);
    for (let it = 0; it < 8; it++) {
      const c = residual(t, y, h);
      const A = names.map((_, i) => names.map((__, j) => { const e = h.slice(); const d = Math.max(1, Math.abs(h[j])); e[j] += d; return (residual(t, y, e)[i] - c[i]) / d; }));
      const dh = gaussSolve(A, c.map(v => -v));
      if (!dh) throw new CalcError(`Odesolve: die Gleichungen bestimmen die höchsten Ableitungen nicht (bei ${tName} = ${fmtN(t)})`);
      h = h.map((v, j) => v + dh[j]);
      if (dh.every((d, j) => Math.abs(d) <= 1e-11 * Math.max(1, Math.abs(h[j])))) break;
    }
    return slots.map(([u, k], i) => (k + 1 < order.get(u)! ? y[i + 1] : h[names.indexOf(u)]));
  };

  let start = y0.map(v => v ?? 0);
  if (free.length) {
    // boundary value problem: find the missing start values so that the conditions at the end hold
    const shoot = (s: number[]) => {
      const y = start.slice();
      free.forEach((i, k) => { y[i] = s[k]; });
      const sol = dopri(rhs, a, y, b, { rtol: 1e-8, atol: 1e-11 });
      const end = sol.y[sol.y.length - 1];
      return atEnd.map(c => (end[c.slot] - c.target) / Math.max(1, Math.abs(c.target)));
    };
    let best: { x: number[]; residual: number } | null = null;
    for (const g of [0, 1, -1]) {
      try {
        const r = solveSystem(shoot, free.map(() => g), 60);
        if (!best || r.residual < best.residual) best = r;
        if (r.residual < 1e-7) break;
      } catch (e) { if (!best && g === -1) throw e; }
    }
    if (!best || !(best.residual < 1e-6)) throw new CalcError('Odesolve: für das Randwertproblem wurde keine Lösung gefunden');
    start = start.slice();
    free.forEach((i, k) => { start[i] = best!.x[k]; });
  }
  const sol = dopri(rhs, a, start, b);

  const fnFor = (u: string): FnVal => {
    const idx = slotIndex(u, 0);
    const d = slotDims[idx];
    const f = (x: Val): Val => (isMatrix(x) ? makeMatrix(matrixRows(x as Matrix).map(r => r.map(v => f(v)))) : mkQ(evalSolution(sol, num(x, tName), idx), d.slice()));
    return { kind: 'fn', name: u, params: [tName], builtin: (xs) => { if (xs.length !== 1) throw new CalcError(`${u} erwartet ein Argument`); return f(xs[0]); } };
  };
  if (explicit) return makeMatrix(explicit.map(u => [fnFor(u) as unknown as Val]));
  if (names.length !== 1) throw new CalcError(`Odesolve: mehrere Funktionen (${names.join(', ')}) – Odesolve([${names.join('; ')}], ${tName}, b) und [${names.join('; ')}] := …`);
  return fnFor(names[0]);
};

/** Common argument handling of rkfixed / Rkadapt / Bulstoer. */
function odeArgs(args: Val[], fname: string, ev: Evaluator) {
  if (args.length !== 5) throw new CalcError(`${fname}(y0, x1, x2, n, D) erwartet`);
  const [y0v, x1v, x2v, nv, D] = args;
  if (typeof D !== 'object' || (D as FnVal).kind !== 'fn') throw new CalcError(`${fname}: D muss eine Funktion D(x, y) sein`);
  const y0 = vecOf(y0v), x1 = num(x1v, 'x1'), x2 = num(x2v, 'x2'), n = Math.round(num(nv, 'n'));
  if (!(n >= 1 && n <= 1e6)) throw new CalcError(`${fname}: Anzahl der Schritte n zwischen 1 und 10⁶`);
  const f: OdeRhs = (x, y) => {
    const yv = makeMatrix(y.map(v => [v]));
    const r = ev.callFn(D as FnVal, [x, y.length === 1 && !isMatrix(y0v) ? y[0] : yv]);
    const out = vecOf(r);
    if (out.length !== y.length) throw new CalcError(`${fname}: D liefert ${out.length} statt ${y.length} Ableitungen`);
    return out;
  };
  return { y0, x1, x2, n, f };
}

export const ODE_LAZY: Record<string, Lazy> = { Odesolve: odesolve, odesolve };

export const ODE_BUILTINS: Record<string, (args: Val[], ev: Evaluator) => Val> = {
  rkfixed: (args, ev) => {
    const { y0, x1, x2, n, f } = odeArgs(args, 'rkfixed', ev);
    return makeMatrix(rk4Fixed(f, x1, y0, x2, n));
  },
};
for (const name of ['Rkadapt', 'Bulstoer', 'Radau', 'Stiffb', 'Stiffr']) {
  ODE_BUILTINS[name] = (args, ev) => {
    const a = name === 'Stiffb' || name === 'Stiffr' ? args.slice(0, 5) : args;   // Jacobian argument not needed
    const { y0, x1, x2, n, f } = odeArgs(a, name, ev);
    const sol = dopri(f, x1, y0, x2);
    const rows: number[][] = [];
    for (let i = 0; i <= n; i++) { const x = i === n ? x2 : x1 + (x2 - x1) * i / n; rows.push([x, ...y0.map((_, c) => evalSolution(sol, x, c))]); }
    return makeMatrix(rows);
  };
}
