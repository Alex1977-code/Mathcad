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
import { gaussSolve } from './numeric';

type Lazy = (args: Node[], scope: Scope, ev: Evaluator) => Val;

const num = (v: Val, what = 'Wert'): number => (isUnit(v) ? ((v as Unit).value as number) : toNumber(v, what));
const vecOf = (v: Val): number[] => (isMatrix(v) ? matrixRows(v as Matrix).flat().map(x => num(x)) : [num(v)]);
type Matrix = import('mathjs').Matrix;

/** Base name and number of primes of a call name: "y''" → ["y", 2]. */
function primeSplit(name: string): [string, number] {
  const m = /^(.*?)('+|′+)$/.exec(name);
  return m ? [m[1], m[2].length] : [name, 0];
}

/** Mathcad's Odesolve: solve the ODE system of the preceding Given block. */
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
  const b = num(ev.eval(rest[1], outer), 'Endpunkt');
  const constraints = ev.constraints.map(c => (c.node.k === 'paren' ? c.node.a : c.node)).filter(n => n.k === 'bin' && n.op === '==') as (Node & { k: 'bin' })[];
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

  // initial conditions (calls at a point without t) and differential equations (with t)
  const eqs: (Node & { k: 'bin' })[] = [];
  const init = new Map<string, number>();
  let a: number | undefined;
  for (const c of constraints) {
    const lhs = c.a;
    const [base, k] = lhs.k === 'call' ? primeSplit(lhs.name) : ['', 0];
    if (lhs.k === 'call' && names.includes(base) && lhs.args.length === 1 && !usesT(lhs) && !usesT(c.b)) {
      const at = num(ev.eval(lhs.args[0], outer), 'Anfangspunkt');
      if (a !== undefined && Math.abs(at - a) > 1e-12 * Math.max(1, Math.abs(a))) throw new CalcError('Odesolve: alle Anfangsbedingungen müssen am selben Punkt gelten (Randwertprobleme werden nicht unterstützt)');
      a = at;
      if (k >= (order.get(base) ?? 0)) throw new CalcError(`Odesolve: Anfangsbedingung für die höchste Ableitung von ${base} ist überzählig`);
      init.set(`${base}:${k}`, num(ev.eval(c.b, outer), 'Anfangswert'));
    } else eqs.push(c);
  }
  if (a === undefined) throw new CalcError('Odesolve: Anfangsbedingungen fehlen, z. B. y(0) == 1');
  if (eqs.length !== names.length) throw new CalcError(`Odesolve: ${eqs.length} Differentialgleichung(en) für ${names.length} gesuchte Funktion(en)`);
  const slots: [string, number][] = [];
  for (const u of names) for (let k = 0; k < order.get(u)!; k++) {
    if (!init.has(`${u}:${k}`)) throw new CalcError(`Odesolve: Anfangswert ${u}${"'".repeat(k)}(${a}) fehlt`);
    slots.push([u, k]);
  }
  const y0 = slots.map(([u, k]) => init.get(`${u}:${k}`)!);

  // right-hand side: the highest derivatives solve the (linear) equations at every point
  const constFn = (name: string, get: () => number): FnVal => ({ kind: 'fn', name, params: ['t'], builtin: () => get() });
  const local = new Scope(outer);
  let cur: number[] = y0, hi: number[] = names.map(() => 0), tNow = a;
  slots.forEach(([u, k], i) => local.set(u + "'".repeat(k), constFn(u, () => cur[i])));
  names.forEach((u, j) => local.set(u + "'".repeat(order.get(u)!), constFn(u, () => hi[j])));
  const residual = (t: number, y: number[], h: number[]) => {
    tNow = t; cur = y; hi = h;
    local.set(tName, tNow);
    return eqs.map(e => num(ev.binary('-', ev.eval(e.a, local), ev.eval(e.b, local))));
  };
  const rhs: OdeRhs = (t, y) => {
    let h = names.map(() => 0);
    for (let it = 0; it < 6; it++) {
      const c = residual(t, y, h);
      const A = names.map((_, i) => names.map((__, j) => { const e = h.slice(); e[j] += 1; return residual(t, y, e)[i] - c[i]; }));
      const dh = gaussSolve(A, c.map(v => -v));
      if (!dh) throw new CalcError(`Odesolve: die Gleichungen bestimmen die höchsten Ableitungen nicht (bei ${tName} = ${+t.toPrecision(6)})`);
      h = h.map((v, j) => v + dh[j]);
      if (dh.every((d, j) => Math.abs(d) <= 1e-12 * Math.max(1, Math.abs(h[j])))) break;
    }
    // state derivative: y' of every slot is the next slot or the highest derivative
    return slots.map(([u, k], i) => (k + 1 < order.get(u)! ? y[i + 1] : h[names.indexOf(u)]));
  };
  const sol = dopri(rhs, a, y0, b);
  const fnFor = (u: string): FnVal => {
    const idx = slots.findIndex(([v, k]) => v === u && k === 0);
    const f = (x: Val): Val => (isMatrix(x) ? makeMatrix(matrixRows(x as Matrix).map(r => r.map(v => f(v)))) : evalSolution(sol, num(x, tName), idx));
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
