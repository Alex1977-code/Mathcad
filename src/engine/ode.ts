/**
 * Ordinary differential equations: adaptive Dormand–Prince 5(4) with dense output (Hermite), classical
 * Runge–Kutta 4 with fixed steps (Mathcad's rkfixed).
 */
import { CalcError } from './values';

export type OdeRhs = (t: number, y: number[]) => number[];
export interface OdeSolution { t: number[]; y: number[][]; f: number[][] }

const C = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1];
const A = [
  [],
  [1 / 5],
  [3 / 40, 9 / 40],
  [44 / 45, -56 / 15, 32 / 9],
  [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
  [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656],
  [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84],
];
const B5 = [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0];
const B4 = [5179 / 57600, 0, 7571 / 16695, 393 / 640, -92097 / 339200, 187 / 2100, 1 / 40];

const finite = (v: number[]) => v.every(Number.isFinite);

/** Adaptive integration from t0 to t1 (either direction). Every accepted step is stored for interpolation. */
export function dopri(f: OdeRhs, t0: number, y0: number[], t1: number, o: { rtol?: number; atol?: number; maxSteps?: number } = {}): OdeSolution {
  const rtol = o.rtol ?? 1e-10, atol = o.atol ?? 1e-13, maxSteps = o.maxSteps ?? 200000;
  const n = y0.length, dir = Math.sign(t1 - t0) || 1;
  let t = t0, y = y0.slice(), k1 = f(t, y);
  if (!finite(k1)) throw new CalcError('Differentialgleichung: die rechte Seite ist am Anfangspunkt nicht definiert');
  const sol: OdeSolution = { t: [t], y: [y.slice()], f: [k1.slice()] };
  const span = Math.abs(t1 - t0);
  if (span === 0) return sol;
  // initial step (Hairer–Wanner)
  const sc = (i: number) => atol + rtol * Math.abs(y[i]);
  const d0 = Math.sqrt(y.reduce((s, v, i) => s + (v / sc(i)) ** 2, 0) / n), d1 = Math.sqrt(k1.reduce((s, v, i) => s + (v / sc(i)) ** 2, 0) / n);
  let h = Math.min(span, d0 < 1e-5 || d1 < 1e-5 ? 1e-6 * Math.max(1, span) : 0.01 * d0 / d1) * dir;
  for (let step = 0; step < maxSteps; step++) {
    if ((t1 - t) * dir <= 1e-14 * Math.max(1, Math.abs(t1))) return sol;
    // at most 1/200 of the interval per step: keeps the interpolation between the steps accurate
    if (Math.abs(h) > span / 200) h = dir * span / 200;
    if ((t + h - t1) * dir > 0) h = t1 - t;
    const k: number[][] = [k1];
    for (let s = 1; s < 7; s++) {
      const ys = y.map((v, i) => v + h * A[s].reduce((acc, a, j) => acc + a * k[j][i], 0));
      k.push(f(t + C[s] * h, ys));
    }
    const y5 = y.map((v, i) => v + h * B5.reduce((acc, b, j) => acc + b * k[j][i], 0));
    const y4 = y.map((v, i) => v + h * B4.reduce((acc, b, j) => acc + b * k[j][i], 0));
    let err = 0;
    for (let i = 0; i < n; i++) err += ((y5[i] - y4[i]) / (atol + rtol * Math.max(Math.abs(y[i]), Math.abs(y5[i])))) ** 2;
    err = Math.sqrt(err / n);
    if (!Number.isFinite(err) || !finite(y5)) { h /= 4; if (Math.abs(h) < 1e-14 * Math.max(1, Math.abs(t))) throw new CalcError(`Differentialgleichung: Lösung bricht bei t = ${+t.toPrecision(6)} ab (Singularität?)`); continue; }
    if (err <= 1) {
      t += h; y = y5; k1 = k[6];   // FSAL: the last stage is f(t+h, y5)
      sol.t.push(t); sol.y.push(y.slice()); sol.f.push(k1.slice());
    }
    const fac = err === 0 ? 5 : Math.min(5, Math.max(0.2, 0.9 * err ** -0.2));
    h *= fac;
    if (Math.abs(h) < 1e-14 * Math.max(1, Math.abs(t))) throw new CalcError(`Differentialgleichung: Schrittweite zu klein bei t = ${+t.toPrecision(6)} (steif oder singulär)`);
  }
  throw new CalcError('Differentialgleichung: zu viele Schritte');
}

/** Value of the solution at x (cubic Hermite between stored steps; exact at the steps). */
export function evalSolution(sol: OdeSolution, x: number, comp: number): number {
  const ts = sol.t, n = ts.length;
  const lo = Math.min(ts[0], ts[n - 1]), hi = Math.max(ts[0], ts[n - 1]);
  const tol = 1e-9 * Math.max(1, Math.abs(hi - lo));
  if (x < lo - tol || x > hi + tol) throw new CalcError(`Lösung nur zwischen ${+lo.toPrecision(6)} und ${+hi.toPrecision(6)} berechnet`);
  if (n === 1) return sol.y[0][comp];
  const inc = ts[n - 1] > ts[0];
  // binary search for the interval
  let a = 0, b = n - 1;
  while (b - a > 1) { const m = (a + b) >> 1; if ((ts[m] <= x) === inc) a = m; else b = m; }
  const t0 = ts[a], t1 = ts[b], h = t1 - t0;
  const s = h === 0 ? 0 : (x - t0) / h;
  const y0 = sol.y[a][comp], y1 = sol.y[b][comp], f0 = sol.f[a][comp], f1 = sol.f[b][comp];
  const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
  return h00 * y0 + h10 * h * f0 + h01 * y1 + h11 * h * f1;
}

/** Classical Runge–Kutta 4 with n equal steps (Mathcad's rkfixed): rows [t, y0, y1, …]. */
export function rk4Fixed(f: OdeRhs, t0: number, y0: number[], t1: number, n: number): number[][] {
  const h = (t1 - t0) / n;
  let y = y0.slice();
  const out = [[t0, ...y]];
  for (let i = 0; i < n; i++) {
    const t = t0 + i * h;
    const k1 = f(t, y);
    const k2 = f(t + h / 2, y.map((v, j) => v + h / 2 * k1[j]));
    const k3 = f(t + h / 2, y.map((v, j) => v + h / 2 * k2[j]));
    const k4 = f(t + h, y.map((v, j) => v + h * k3[j]));
    y = y.map((v, j) => v + h / 6 * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    if (!finite(y)) throw new CalcError(`rkfixed: Lösung divergiert bei t = ${+(t + h).toPrecision(6)}`);
    out.push([t0 + (i + 1) * h, ...y]);
  }
  return out;
}
