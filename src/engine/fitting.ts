/**
 * Curve fitting as in Mathcad: regress (polynomial, with interp), linfit (linear combination of
 * functions), genfit (any model, Levenberg–Marquardt) and the special fits expfit, lnfit, logfit,
 * pwrfit, lgsfit, sinfit. Linear least squares are solved by Householder QR.
 */
import type { Matrix, Unit } from 'mathjs';
import { CalcError, isMatrix, isUnit, makeMatrix, matrixRows, toNumber, type FnVal, type Val } from './values';
import type { Evaluator } from './evaluator';
import { solveSystem } from './numeric';

type Builtin = (args: Val[], ev: Evaluator) => Val;

const num = (v: Val, what = 'Wert'): number => (isUnit(v) ? ((v as Unit).value as number) : toNumber(v, what));
const vec = (v: Val, what: string): number[] => {
  if (!isMatrix(v)) throw new CalcError(`${what}: Vektor erwartet`);
  const r = matrixRows(v as Matrix);
  if (r.length > 1 && r[0].length > 1) throw new CalcError(`${what}: Vektor erwartet, keine Matrix`);
  return r.flat().map(x => num(x));
};
const col = (xs: number[]): Matrix => makeMatrix(xs.map(x => [x]));
const isFnVal = (v: Val): v is FnVal => typeof v === 'object' && v !== null && (v as FnVal).kind === 'fn';

/** Least squares  min |A·c − b|  by Householder QR. */
export function lstsq(A0: number[][], b0: number[]): number[] {
  const m = A0.length, n = A0[0]?.length ?? 0;
  if (m < n) throw new CalcError(`Ausgleichsrechnung: ${m} Punkte für ${n} Parameter – zu wenige Daten`);
  const A = A0.map(r => r.slice()), b = b0.slice();
  for (let k = 0; k < n; k++) {
    let norm = 0;
    for (let i = k; i < m; i++) norm += A[i][k] ** 2;
    norm = Math.sqrt(norm);
    if (norm === 0) throw new CalcError('Ausgleichsrechnung: die Ansatzfunktionen sind linear abhängig');
    const alpha = A[k][k] > 0 ? -norm : norm;
    const v = new Array(m).fill(0);
    v[k] = A[k][k] - alpha;
    for (let i = k + 1; i < m; i++) v[i] = A[i][k];
    const vv = v.reduce((s, x) => s + x * x, 0);
    if (vv === 0) continue;
    for (let j = k; j < n; j++) {
      let s = 0; for (let i = k; i < m; i++) s += v[i] * A[i][j];
      const f = 2 * s / vv; for (let i = k; i < m; i++) A[i][j] -= f * v[i];
    }
    let s = 0; for (let i = k; i < m; i++) s += v[i] * b[i];
    const f = 2 * s / vv; for (let i = k; i < m; i++) b[i] -= f * v[i];
  }
  const c = new Array(n).fill(0);
  for (let k = n - 1; k >= 0; k--) {
    let s = b[k];
    for (let j = k + 1; j < n; j++) s -= A[k][j] * c[j];
    if (Math.abs(A[k][k]) < 1e-14 * Math.abs(A[0][0])) throw new CalcError('Ausgleichsrechnung: die Ansatzfunktionen sind linear abhängig');
    c[k] = s / A[k][k];
  }
  return c;
}

function data(args: Val[], name: string): { x: number[]; y: number[] } {
  const x = vec(args[0], name), y = vec(args[1], name);
  if (x.length !== y.length) throw new CalcError(`${name}: x und y müssen gleich lang sein`);
  return { x, y };
}

/** Nonlinear least squares for a model f(x, p); returns the parameters. */
function nlfit(x: number[], y: number[], model: (x: number, p: number[]) => number, p0: number[], name: string): number[] {
  const res = (p: number[]) => x.map((xi, i) => model(xi, p) - y[i]);
  const r0 = res(p0);
  if (!r0.every(Number.isFinite)) throw new CalcError(`${name}: das Modell ist für den Schätzwert nicht auswertbar – anderen Schätzwert wählen`);
  const { x: p } = solveSystem(res, p0, 400);
  if (!res(p).every(Number.isFinite)) throw new CalcError(`${name}: keine Anpassung gefunden – anderen Schätzwert wählen`);
  return p;
}
const ssq = (x: number[], y: number[], model: (x: number, p: number[]) => number, p: number[]) => x.reduce((s, xi, i) => s + (model(xi, p) - y[i]) ** 2, 0);

/** Fit with a guess vector (given or tried from several starting points). */
function special(name: string, model: (x: number, p: number[]) => number, guesses: (x: number[], y: number[]) => number[][]): Builtin {
  return (args) => {
    if (args.length < 2 || args.length > 3) throw new CalcError(`${name}(vx, vy [, vg]) erwartet`);
    const { x, y } = data(args, name);
    const starts = args[2] !== undefined ? [vec(args[2], name)] : guesses(x, y);
    let best: number[] | null = null, bestS = Infinity, lastErr: unknown;
    for (const g of starts) {
      try {
        const p = nlfit(x, y, model, g, name);
        const s = ssq(x, y, model, p);
        if (s < bestS) { bestS = s; best = p; }
      } catch (e) { lastErr = e; }
    }
    if (!best) throw lastErr instanceof CalcError ? lastErr : new CalcError(`${name}: keine Anpassung gefunden – Schätzwert vg angeben`);
    return col(best);
  };
}

/** Linear regression of ln|y − c| against x: start values for a·e^(b·x) + c. */
function expStarts(x: number[], y: number[]): number[][] {
  const ymin = Math.min(...y), ymax = Math.max(...y), span = ymax - ymin || 1;
  const out: number[][] = [];
  for (const c of [0, ymin - 0.05 * span, ymax + 0.05 * span, ymin - span, ymax + span]) {
    const d = y.map(v => v - c);
    const sgn = Math.sign(d[0]) || 1;
    if (!d.every(v => Math.sign(v) === sgn)) continue;
    try {
      const [lnA, b] = lstsq(x.map(xi => [1, xi]), d.map(v => Math.log(Math.abs(v))));
      out.push([sgn * Math.exp(lnA), b, c]);
    } catch { /* next */ }
  }
  return out.length ? out : [[1, 0.1, 0]];
}

export const FIT_BUILTINS: Record<string, Builtin> = {
  /** regress(vx, vy, k): polynomial of degree k; Mathcad layout [3; 3; k; a0 … ak] for interp. */
  regress: (args) => {
    if (args.length !== 3) throw new CalcError('regress(vx, vy, k) erwartet');
    const { x, y } = data(args, 'regress');
    const k = Math.round(toNumber(args[2], 'Grad'));
    if (!(k >= 1 && k <= 20)) throw new CalcError('regress: Grad k zwischen 1 und 20');
    const c = lstsq(x.map(xi => Array.from({ length: k + 1 }, (_, j) => xi ** j)), y);
    return col([3, 3, k, ...c]);
  },
  /** linfit(vx, vy, F): coefficients of the linear combination of the functions in the vector F(x). */
  linfit: (args, ev) => {
    if (args.length !== 3 || !isFnVal(args[2])) throw new CalcError('linfit(vx, vy, F) erwartet – F(x) liefert den Vektor der Ansatzfunktionen');
    const { x, y } = data(args, 'linfit');
    const F = args[2] as FnVal;
    const A = x.map(xi => { const r = ev.callFn(F, [xi]); return isMatrix(r) ? matrixRows(r as Matrix).flat().map(v => num(v)) : [num(r)]; });
    return col(lstsq(A, y));
  },
  /**
   * genfit(vx, vy, vg, F): parameters of any model. F(x, u) with the parameter vector u, F(x, u0, u1, …)
   * with single parameters (Prime) or F(x, u) returning [f; ∂f/∂u0; …] (Mathcad 15: only f is used).
   */
  genfit: (args, ev) => {
    if (args.length < 4 || !isFnVal(args[3])) throw new CalcError('genfit(vx, vy, vg, F) erwartet');
    const { x, y } = data(args, 'genfit');
    const g = vec(args[2], 'genfit');
    const F = args[3] as FnVal;
    const separate = !F.builtin && F.params.length === g.length + 1 && g.length > 1;
    const model = (xi: number, p: number[]) => {
      const r = separate ? ev.callFn(F, [xi, ...p]) : ev.callFn(F, [xi, col(p)]);
      return isMatrix(r) ? num(matrixRows(r as Matrix)[0][0]) : num(r);
    };
    return col(nlfit(x, y, model, g, 'genfit'));
  },
  /** a·e^(b·x) + c */
  expfit: special('expfit', (x, [a, b, c]) => a * Math.exp(b * x) + c, expStarts),
  /** a·ln(x) + b (linear, no guess needed) */
  lnfit: (args) => {
    if (args.length !== 2) throw new CalcError('lnfit(vx, vy) erwartet');
    const { x, y } = data(args, 'lnfit');
    if (x.some(v => v <= 0)) throw new CalcError('lnfit: alle x müssen positiv sein');
    return col(lstsq(x.map(v => [Math.log(v), 1]), y));
  },
  /** a·ln(x + b) + c */
  logfit: special('logfit', (x, [a, b, c]) => a * Math.log(x + b) + c, (x, y) => {
    const b = Math.max(0, 1 - Math.min(...x));
    try { const [a, c] = lstsq(x.map(v => [Math.log(v + b), 1]), y); return [[a, b, c]]; } catch { return [[1, b, 0]]; }
  }),
  /** a·x^b + c */
  pwrfit: special('pwrfit', (x, [a, b, c]) => a * Math.pow(x, b) + c, (x, y) => {
    const out: number[][] = [];
    if (x.every(v => v > 0) && y.every(v => v > 0)) { try { const [lnA, b] = lstsq(x.map(v => [1, Math.log(v)]), y.map(v => Math.log(v))); out.push([Math.exp(lnA), b, 0]); } catch { /* none */ } }
    out.push([1, 1, 0], [1, 2, 0], [1, 0.5, 0]);
    return out;
  }),
  /** a / (1 + b·e^(−c·x)) */
  lgsfit: special('lgsfit', (x, [a, b, c]) => a / (1 + b * Math.exp(-c * x)), (x, y) => {
    const a = Math.max(...y) * 1.05 || 1;
    return [[a, 1, 1], [a, 10, 0.5], [a, 0.1, 2]];
  }),
  /** a·sin(x + b) + c */
  sinfit: special('sinfit', (x, [a, b, c]) => a * Math.sin(x + b) + c, (x, y) => {
    const c = y.reduce((s, v) => s + v, 0) / y.length;
    const a = (Math.max(...y) - Math.min(...y)) / 2 || 1;
    return [0, Math.PI / 2, Math.PI, -Math.PI / 2].map(b => [a, b, c]);
  }),
};

/** interp for a regress vector [3; 3; k; a0 … ak]. */
export function interpRegress(vs: number[], t: number): number {
  const k = vs[2];
  return vs.slice(3, 4 + k).reduceRight((acc, a) => acc * t + a, 0);
}
