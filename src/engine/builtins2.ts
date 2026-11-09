/**
 * Further Mathcad (Prime) functions: interpolation (splines, Neville, Thiele, rational), linear prediction,
 * outlier tests, rank statistics and contingency tables, singular values, look-ups.
 * Every definition was checked against results stored by Mathcad Prime (tests/fixtures/mathcad/prime).
 */
import type { Matrix, Unit } from 'mathjs';
import { CalcError, isComplex, isMatrix, isRange, isUnit, makeMatrix, matrixRows, rangeValues, toNumber, type Val } from './values';
import { betaI, gammaQ, DISTRIBUTIONS, urand } from './stats';
import { pnormStd } from './numeric';
import { mkQ } from './quantity';
import { math } from './units';
import type { Evaluator } from './evaluator';

type Builtin = (args: Val[], ev: Evaluator) => Val;

const nargs = (name: string, args: Val[], min: number, max = min) => {
  if (args.length < min || args.length > max) {
    throw new CalcError(`${name} erwartet ${min === max ? min : `${min}–${max}`} Argument${max === 1 ? '' : 'e'}`);
  }
};
/** Elements of a vector/matrix (row by row) or range. */
function els(v: Val): Val[] {
  if (isMatrix(v)) return matrixRows(v as Matrix).flat();
  if (isRange(v)) return rangeValues(v);
  return [v];
}
/** SI value of a scalar (quantities allowed). */
const si = (v: Val): number => (isUnit(v) ? (v as Unit).value as number : toNumber(v));
const dimsOf = (v: Val): number[] | null => (isUnit(v) ? (v as Unit).dimensions : null);
/** Plain number with the dimension of `tmpl` (quantity result). */
const withDims = (x: number, d: number[] | null): Val => (d ? mkQ(x, d.slice()) as Val : x);
const col = (vals: Val[]): Matrix => makeMatrix(vals.map(v => [v]));
const nums = (v: Val, what: string): number[] => {
  const e = els(v);
  if (!e.length) throw new CalcError(`${what}: keine Werte`);
  return e.map(si);
};
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
const Phi = (z: number) => pnormStd(z);

/* ------------------------------ splines -------------------------------- */

/** Cubic spline second derivatives; ends: 'l' natural (M=0), 'p' parabolic (M0=M1), 'c' cubic (linear M). */
function splineM(x: number[], y: number[], end: 'l' | 'p' | 'c'): number[] {
  const n = x.length;
  if (n < 3) throw new CalcError('Spline: mindestens 3 Punkte nötig');
  for (let i = 1; i < n; i++) if (!(x[i] > x[i - 1])) throw new CalcError('Spline: x-Werte müssen aufsteigend sortiert sein');
  const h = x.slice(1).map((v, i) => v - x[i]);
  // unknowns M1..M(n-2); tridiagonal system
  const m = n - 2;
  const a = new Array(m).fill(0), b = new Array(m).fill(0), c = new Array(m).fill(0), d = new Array(m).fill(0);
  for (let i = 1; i <= m; i++) {
    const k = i - 1;
    a[k] = h[i - 1]; b[k] = 2 * (h[i - 1] + h[i]); c[k] = h[i];
    d[k] = 6 * ((y[i + 1] - y[i]) / h[i] - (y[i] - y[i - 1]) / h[i - 1]);
  }
  if (end === 'p') { b[0] += a[0]; b[m - 1] += c[m - 1]; }
  if (end === 'c') {
    // M0 = 2 M1 − M2 (and the same at the other end)
    if (m === 1) { b[0] += a[0] + c[0]; }
    else {
      b[0] += 2 * a[0]; c[0] -= a[0];
      b[m - 1] += 2 * c[m - 1]; a[m - 1] -= c[m - 1];
    }
  }
  // Thomas algorithm
  for (let i = 1; i < m; i++) { const w = a[i] / b[i - 1]; b[i] -= w * c[i - 1]; d[i] -= w * d[i - 1]; }
  const M = new Array(n).fill(0);
  for (let i = m - 1; i >= 0; i--) M[i + 1] = (d[i] - (i < m - 1 ? c[i] * M[i + 2] : 0)) / b[i];
  if (end === 'p') { M[0] = M[1]; M[n - 1] = M[n - 2]; }
  if (end === 'c') { M[0] = 2 * M[1] - M[2]; M[n - 1] = 2 * M[n - 2] - M[n - 3]; }
  return M;
}
const SPLINE_MARK = 3;
const splineFn = (end: 'l' | 'p' | 'c'): Builtin => (args) => {
  nargs(`${end}spline`, args, 2);
  const x = nums(args[0], 'Spline'), y = nums(args[1], 'Spline');
  if (x.length !== y.length) throw new CalcError('Spline: x und y müssen gleich lang sein');
  // Mathcad layout: three leading entries, then the second derivatives
  return col([SPLINE_MARK, SPLINE_MARK, SPLINE_MARK, ...splineM(x, y, end)]);
};

function interpSpline(vs: number[], x: number[], y: number[], t: number): number {
  const M = vs.slice(3);
  if (M.length !== x.length) throw new CalcError('interp: Koeffizienten passen nicht zu den Daten');
  let i = 0;
  if (t >= x[x.length - 1]) i = x.length - 2;
  else if (t > x[0]) { let lo = 0, hi = x.length - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (x[mid] > t) hi = mid; else lo = mid; } i = lo; }
  const h = x[i + 1] - x[i], A = (x[i + 1] - t) / h, B = (t - x[i]) / h;
  return A * y[i] + B * y[i + 1] + ((A ** 3 - A) * M[i] + (B ** 3 - B) * M[i + 1]) * h * h / 6;
}

/* --------------------------- polynomial etc. ---------------------------- */

/** Neville interpolation (Numerical Recipes polint): value and error estimate. */
function polint(xa: number[], ya: number[], x: number): [number, number] {
  const n = xa.length;
  const c = ya.slice(), d = ya.slice();
  let ns = 0;
  for (let i = 1; i < n; i++) if (Math.abs(x - xa[i]) < Math.abs(x - xa[ns])) ns = i;
  let y = ya[ns--], dy = 0;
  for (let m = 1; m < n; m++) {
    for (let i = 0; i < n - m; i++) {
      const ho = xa[i] - x, hp = xa[i + m] - x, w = c[i + 1] - d[i], den = ho - hp;
      if (den === 0) throw new CalcError('polyint: zwei gleiche x-Werte');
      const f = w / den;
      d[i] = hp * f; c[i] = ho * f;
    }
    dy = 2 * (ns + 1) < n - m ? c[ns + 1] : d[ns--];
    y += dy;
  }
  return [y, dy];
}

/** Rational (Bulirsch–Stoer) interpolation (Numerical Recipes ratint): value and error estimate. */
function ratint(xa: number[], ya: number[], x: number): [number, number] {
  const n = xa.length, TINY = 1e-25;
  const c = new Array(n), d = new Array(n);
  let ns = 0, hh = Math.abs(x - xa[0]);
  for (let i = 0; i < n; i++) {
    const h = Math.abs(x - xa[i]);
    if (h === 0) return [ya[i], 0];
    if (h < hh) { ns = i; hh = h; }
    c[i] = ya[i]; d[i] = ya[i] + TINY;
  }
  let y = ya[ns--], dy = 0;
  for (let m = 1; m < n; m++) {
    for (let i = 0; i < n - m; i++) {
      const w = c[i + 1] - d[i], h = xa[i + m] - x, t = (xa[i] - x) * d[i] / h;
      let dd = t - c[i + 1];
      if (dd === 0) throw new CalcError('rationalint: Polstelle');
      dd = w / dd;
      d[i] = c[i + 1] * dd; c[i] = t * dd;
    }
    dy = 2 * (ns + 1) < n - m ? c[ns + 1] : d[ns--];
    y += dy;
  }
  return [y, dy];
}

/** Coefficients of the continued fraction of Thiele (inverse differences); 1/0 becomes ±10⁶⁵ as in Mathcad. */
function thieleCoeff(X: number[], Y: number[]): number[] {
  const BIG = 1e65;
  const div = (a: number, b: number) => (b !== 0 ? a / b : a >= 0 ? BIG : -BIG);
  const coef = [Y[0]];
  let prev = Y.slice();
  for (let k = 1; k < X.length; k++) {
    const cur = new Array(X.length).fill(0);
    for (let i = k; i < X.length; i++) cur[i] = div(X[i] - X[k - 1], prev[i] - prev[k - 1]);
    coef.push(cur[k]);
    prev = cur;
  }
  return coef;
}

/** Linear prediction with autoregressive coefficients by Burg's method (as Mathcad's predict). */
function burgPredict(x: number[], m: number, n: number): number[] {
  const N = x.length;
  if (!(m >= 1 && m < N)) throw new CalcError('predict: Anzahl der verwendeten Werte muss zwischen 1 und length(v) − 1 liegen');
  const f = x.slice(), b = x.slice();
  let a = [1];
  for (let k = 0; k < m; k++) {
    let num = 0, den = 0;
    for (let t = k + 1; t < N; t++) { num += f[t] * b[t - 1]; den += f[t] * f[t] + b[t - 1] * b[t - 1]; }
    if (den === 0) break;
    const mu = -2 * num / den;
    const ext = [...a, 0];
    a = ext.map((v, i) => v + mu * ext[ext.length - 1 - i]);
    for (let t = N - 1; t >= k + 1; t--) {
      const ft = f[t], bt = b[t - 1];
      f[t] = ft + mu * bt;
      b[t] = bt + mu * ft;
    }
  }
  const h = x.slice(), out: number[] = [];
  for (let s = 0; s < n; s++) {
    let v = 0;
    for (let j = 1; j < a.length; j++) v -= a[j] * h[h.length - j];
    out.push(v); h.push(v);
  }
  return out;
}

/* ------------------------------ statistics ------------------------------ */

/** Ranks 1…n, ties get the mean rank. */
function ranks(x: number[]): number[] {
  const idx = x.map((v, i) => i).sort((p, q) => x[p] - x[q]);
  const r = new Array(x.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && x[idx[j + 1]] === x[idx[i]]) j++;
    for (let k = i; k <= j; k++) r[idx[k]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
function pearson(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let s = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
  return s / Math.sqrt(sa * sb);
}
/** Kendall's τ_b (ties in both variables). */
function tauB(x: number[], y: number[]): number {
  let c = 0, d = 0, tx = 0, ty = 0;
  for (let i = 0; i < x.length; i++) for (let j = i + 1; j < x.length; j++) {
    const sx = Math.sign(x[i] - x[j]), sy = Math.sign(y[i] - y[j]);
    if (sx === 0 && sy === 0) continue;
    if (sx === 0) tx++;
    else if (sy === 0) ty++;
    else if (sx === sy) c++;
    else d++;
  }
  return (c - d) / Math.sqrt((c + d + tx) * (c + d + ty));
}
const tauResult = (tau: number, n: number): Matrix => {
  const z = tau / Math.sqrt(2 * (2 * n + 5) / (9 * n * (n - 1)));
  return col([tau, z, 2 * (1 - Phi(Math.abs(z)))]);
};
/** Student t quantile. */
const qt = (p: number, df: number) => {
  const D = DISTRIBUTIONS.t;
  let lo = -1e3, hi = 1e3;
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (D.p!(m, df) < p) lo = m; else hi = m; }
  return (lo + hi) / 2;
};
const pt = (x: number, df: number) => DISTRIBUTIONS.t.p!(x, df);
/** Grubbs test statistic (population standard deviation, as Mathcad) and the two-sided critical value. */
function grubbs(x: number[], conf: number): [number, number, number] {
  const n = x.length;
  if (n < 3) throw new CalcError('Grubbs: mindestens 3 Werte nötig');
  const m = mean(x), s = Math.sqrt(x.reduce((a, v) => a + (v - m) ** 2, 0) / n);
  let k = 0;
  for (let i = 1; i < n; i++) if (Math.abs(x[i] - m) > Math.abs(x[k] - m)) k = i;
  const G = Math.abs(x[k] - m) / s;
  const t = qt(1 - (1 - conf) / (2 * n), n - 2);
  const Gc = (n - 1) / Math.sqrt(n) * Math.sqrt(t * t / (n - 2 + t * t));
  return [k, G, Gc];
}
const vectorOnly = (v: Val, name: string) => {
  if (isMatrix(v)) { const s = (v as Matrix).size(); if (s[0] > 1 && s[1] > 1) throw new CalcError(`${name}: nur für Vektoren`); }
  return nums(v, name);
};

/**
 * Grubbs / three-sigma result as a row: [index; G; G_crit − G] (or [index; G]). A matrix is one sample of all
 * its elements; the index is then the vector [row; column] of the suspected outlier (as Mathcad Prime).
 */
function outlierTest(v: Val, conf: number, ev: Evaluator, withCrit: boolean): Matrix {
  const o = ev.opts.origin;
  let index: Val, data: number[];
  const s = isMatrix(v) ? (v as Matrix).size() : [1, 1];
  const cols = s[1];
  if (isMatrix(v) && s[0] > 1 && cols > 1) data = matrixRows(v as Matrix).flat().map(si);
  else data = nums(v, 'Grubbs');
  const [k, G, Gc] = grubbs(data, conf);
  if (isMatrix(v) && s[0] > 1 && cols > 1) index = makeMatrix([[Math.floor(k / cols) + o], [(k % cols) + o]]);
  else index = k + o;
  return makeMatrix([withCrit ? [index, G, Gc - G] : [index, G]]);
}

/* --------------------------- Spline2 (B-splines) --------------------------- */

/** Clamped knot vector of degree k from the break points (first/last repeated k+1 times). */
const clamped = (br: number[], k: number) => [...Array(k).fill(br[0]), ...br, ...Array(k).fill(br[br.length - 1])];

/** Values of all B-splines of degree k at x (knot vector t). */
function bsplineBasis(t: number[], k: number, x: number): number[] {
  const nb = t.length - k - 1;
  // knot span (the last span for x at or beyond the end, the first one before the start)
  let i = k;
  while (i < nb - 1 && x >= t[i + 1]) i++;
  // Cox–de Boor on span i: N[r] = B_{i-d+r, d}
  let N = [1];
  for (let d = 1; d <= k; d++) {
    const cur = new Array(d + 1).fill(0);
    for (let r = 0; r < d; r++) {
      const left = t[i + r + 1], right = t[i + r + 1 - d];
      const temp = left - right !== 0 ? N[r] / (left - right) : 0;
      cur[r] += (left - x) * temp;
      cur[r + 1] += (x - right) * temp;
    }
    N = cur;
  }
  const row = new Array(nb).fill(0);
  for (let r = 0; r <= k; r++) row[i - k + r] = N[r];
  return row;
}

/** Value of the q-th derivative of the spline Σ c_j B_j (degree k, knots t): differentiate the coefficients. */
function splineEval(t: number[], c: number[], k: number, x: number, q = 0): number {
  let tt = t, cc = c, kk = k;
  for (let d = 0; d < q; d++) {
    if (kk === 0) return 0;
    const nc: number[] = [];
    for (let j = 0; j < cc.length - 1; j++) {
      const den = tt[j + kk + 1] - tt[j + 1];
      nc.push(den !== 0 ? kk * (cc[j + 1] - cc[j]) / den : 0);
    }
    tt = tt.slice(1, -1); cc = nc; kk--;
  }
  const B = bsplineBasis(tt, kk, x);
  return B.reduce((s2, b2, j) => s2 + b2 * cc[j], 0);
}

/** Linear least squares by Householder QR. */
function lsq(A: number[][], b: number[]): number[] {
  const m = A.length, n = A[0].length;
  const R = A.map(r => r.slice()), y = b.slice();
  for (let j = 0; j < n; j++) {
    let norm = 0;
    for (let i = j; i < m; i++) norm += R[i][j] * R[i][j];
    norm = Math.sqrt(norm);
    if (norm === 0) continue;
    const alpha = R[j][j] > 0 ? -norm : norm;
    const v = new Array(m).fill(0);
    v[j] = R[j][j] - alpha;
    for (let i = j + 1; i < m; i++) v[i] = R[i][j];
    const vv = v.reduce((s2, x, i) => (i >= j ? s2 + x * x : s2), 0);
    if (vv === 0) continue;
    for (let c = j; c < n; c++) {
      let d = 0;
      for (let i = j; i < m; i++) d += v[i] * R[i][c];
      d = 2 * d / vv;
      for (let i = j; i < m; i++) R[i][c] -= d * v[i];
    }
    let d = 0;
    for (let i = j; i < m; i++) d += v[i] * y[i];
    d = 2 * d / vv;
    for (let i = j; i < m; i++) y[i] -= d * v[i];
  }
  const xs = new Array(n).fill(0);
  for (let j = n - 1; j >= 0; j--) {
    let s2 = y[j];
    for (let c = j + 1; c < n; c++) s2 -= R[j][c] * xs[c];
    if (Math.abs(R[j][j]) < 1e-300) throw new CalcError('Spline2: zu wenige Datenpunkte zwischen den Knoten');
    xs[j] = s2 / R[j][j];
  }
  return xs;
}

interface SplineFit { br: number[]; k: number; c: number[]; s: number; dw: number; hi: number; lo: number }

/**
 * Least-squares B-spline fit with the break points br. Statistics as Mathcad: standard error
 * √(SSE/(n−p)), Durbin–Watson statistic of the residuals and the probabilities P(d_U ≥ 4 − DW) and
 * P(d_U ≤ DW) of the upper Durbin–Watson bound d_U (beta approximation with its exact mean and variance).
 */
function splineFit(x: number[], y: number[], br: number[], k: number, w?: number[]): SplineFit {
  const t = clamped(br, k), n = x.length;
  const X = x.map(v => bsplineBasis(t, k, v));
  const p = X[0].length;
  if (n <= p) throw new CalcError('Spline2: zu wenige Datenpunkte für die Anzahl der Knoten');
  const sw = w ? w.map(v => Math.sqrt(v)) : null;
  const c = lsq(sw ? X.map((r, i) => r.map(v => v * sw[i])) : X, sw ? y.map((v, i) => v * sw[i]) : y);
  const e = y.map((v, i) => (v - X[i].reduce((s2, b, j) => s2 + b * c[j], 0)) * (sw ? sw[i] : 1));
  const sse = e.reduce((s2, v) => s2 + v * v, 0);
  let num = 0;
  for (let i = 1; i < n; i++) num += (e[i] - e[i - 1]) ** 2;
  const dw = num / sse;
  // eigenvalues of the Durbin–Watson matrix: 2(1 − cos(πj/n)); d_U uses the n − p largest
  const U: number[] = [];
  for (let j = p; j < n; j++) U.push(2 * (1 - Math.cos(Math.PI * j / n)));
  const m = U.length, E = U.reduce((a2, b2) => a2 + b2, 0) / m;
  const V = 2 * U.reduce((a2, b2) => a2 + (b2 - E) ** 2, 0) / (m * (m + 2));
  const mu = E / 4, va = V / 16, cc = mu * (1 - mu) / va - 1, al = mu * cc, be = (1 - mu) * cc;
  const lo = betaI(dw / 4, al, be), hi = 1 - betaI((4 - dw) / 4, al, be);
  return { br, k, c, s: Math.sqrt(sse / (n - p)), dw, hi, lo };
}

/**
 * New break points for m intervals that equidistribute |s⁽ᵏ⁾|^(1/(k+1)) of the current fit (de Boor's
 * NEWNOT). Approximation of Mathcad's (undocumented) adaptive knot placement.
 */
function newKnots(f: SplineFit, m: number): number[] {
  const t = clamped(f.br, f.k);
  const g = f.br.slice(0, -1).map((a2, i) => {
    const mid = (a2 + f.br[i + 1]) / 2;
    const d = splineEval(t, f.c, f.k, mid, f.k);
    return Math.abs(d) ** (1 / (f.k + 1)) * (f.br[i + 1] - a2);
  });
  const cum = [0];
  for (const v of g) cum.push(cum[cum.length - 1] + v);
  const total = cum[cum.length - 1];
  const a0 = f.br[0], a1 = f.br[f.br.length - 1];
  if (!(total > 0)) return Array.from({ length: m + 1 }, (_, i) => a0 + (a1 - a0) * i / m);
  const out = [a0];
  for (let q = 1; q < m; q++) {
    const target = total * q / m;
    let i = 0;
    while (i < g.length - 1 && cum[i + 1] < target) i++;
    const frac = g[i] > 0 ? (target - cum[i]) / g[i] : 0;
    out.push(f.br[i] + frac * (f.br[i + 1] - f.br[i]));
  }
  out.push(a1);
  return out;
}

function spline2(x: number[], y: number[], k: number, w: number[] | undefined, spec: number | number[]): SplineFit {
  const order = x.map((_, i) => i).sort((a2, b2) => x[a2] - x[b2]);
  const xs = order.map(i => x[i]), ys = order.map(i => y[i]), ws = w ? order.map(i => w[i]) : undefined;
  const a0 = xs[0], a1 = xs[xs.length - 1];
  if (Array.isArray(spec)) {
    // given knots: they must cover the data
    const kn = Array.from(new Set(spec)).sort((p, q) => p - q);
    if (kn[0] > a0) kn.unshift(a0);
    if (kn[kn.length - 1] < a1) kn.push(a1);
    return splineFit(xs, ys, kn, k, ws);
  }
  // automatic: more intervals while the residuals show positive autocorrelation (P(d_U ≤ DW) < level)
  const level = spec;
  let m = 1, f = splineFit(xs, ys, [a0, a1], k);
  while (f.lo < level) {
    const next = newKnots(f, m + 1);
    let g: SplineFit;
    try { g = splineFit(xs, ys, next, k); } catch { break; }
    m++; f = g;
  }
  return f;
}

const splineVector = (f: SplineFit): Matrix =>
  col([f.k + 1, f.br.length - 1, ...f.br, ...f.c, f.s, 0, f.dw, f.hi, f.lo]);

/** Read a Spline2 result vector back. */
function readSpline(v: Val): { k: number; br: number[]; c: number[]; stats: number[] } {
  const b = nums(v, 'Spline2-Vektor');
  const k = Math.round(b[0]) - 1, m = Math.round(b[1]);
  if (!(k >= 1 && m >= 1) || b.length !== 2 + (m + 1) + (m + k) + 5) throw new CalcError('Ergebnis von Spline2 erwartet');
  return { k, br: b.slice(2, 3 + m), c: b.slice(3 + m, 3 + m + m + k), stats: b.slice(-5) };
}

/* ------------------------------ functions -------------------------------- */

export const EXTRA_BUILTINS: Record<string, Builtin> = {
  Spline2: (args) => {
    // Spline2(vx, vy, [degree], [weights], [level | knots])
    nargs('Spline2', args, 2, 5);
    const x = nums(args[0], 'Spline2'), y = nums(args[1], 'Spline2');
    if (x.length !== y.length) throw new CalcError('Spline2: x und y müssen gleich lang sein');
    let k = 3, w: number[] | undefined, spec: number | number[] = 0.05;
    const rest = args.slice(2);
    if (rest.length && !isMatrix(rest[0])) k = Math.round(toNumber(rest.shift()!, 'Grad'));
    if (!(k >= 1 && k <= 5)) throw new CalcError('Spline2: Grad 1 bis 5');
    for (const a2 of rest) {
      // a vector as long as the data are the weights (standard deviations), any other vector the knots
      if (isMatrix(a2) && els(a2).length === x.length && w === undefined) w = nums(a2, 'Spline2');
      else if (isMatrix(a2)) spec = nums(a2, 'Spline2');
      else spec = toNumber(a2, 'Niveau');
    }
    // with automatic knots Mathcad's result does not depend on the weights (observed in its stored results);
    // with given knots they weight the residuals by 1/w² (not confirmed exactly by Mathcad's results)
    return splineVector(spline2(x, y, k, Array.isArray(spec) && w ? w.map(v => 1 / (v * v)) : undefined, spec));
  },
  DWS: (args) => { nargs('DWS', args, 1); return readSpline(args[0]).stats[2]; },
  Binterp: (args) => {
    // value and derivatives 1–3 of a Spline2 result: one column per point
    nargs('Binterp', args, 2);
    const { k, br, c } = readSpline(args[1]);
    const t = clamped(br, k);
    const pts = isMatrix(args[0]) ? els(args[0]).map(si) : [si(args[0])];
    const cols = pts.map(p => [0, 1, 2, 3].map(q => splineEval(t, c, k, p, q)));
    return makeMatrix([0, 1, 2, 3].map(q => cols.map(cl => cl[q])));
  },
  lspline: splineFn('l'),
  pspline: splineFn('p'),
  cspline: splineFn('c'),
  interp: (args) => {
    nargs('interp', args, 4);
    const vs = nums(args[0], 'interp'), x = nums(args[1], 'interp'), y = els(args[2]);
    if (vs[0] !== SPLINE_MARK) throw new CalcError('interp: erstes Argument muss aus lspline, pspline oder cspline stammen');
    const d = dimsOf(y[0]);
    const f = (t: Val) => withDims(interpSpline(vs, x, y.map(si), si(t)), d);
    return isMatrix(args[3]) ? makeMatrix(matrixRows(args[3] as Matrix).map(r => r.map(f))) : f(args[3]);
  },
  polyint: (args) => {
    nargs('polyint', args, 3);
    const x = nums(args[0], 'polyint'), yv = els(args[1]);
    if (x.length !== yv.length) throw new CalcError('polyint: x und y müssen gleich lang sein');
    const d = dimsOf(yv[0]);
    const [v, e] = polint(x, yv.map(si), si(args[2]));
    return col([withDims(v, d), withDims(e, d)]);
  },
  polyiter: (args) => {
    // points in the given order; stops when two successive values differ by less than ε
    nargs('polyiter', args, 5);
    const x = nums(args[0], 'polyiter'), yv = els(args[1]);
    const y = yv.map(si), t = si(args[2]), N = Math.round(toNumber(args[3], 'Anzahl')), eps = si(args[4]);
    const d = dimsOf(yv[0]);
    let prev: number | undefined, v = y[0];
    for (let k = 1; k <= N; k++) {
      if (k + 1 > x.length) break;
      v = polint(x.slice(0, k + 1), y.slice(0, k + 1), t)[0];
      if (prev !== undefined && Math.abs(v - prev) < eps) return col([withDims(1, d), withDims(k, d), withDims(v, d)]);
      prev = v;
    }
    return col([withDims(0, d), withDims(N, d), withDims(v, d)]);
  },
  polycoeff: (args) => {
    // coefficients of the interpolating polynomial, lowest order first
    nargs('polycoeff', args, 2);
    const x = nums(args[0], 'polycoeff'), y = nums(args[1], 'polycoeff');
    if (x.length !== y.length) throw new CalcError('polycoeff: x und y müssen gleich lang sein');
    const n = x.length;
    const A = x.map(v => Array.from({ length: n }, (_, j) => v ** j));
    const sol = math.lusolve(A, y.map(v => [v])) as unknown as number[][] | Matrix;
    const flat = (Array.isArray(sol) ? sol : (sol as Matrix).toArray() as number[][]).map(r => (Array.isArray(r) ? r[0] : r) as number);
    return col(flat);
  },
  Thielecoeff: (args) => {
    nargs('Thielecoeff', args, 2);
    const X = nums(args[0], 'Thielecoeff'), Y = nums(args[1], 'Thielecoeff');
    if (X.length !== Y.length) throw new CalcError('Thielecoeff: x und y müssen gleich lang sein');
    return col(thieleCoeff(X, Y));
  },
  Thiele: (args) => {
    nargs('Thiele', args, 3);
    const X = nums(args[0], 'Thiele'), c = nums(args[1], 'Thiele');
    const f = (t: number) => { let v = c[c.length - 1]; for (let k = c.length - 2; k >= 0; k--) v = c[k] + (t - X[k]) / v; return v; };
    return isMatrix(args[2]) ? makeMatrix(matrixRows(args[2] as Matrix).map(r => r.map(t => f(si(t))))) : f(si(args[2]));
  },
  rationalint: (args) => {
    nargs('rationalint', args, 3);
    const [v, e] = ratint(nums(args[0], 'rationalint'), nums(args[1], 'rationalint'), si(args[2]));
    return col([v, e]);
  },
  predict: (args) => {
    nargs('predict', args, 3);
    const v = nums(args[0], 'predict');
    return col(burgPredict(v, Math.round(toNumber(args[1], 'Anzahl')), Math.round(toNumber(args[2], 'Anzahl'))));
  },
  svds: (args) => {
    nargs('svds', args, 1);
    const M = args[0] as Matrix;
    if (!isMatrix(M)) throw new CalcError('svds: Matrix erwartet');
    const A = matrixRows(M).map(r => r.map(si));
    const AtA = math.multiply(math.transpose(A), A) as number[][];
    const ev = (math.eigs(AtA).values as unknown as number[]).map(v => Math.sqrt(Math.max(0, v)));
    return col(ev.sort((p, q) => q - p));
  },
  rhypergeom: (args) => {
    // m random numbers of the hypergeometric distribution (a successes, b failures, n drawn), by inversion
    nargs('rhypergeom', args, 4);
    const [m, a, b, n] = args.map(v => Math.round(toNumber(v)));
    const lc = (N: number, k: number) => { let s = 0; for (let i = 1; i <= k; i++) s += Math.log((N - k + i) / i); return s; };
    const pk = (k: number) => Math.exp(lc(a, k) + lc(b, n - k) - lc(a + b, n));
    const out: number[] = [];
    for (let i = 0; i < m; i++) {
      const u = urand();
      let k = Math.max(0, n - b), s = pk(k);
      while (s < u && k < Math.min(a, n)) { k++; s += pk(k); }
      out.push(k);
    }
    return col(out);
  },
  vhlookup: (args, ev) => {
    // value(s) at the row whose first column is r and the column whose first row is c
    nargs('vhlookup', args, 3);
    const rows = matrixRows(args[2] as Matrix);
    const eq = (p: Val, q: Val) => (typeof p === 'string' || typeof q === 'string' ? p === q : Math.abs(si(p) - si(q)) <= 1e-12 * Math.max(1, Math.abs(si(q))));
    const out: Val[] = [];
    rows.forEach((r, i) => { if (i > 0 && eq(r[0], args[0])) rows[0].forEach((h, j) => { if (j > 0 && eq(h, args[1])) out.push(r[j]); }); });
    void ev;
    if (!out.length) throw new CalcError('vhlookup: Wert nicht gefunden');
    return col(out);
  },
  Rank: (args) => { nargs('Rank', args, 1); return col(ranks(vectorOnly(args[0], 'Rank'))); },
  Spear: (args) => {
    // [Σd²; z; p(z); r_s; p(t)] – z with the sign convention of Mathcad
    nargs('Spear', args, 2);
    const x = vectorOnly(args[0], 'Spear'), y = vectorOnly(args[1], 'Spear');
    if (x.length !== y.length) throw new CalcError('Spear: Vektoren müssen gleich lang sein');
    const n = x.length, rx = ranks(x), ry = ranks(y);
    const D = rx.reduce((s, v, i) => s + (v - ry[i]) ** 2, 0);
    const rs = pearson(rx, ry);
    const z = -rs * Math.sqrt(n - 1);
    const t = rs * Math.sqrt((n - 2) / (1 - rs * rs));
    return col([D, z, 2 * (1 - Phi(Math.abs(z))), rs, 2 * (1 - pt(Math.abs(t), n - 2))]);
  },
  kendltau: (args) => {
    nargs('kendltau', args, 2);
    const x = vectorOnly(args[0], 'kendltau'), y = vectorOnly(args[1], 'kendltau');
    if (x.length !== y.length) throw new CalcError('kendltau: Vektoren müssen gleich lang sein');
    return tauResult(tauB(x, y), x.length);
  },
  kendltau2: (args) => {
    // contingency table of two ordinal variables (counts)
    nargs('kendltau2', args, 1);
    const T = matrixRows(args[0] as Matrix).map(r => r.map(v => Math.round(si(v))));
    const xs: number[] = [], ys: number[] = [];
    T.forEach((r, i) => r.forEach((c, j) => { for (let k = 0; k < c; k++) { xs.push(i); ys.push(j); } }));
    return tauResult(tauB(xs, ys), xs.length);
  },
  contingtbl: (args) => {
    // [χ²; degrees of freedom; p; Cramér's V; contingency coefficient C]
    nargs('contingtbl', args, 1);
    const T = matrixRows(args[0] as Matrix).map(r => r.map(si));
    const R = T.length, C = T[0].length;
    const rs = T.map(r => r.reduce((a, b) => a + b, 0)), cs = T[0].map((_, j) => T.reduce((a, r) => a + r[j], 0));
    const N = rs.reduce((a, b) => a + b, 0);
    let chi = 0;
    for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) { const e = rs[i] * cs[j] / N; chi += (T[i][j] - e) ** 2 / e; }
    const df = (R - 1) * (C - 1);
    return col([chi, df, gammaQ(df / 2, chi / 2), Math.sqrt(chi / (N * (Math.min(R, C) - 1))), Math.sqrt(chi / (chi + N))]);
  },
  Ftest: (args) => {
    // [F = var(a)/var(b); p two-sided] with the F distribution (n_a − 1, n_b − 1)
    nargs('Ftest', args, 2);
    const a = nums(args[0], 'Ftest'), b = nums(args[1], 'Ftest');
    const v = (x: number[]) => { const m = mean(x); return x.reduce((s, t) => s + (t - m) ** 2, 0) / (x.length - 1); };
    const F = v(a) / v(b), d1 = a.length - 1, d2 = b.length - 1;
    const cdf = betaI(d1 * F / (d1 * F + d2), d1 / 2, d2 / 2);
    return col([F, 2 * Math.min(cdf, 1 - cdf)]);
  },
  Grubbs: (args, ev) => { nargs('Grubbs', args, 2); return outlierTest(args[0], toNumber(args[1]), ev, true); },
  GrubbsClassic: (args, ev) => { nargs('GrubbsClassic', args, 2); return outlierTest(args[0], toNumber(args[1]), ev, true); },
  ThreeSigma: (args, ev) => { nargs('ThreeSigma', args, 1); return outlierTest(args[0], 0.95, ev, false); },
  trim: (args, ev) => {
    // remove the rows with the given indices
    nargs('trim', args, 2);
    const drop = new Set(els(args[1]).map(v => Math.round(toNumber(v)) - ev.opts.origin));
    const rows = isMatrix(args[0]) ? matrixRows(args[0] as Matrix) : [[args[0]]];
    const kept = rows.filter((_, i) => !drop.has(i));
    if (!kept.length) throw new CalcError('trim: alle Zeilen entfernt');
    return makeMatrix(kept);
  },
};
void isComplex;
