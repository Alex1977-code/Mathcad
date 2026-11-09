/** Special functions and probability distributions (Mathcad naming: d…, p…, q…, r…). */
import { CalcError } from './values';
import { pnormStd, qnormStd } from './numeric';

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61503916999185, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

export function lgamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized lower incomplete gamma P(a, x). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a, del = sum, ap = a;
    for (let n = 0; n < 1000; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-16) break; }
    return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  return 1 - gammaQcf(a, x);
}
function gammaQcf(a: number, x: number): number {
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}

function betacf(a: number, b: number, x: number): number {
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < 1e-300) d = 1e-300;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 1000; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function betaI(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return bt * betacf(a, b, x) / a;
  return 1 - bt * betacf(b, a, 1 - x) / b;
}

/** Invert a monotone CDF by bisection + secant refinement. */
function invert(cdf: (x: number) => number, p: number, lo: number, hi: number, discrete = false): number {
  if (p < 0 || p > 1) throw new CalcError('Wahrscheinlichkeit muss zwischen 0 und 1 liegen');
  // expand bracket
  let k = 0;
  while (cdf(hi) < p && k++ < 200) { lo = hi; hi = hi * 2 + 1; }
  k = 0;
  while (cdf(lo) > p && k++ < 200) { hi = lo; lo = lo < 0 ? lo * 2 - 1 : (lo === 0 ? -1 : lo / 2); }
  if (discrete) {
    let a = Math.floor(lo), b = Math.ceil(hi);
    while (b - a > 1) { const m = Math.floor((a + b) / 2); if (cdf(m) >= p) b = m; else a = m; }
    return cdf(a) >= p ? a : b;
  }
  for (let i = 0; i < 200; i++) {
    const m = (lo + hi) / 2;
    if (cdf(m) < p) lo = m; else hi = m;
    if (hi - lo <= 1e-15 * Math.max(1, Math.abs(m))) break;
  }
  return (lo + hi) / 2;
}

const lchoose = (n: number, k: number) => lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);

let seed = 1;
export function setStatsSeed(s: number) { seed = s; }
export function getStatsSeed(): number { return seed; }
export function urand(): number {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

type Dist = { d?: (x: number, ...p: number[]) => number; p?: (x: number, ...p: number[]) => number; q?: (p: number, ...a: number[]) => number; discrete?: boolean; lo?: (...p: number[]) => number; hi?: (...p: number[]) => number };

export const DISTRIBUTIONS: Record<string, Dist> = {
  norm: {
    d: (x, mu, s) => Math.exp(-0.5 * ((x - mu) / s) ** 2) / (s * Math.sqrt(2 * Math.PI)),
    p: (x, mu, s) => pnormStd((x - mu) / s),
    q: (p, mu, s) => mu + s * qnormStd(p),
  },
  lnorm: {
    d: (x, mu, s) => (x <= 0 ? 0 : Math.exp(-0.5 * ((Math.log(x) - mu) / s) ** 2) / (x * s * Math.sqrt(2 * Math.PI))),
    p: (x, mu, s) => (x <= 0 ? 0 : pnormStd((Math.log(x) - mu) / s)),
    q: (p, mu, s) => Math.exp(mu + s * qnormStd(p)),
  },
  unif: {
    d: (x, a, b) => (x >= a && x <= b ? 1 / (b - a) : 0),
    p: (x, a, b) => (x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a)),
    q: (p, a, b) => a + p * (b - a),
  },
  exp: {
    d: (x, r) => (x < 0 ? 0 : r * Math.exp(-r * x)),
    p: (x, r) => (x < 0 ? 0 : 1 - Math.exp(-r * x)),
    q: (p, r) => -Math.log(1 - p) / r,
  },
  gamma: {
    d: (x, s) => (x <= 0 ? 0 : Math.exp((s - 1) * Math.log(x) - x - lgamma(s))),
    p: (x, s) => gammaP(s, x),
    lo: () => 0, hi: (s) => s * 10 + 10,
  },
  chisq: {
    d: (x, k) => (x <= 0 ? 0 : Math.exp((k / 2 - 1) * Math.log(x) - x / 2 - (k / 2) * Math.LN2 - lgamma(k / 2))),
    p: (x, k) => gammaP(k / 2, x / 2),
    lo: () => 0, hi: (k) => k * 10 + 10,
  },
  t: {
    d: (x, n) => Math.exp(lgamma((n + 1) / 2) - lgamma(n / 2) - 0.5 * Math.log(n * Math.PI) - ((n + 1) / 2) * Math.log(1 + x * x / n)),
    p: (x, n) => { const ib = betaI(n / (n + x * x), n / 2, 0.5); return x >= 0 ? 1 - ib / 2 : ib / 2; },
    lo: () => -10, hi: () => 10,
  },
  F: {
    d: (x, d1, d2) => (x <= 0 ? 0 : Math.exp(0.5 * (d1 * Math.log(d1 * x) + d2 * Math.log(d2) - (d1 + d2) * Math.log(d1 * x + d2)) - Math.log(x) - (lgamma(d1 / 2) + lgamma(d2 / 2) - lgamma((d1 + d2) / 2)))),
    p: (x, d1, d2) => (x <= 0 ? 0 : betaI(d1 * x / (d1 * x + d2), d1 / 2, d2 / 2)),
    lo: () => 0, hi: () => 100,
  },
  beta: {
    d: (x, a, b) => (x <= 0 || x >= 1 ? 0 : Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) + lgamma(a + b) - lgamma(a) - lgamma(b))),
    p: (x, a, b) => betaI(x, a, b),
    lo: () => 0, hi: () => 1,
  },
  weibull: {
    d: (x, s) => (x < 0 ? 0 : s * x ** (s - 1) * Math.exp(-(x ** s))),
    p: (x, s) => (x < 0 ? 0 : 1 - Math.exp(-(x ** s))),
    q: (p, s) => (-Math.log(1 - p)) ** (1 / s),
  },
  logis: {
    d: (x, l, s) => { const z = Math.exp(-(x - l) / s); return z / (s * (1 + z) ** 2); },
    p: (x, l, s) => 1 / (1 + Math.exp(-(x - l) / s)),
    q: (p, l, s) => l + s * Math.log(p / (1 - p)),
  },
  cauchy: {
    d: (x, l, s) => 1 / (Math.PI * s * (1 + ((x - l) / s) ** 2)),
    p: (x, l, s) => 0.5 + Math.atan((x - l) / s) / Math.PI,
    q: (p, l, s) => l + s * Math.tan(Math.PI * (p - 0.5)),
  },
  binom: {
    discrete: true,
    d: (k, n, p) => (k < 0 || k > n || k !== Math.floor(k) ? 0 : Math.exp(lchoose(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p))),
    p: (k, n, p) => (k < 0 ? 0 : k >= n ? 1 : 1 - betaI(p, Math.floor(k) + 1, n - Math.floor(k))),
    lo: () => 0, hi: (n) => n,
  },
  pois: {
    discrete: true,
    d: (k, l) => (k < 0 || k !== Math.floor(k) ? 0 : Math.exp(k * Math.log(l) - l - lgamma(k + 1))),
    p: (k, l) => (k < 0 ? 0 : 1 - gammaP(Math.floor(k) + 1, l)),
    lo: () => 0, hi: (l) => l * 4 + 20,
  },
  geom: {
    discrete: true,
    d: (k, p) => (k < 0 ? 0 : p * (1 - p) ** k),
    p: (k, p) => (k < 0 ? 0 : 1 - (1 - p) ** (Math.floor(k) + 1)),
    lo: () => 0, hi: () => 1000,
  },
  nbinom: {
    discrete: true,
    d: (k, n, p) => (k < 0 ? 0 : Math.exp(lgamma(n + k) - lgamma(k + 1) - lgamma(n) + n * Math.log(p) + k * Math.log(1 - p))),
    p: (k, n, p) => (k < 0 ? 0 : betaI(p, n, Math.floor(k) + 1)),
    lo: () => 0, hi: () => 1000,
  },
};

export function distFunction(kind: 'd' | 'p' | 'q', dist: string): ((args: number[]) => number) | null {
  const D = DISTRIBUTIONS[dist];
  if (!D) return null;
  if (kind === 'd' && D.d) return (a) => D.d!(a[0], ...a.slice(1));
  if (kind === 'p' && D.p) return (a) => D.p!(a[0], ...a.slice(1));
  if (kind === 'q') {
    if (D.q) return (a) => D.q!(a[0], ...a.slice(1));
    if (D.p) return (a) => invert((x) => D.p!(x, ...a.slice(1)), a[0], D.lo?.(...a.slice(1)) ?? 0, D.hi?.(...a.slice(1)) ?? 10, D.discrete);
  }
  return null;
}

/** Random samples by inversion (deterministic seed). */
export function distRandom(dist: string, m: number, params: number[]): number[] {
  const q = distFunction('q', dist);
  if (!q) throw new CalcError(`r${dist}: Verteilung unbekannt`);
  return Array.from({ length: m }, () => q([urand(), ...params]));
}

export function percentile(values: number[], p: number): number {
  const v = values.slice().sort((a, b) => a - b);
  if (!v.length) throw new CalcError('percentile: keine Werte');
  if (p < 0 || p > 1) throw new CalcError('percentile: p muss zwischen 0 und 1 liegen');
  const h = (v.length - 1) * p;
  const lo = Math.floor(h);
  return v[lo] + (h - lo) * ((v[lo + 1] ?? v[lo]) - v[lo]);
}
