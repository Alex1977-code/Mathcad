/** Numerical algorithms operating on plain numbers. */

import { CalcError } from './values';

const XGK = [
  0.991455371120812639206854697526329, 0.949107912342758524526189684047851,
  0.864864423359769072789712788640926, 0.741531185599394439863864773280788,
  0.586087235467691130294144845693013, 0.405845151377397166906606412076961,
  0.207784955007898467600689403773245, 0.0,
];
const WGK = [
  0.022935322010529224963732008058970, 0.063092092629978553290700663189204,
  0.104790010322250183839876322541518, 0.140653259715525918745189590510238,
  0.169004726639267902826583426598550, 0.190350578064785409913256402421014,
  0.204432940075298892414161999234649, 0.209482141084727828012999174891714,
];
const WG = [
  0.129484966168869693270611432679082, 0.279705391489276667901467771423780,
  0.381830050505118944950369775488975, 0.417959183673469387755102040816327,
];

export const COUNTERS = { gk: 0, F: 0 };
// (counters are used for diagnostics only)
/** Gauss–Kronrod 7/15 rule: [integral, error estimate, integral of |f|]. */
function gk15(f: (x: number) => number, a: number, b: number): [number, number, number] {
  COUNTERS.gk++;
  const c = (a + b) / 2, h = (b - a) / 2;
  const fc = f(c);
  let resK = fc * WGK[7];
  let resG = fc * WG[3];
  let resAbs = Math.abs(fc) * WGK[7];
  for (let j = 0; j < 7; j++) {
    const dx = h * XGK[j];
    const f1 = f(c - dx), f2 = f(c + dx);
    resK += WGK[j] * (f1 + f2);
    resAbs += WGK[j] * (Math.abs(f1) + Math.abs(f2));
    if (j % 2 === 1) resG += WG[(j - 1) / 2] * (f1 + f2);
  }
  return [resK * h, Math.abs((resK - resG) * h), Math.abs(h) * resAbs];
}

/** Adaptive Gauss–Kronrod integration on a finite or infinite interval. */
export function integrate(f: (x: number) => number, a: number, b: number, tol = 1e-10): number {
  if (a === b) return 0;
  if (Math.abs(a) >= 1e300) a = a > 0 ? Infinity : -Infinity;
  if (Math.abs(b) >= 1e300) b = b > 0 ? Infinity : -Infinity;
  if (a > b) return -integrate(f, b, a, tol);
  let g = f, lo = a, hi = b;
  if (!isFinite(a) && !isFinite(b)) {
    g = (t: number) => { const x = t / (1 - t * t); return f(x) * (1 + t * t) / ((1 - t * t) ** 2); };
    lo = -1; hi = 1;
  } else if (!isFinite(b)) {
    g = (t: number) => { const x = a + t / (1 - t); return f(x) / ((1 - t) ** 2); };
    lo = 0; hi = 1;
  } else if (!isFinite(a)) {
    g = (t: number) => { const x = b - (1 - t) / t; return f(x) / (t * t); };
    lo = 0; hi = 1;
  }
  // a node rounded onto an end point (singularity there, or x = ∞ after the transformation) contributes nothing
  const near = (x: number) => Math.abs(x - lo) <= 8 * Number.EPSILON * Math.max(1, Math.abs(lo))
    || Math.abs(x - hi) <= 8 * Number.EPSILON * Math.max(1, Math.abs(hi));
  const guard = (x: number) => {
    let y: number;
    try { y = g(x); } catch (e) { if (near(x)) return 0; throw e; }
    if (isFinite(y)) return y;
    if (near(x)) return 0;
    throw new CalcError('Integrand nicht endlich');
  };
  type Seg = { a: number; b: number; v: number; e: number; abs: number };
  const first = gk15(guard, lo, hi);
  const segs: Seg[] = [{ a: lo, b: hi, v: first[0], e: first[1], abs: first[2] }];
  for (let it = 0; it < 600; it++) {
    let total = 0, err = 0, abs = 0, worst = 0;
    for (let i = 0; i < segs.length; i++) {
      total += segs[i].v; err += segs[i].e; abs += segs[i].abs;
      if (segs[i].e > segs[worst].e) worst = i;
    }
    // relative to the result, but never stricter than relative to ∫|f| (results near 0)
    if (err <= tol * Math.max(Math.abs(total), abs * 1e-3) || err < 1e-300) return total;
    const s = segs[worst];
    const m = (s.a + s.b) / 2;
    if (m <= s.a || m >= s.b) return total + endCorrection(segs);
    const l = gk15(guard, s.a, m), r = gk15(guard, m, s.b);
    segs.splice(worst, 1, { a: s.a, b: m, v: l[0], e: l[1], abs: l[2] }, { a: m, b: s.b, v: r[0], e: r[1], abs: r[2] });
  }
  return segs.reduce((t, s) => t + s.v, 0) + endCorrection(segs);

  /**
   * Not converged: usually an integrable singularity at an end point (x^p with −1 < p < 0), whose tiny
   * last segment GK cannot resolve. There the integrand follows a power law; its exact integral replaces
   * the estimate of that segment.
   */
  function endCorrection(ss: Seg[]): number {
    let corr = 0;
    for (const atLo of [true, false]) {
      const e = atLo ? lo : hi;
      const seg = ss.reduce<Seg | null>((best, x) => ((atLo ? x.a === lo : x.b === hi) && (!best || x.e > best.e) ? x : best), null);
      if (!seg || !isFinite(e)) continue;
      const w = seg.b - seg.a;
      try {
        const d1 = w / 2, d2 = w / 8;
        const f1 = g(atLo ? e + d1 : e - d1), f2 = g(atLo ? e + d2 : e - d2);
        if (!(isFinite(f1) && isFinite(f2)) || f1 === 0 || f1 * f2 <= 0) continue;
        const p = Math.log(f2 / f1) / Math.log(d2 / d1);
        if (!(p > -1 && p < -0.05)) continue;
        const C = f1 / Math.pow(d1, p);
        const exact = C * Math.pow(w, p + 1) / (p + 1);
        // only when the power law describes the segment well (three points agree)
        const d3 = w / 32, f3 = g(atLo ? e + d3 : e - d3);
        if (!(Math.abs(C * Math.pow(d3, p) - f3) <= 1e-3 * Math.abs(f3))) continue;
        corr += exact - seg.v;
      } catch { /* keep the estimate */ }
    }
    return corr;
  }
}

/** Central difference of order n with step h (error O(h²)). */
function centralDiff(f: (x: number) => number, x: number, n: number, h: number): number {
  if (n === 1) return (f(x + h) - f(x - h)) / (2 * h);
  // Σ (-1)^k C(n,k) f(x + (n/2 - k)·h) / hⁿ
  let s = 0, c = 1;
  for (let k = 0; k <= n; k++) {
    s += (k % 2 ? -c : c) * f(x + (n / 2 - k) * h);
    c = c * (n - k) / (k + 1);
  }
  return s / Math.pow(h, n);
}

/** Richardson extrapolation (Ridders) starting at step h0: estimate and error estimate. */
function ridders(D: (h: number) => number, h0: number): { v: number; err: number } {
  const N = 10;
  const T: number[][] = [];
  let h = h0, best = NaN, bestErr = Infinity;
  for (let i = 0; i < N; i++) {
    T[i] = [D(h)];
    if (!isFinite(T[i][0])) break;
    let fac = 1;
    for (let j = 1; j <= i; j++) {
      fac *= 4;
      T[i][j] = T[i][j - 1] + (T[i][j - 1] - T[i - 1][j - 1]) / (fac - 1);
      const err = Math.max(Math.abs(T[i][j] - T[i][j - 1]), Math.abs(T[i][j] - T[i - 1][j - 1]));
      if (err < bestErr) { bestErr = err; best = T[i][j]; }
    }
    if (i > 0 && Math.abs(T[i][i] - T[i - 1][i - 1]) > 2 * bestErr) break;
    h /= 2;
  }
  return { v: best, err: bestErr };
}

/**
 * Numerical derivative of order n (1..5). Several starting steps are tried (from 10 % of max(|x|, 1)
 * downwards), so poles or domain limits near x and fast variations are handled; the estimate with the
 * smallest error estimate wins.
 */
export function derivative(f: (x: number) => number, x: number, order = 1): number {
  if (order === 0) return f(x);
  const s = Math.max(Math.abs(x), 1);
  let best = NaN, bestErr = Infinity;
  let lastError: unknown;
  for (let k = 0; k <= 10; k++) {
    const h0 = 0.1 * order * s * Math.pow(10, -k);
    // below this step rounding errors dominate (differences of f become 0 and fake a zero error)
    if (h0 < 10 * s * Math.pow(Number.EPSILON, 1 / (order + 1))) break;
    try {
      const r = ridders(h => centralDiff(f, x, order, h), h0);
      if (isFinite(r.v) && r.err < bestErr) { best = r.v; bestErr = r.err; }
    } catch (e) { lastError = e; }
    if (bestErr <= 1e-12 * Math.max(Math.abs(best), 1e-300)) break;
  }
  if (!isFinite(best)) {
    if (lastError) throw lastError;
    throw new CalcError('Ableitung nicht berechenbar');
  }
  return best;
}

/** Brent's method on a bracketing interval. */
export function brent(f: (x: number) => number, a: number, b: number, tol = 1e-14): number {
  let fa = f(a), fb = f(b);
  if (fa === 0) return a;
  if (fb === 0) return b;
  if (fa * fb > 0) throw new CalcError('root: Funktionswerte an den Intervallgrenzen haben gleiches Vorzeichen');
  let c = a, fc = fa, d = b - a, e = d;
  for (let iter = 0; iter < 200; iter++) {
    if (fb * fc > 0) { c = a; fc = fa; d = b - a; e = d; }
    if (Math.abs(fc) < Math.abs(fb)) { a = b; b = c; c = a; fa = fb; fb = fc; fc = fa; }
    const tol1 = 2 * Number.EPSILON * Math.abs(b) + 0.5 * tol;
    const xm = 0.5 * (c - b);
    if (Math.abs(xm) <= tol1 || fb === 0) return b;
    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      const s = fb / fa;
      let p: number, q: number;
      if (a === c) { p = 2 * xm * s; q = 1 - s; }
      else {
        const qq = fa / fc, r = fb / fc;
        p = s * (2 * xm * qq * (qq - r) - (b - a) * (r - 1));
        q = (qq - 1) * (r - 1) * (s - 1);
      }
      if (p > 0) q = -q;
      p = Math.abs(p);
      if (2 * p < Math.min(3 * xm * q - Math.abs(tol1 * q), Math.abs(e * q))) { e = d; d = p / q; }
      else { d = xm; e = d; }
    } else { d = xm; e = d; }
    a = b; fa = fb;
    b += Math.abs(d) > tol1 ? d : (xm > 0 ? tol1 : -tol1);
    fb = f(b);
  }
  return b;
}

/** Root from a guess: secant iterations, falling back to bracket search + Brent. */
export function rootFromGuess(f: (x: number) => number, x0: number, tol = 1e-12): number {
  const g = x0;
  let x1 = x0 === 0 ? 1e-4 : x0 * (1 + 1e-4);
  let f0 = f(x0), f1 = f(x1);
  for (let i = 0; i < 100; i++) {
    if (!isFinite(f0) || !isFinite(f1)) break;
    if (Math.abs(f1) === 0) return x1;
    const den = f1 - f0;
    if (den === 0) break;
    const x2 = x1 - f1 * (x1 - x0) / den;
    if (!isFinite(x2)) break;
    // a nearly flat secant throws the iterate far away – rather search a bracket near the guess
    if (Math.abs(x2 - g) > 1e3 * Math.max(1, Math.abs(g))) break;
    x0 = x1; f0 = f1; x1 = x2; f1 = f(x1);
    if (Math.abs(x1 - x0) <= tol * Math.max(1, Math.abs(x1)) && Math.abs(f1) < 1e-6 * (1 + Math.abs(f0))) return x1;
  }
  // bracket search around the original guess
  let step = Math.max(Math.abs(g) * 0.1, 0.1);
  for (let i = 0; i < 60; i++) {
    for (const [a, b] of [[g, g + step], [g - step, g]]) {
      const fa = f(a), fb = f(b);
      if (isFinite(fa) && isFinite(fb) && fa * fb <= 0) return brent(f, a, b);
    }
    step *= 1.6;
  }
  throw new CalcError('root: keine Nullstelle gefunden – anderen Schätzwert versuchen');
}

/** Solve a nonlinear system F(x) = 0 (Levenberg–Marquardt with Broyden Jacobian updates). */
export function solveSystem(F0: (x: number[]) => number[], x0: number[], maxIter = 200): { x: number[]; residual: number } {
  const F = (v: number[]) => { COUNTERS.F++; return F0(v); };
  let x = x0.slice();
  const n = x.length;
  let r = F(x);
  let norm = Math.hypot(...r);
  let lambda = 1e-3;
  const m = r.length;
  const jacobian = (): number[][] => {
    const J: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const h = 1e-7 * Math.max(1, Math.abs(x[j]));
      const xp = x.slice(); xp[j] += h;
      const rp = F(xp);
      for (let i = 0; i < m; i++) J[i][j] = (rp[i] - r[i]) / h;
    }
    return J;
  };
  let J = jacobian();
  let fresh = true;
  for (let it = 0; it < maxIter && norm > 1e-11; it++) {
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
      const g = new Array(n).fill(0);
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) { let s = 0; for (let i = 0; i < m; i++) s += J[i][a] * J[i][b]; A[a][b] = s; }
        A[a][a] += lambda * (A[a][a] || 1);
        let s = 0; for (let i = 0; i < m; i++) s += J[i][a] * r[i]; g[a] = -s;
      }
      const delta = gaussSolve(A, g);
      if (!delta) { lambda *= 10; continue; }
      const xn = x.map((v, i) => v + delta[i]);
      const rn = F(xn);
      const nn = Math.hypot(...rn);
      if (isFinite(nn) && nn < norm) {
        // Broyden rank-1 update of the Jacobian
        const dr = rn.map((v, i) => v - r[i]);
        const dd = delta.reduce((s, v) => s + v * v, 0);
        if (dd > 0) for (let i = 0; i < m; i++) {
          let jd = 0; for (let j = 0; j < n; j++) jd += J[i][j] * delta[j];
          const c = (dr[i] - jd) / dd;
          for (let j = 0; j < n; j++) J[i][j] += c * delta[j];
        }
        x = xn; r = rn; norm = nn; lambda = Math.max(lambda / 10, 1e-12); improved = true; fresh = false;
        break;
      }
      if (!fresh) { J = jacobian(); fresh = true; continue; }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return { x, residual: norm };
}

export function gaussSolve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Inverse standard normal CDF (Acklam). */
export function qnormStd(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  let q: number, r: number, x: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pl) {
    q = p - 0.5; r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // one Newton refinement step
  const e = pnormStd(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}

export function erf(x: number): number { return 1 - erfc(x); }
export function erfc(x: number): number {
  // Numerical Recipes erfc (Chebyshev), rel. error < 1.2e-7, refined via continued fraction for large x
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/** Standard normal CDF with high accuracy (via series / continued fraction). */
export function pnormStd(x: number): number {
  // W. J. Cody's algorithm (rational approximations), accurate to ~1e-15
  const a = [2.2352520354606839287, 161.02823106855587881, 1067.6894854603709582, 18154.981253343561249, 0.065682337918207449113];
  const b = [47.20258190468824187, 976.09855173777669322, 10260.932208618978205, 45507.789335026729956];
  const c = [0.39894151208813466764, 8.8831497943883759412, 93.506656132177855979, 597.27027639480026226, 2494.5375852903726711, 6848.1904505362823326, 11602.651437647350124, 9842.7148383839780218, 1.0765576773720192317e-8];
  const d = [22.266688044328115691, 235.38790178262499861, 1519.377599407554805, 6485.558298266760755, 18615.571640885098091, 34900.952721145977266, 38912.003286093271411, 19685.429676859990727];
  const p = [0.21589853405795699, 0.1274011611602473639, 0.022235277870649807, 0.001421619193227893466, 2.9112874951168792e-5, 0.02307344176494017303];
  const q = [1.28426009614491121, 0.468238212480865118, 0.0659881378689285515, 0.00378239633202758244, 7.29751555083966205e-5];
  const y = Math.abs(x);
  let res: number;
  if (y <= 0.67448975) {
    const z = y > 1.11e-16 ? x * x : 0;
    let xn = a[4] * z, xd = z;
    for (let i = 0; i < 3; i++) { xn = (xn + a[i]) * z; xd = (xd + b[i]) * z; }
    const t = x * (xn + a[3]) / (xd + b[3]);
    return 0.5 + t;
  } else if (y <= Math.sqrt(32)) {
    let xn = c[8] * y, xd = y;
    for (let i = 0; i < 7; i++) { xn = (xn + c[i]) * y; xd = (xd + d[i]) * y; }
    res = (xn + c[7]) / (xd + d[7]);
    const xsq = Math.trunc(y * 16) / 16;
    const del = (y - xsq) * (y + xsq);
    res = Math.exp(-xsq * xsq * 0.5) * Math.exp(-del * 0.5) * res;
  } else {
    const z = 1 / (x * x);
    let xn = p[5] * z, xd = z;
    for (let i = 0; i < 4; i++) { xn = (xn + p[i]) * z; xd = (xd + q[i]) * z; }
    res = z * (xn + p[4]) / (xd + q[4]);
    res = (0.3989422804014327 - res) / y;
    const xsq = Math.trunc(x * 16) / 16;
    const del = (x - xsq) * (x + xsq);
    res = Math.exp(-xsq * xsq * 0.5) * Math.exp(-del * 0.5) * res;
  }
  return x > 0 ? 1 - res : res;
}
