import type { Complex, Matrix, Unit } from 'mathjs';
import type { Node } from './ast';
import type { Evaluator } from './evaluator';
import { math } from './units';
import {
  CalcError, Scope, isFn, isMatrix, isUnit, isComplex, isRange, makeMatrix, matrixRows,
  toInt, toNumber, rangeValues, type FnVal, type Val,
} from './values';
import { cross3 as crossFn } from './evaluator';
import { hasOffset, mkQ, qSum, withValue } from './quantity';
import { EXTRA_BUILTINS } from './builtins2';
import { brent, limitNumeric, pnormStd, qnormStd, rootFromGuess, solveSystem } from './numeric';
import { DISTRIBUTIONS, distFunction, distRandom, gammaQ, lgamma, percentile, setStatsSeed } from './stats';

type Builtin = (args: Val[], ev: Evaluator) => Val;
type Lazy = (args: Node[], scope: Scope, ev: Evaluator) => Val;

const nargs = (name: string, args: Val[], min: number, max = min) => {
  if (args.length < min || args.length > max) {
    throw new CalcError(`${name} erwartet ${min === max ? min : `${min}–${max}`} Argument${max === 1 ? '' : 'e'}`);
  }
};

/** Flatten matrices / scalars into a list of elements. */
function elements(args: Val[]): Val[] {
  const out: Val[] = [];
  for (const a of args) {
    if (isMatrix(a)) {
      // read the internal data directly (toArray() deep-clones every element)
      const data = (a as Matrix).valueOf() as unknown as Val[][];
      for (const row of data) { if (Array.isArray(row)) for (const x of row) out.push(x); else out.push(row as Val); }
    }
    else if (isRange(a)) out.push(...rangeValues(a));
    else out.push(a);
  }
  return out;
}

const asMatrix = (v: Val, what = 'Argument'): Matrix => {
  if (isMatrix(v)) return v as Matrix;
  if (typeof v === 'number' || isUnit(v) || isComplex(v)) return makeMatrix([[v]]);
  throw new CalcError(`${what} muss eine Matrix oder ein Vektor sein`);
};
const column = (vals: Val[]): Matrix => makeMatrix(vals.map(v => [v]));

/** Element-wise application for scalar functions. */
const map1 = (f: (x: Val) => Val): Builtin => (args) => {
  if (args.length !== 1) throw new CalcError('Genau ein Argument erwartet');
  const a = args[0];
  if (isMatrix(a)) return math.map(a as Matrix, (x: unknown) => f(x as Val) as never) as Matrix;
  return f(a);
};
const mj = (name: string) => map1((x) => {
  const fn = (math as unknown as Record<string, (v: unknown) => Val>)[name];
  return fn(x);
});
/** Trig function: argument must be dimensionless (angles are numbers). */
const FAST: Record<string, (x: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
};
const trig = (name: string) => map1((x) => {
  if (typeof x === 'number' && FAST[name]) return FAST[name](x);
  const v = isUnit(x) ? toNumber(x, 'Winkel') : x;
  const fn = (math as unknown as Record<string, (v: unknown) => Val>)[name];
  return fn(v);
});

function mathcadMod(x: Val, y: Val): Val {
  if (typeof x === 'number' && typeof y === 'number') {
    if (y === 0) throw new CalcError('mod: Division durch 0');
    return x - y * Math.trunc(x / y);
  }
  const q = math.divide(x as Unit, y as Unit) as unknown as number;
  const qn = typeof q === 'number' ? q : toNumber(q as Val);
  return math.subtract(x as Unit, math.multiply(y as Unit, Math.trunc(qn)) as Unit) as Val;
}

/** Snap values that are an integer up to a few units in the last place (0.1·30 = 3.0000000000000004). */
function snapInt(x: number): number {
  const r = Math.round(x);
  return Math.abs(x - r) <= 4 * Number.EPSILON * Math.max(1, Math.abs(x)) ? r : x;
}
const floorS = (x: number) => Math.floor(snapInt(x));
const ceilS = (x: number) => Math.ceil(snapInt(x));
/** Round half away from zero (Mathcad), robust against representation errors (2.675·100 = 267.49999…). */
function roundHalf(x: number): number {
  const a = Math.abs(x);
  let r = Math.floor(a);
  const frac = a - r;
  if (frac > 0.5 || Math.abs(frac - 0.5) <= 8 * Number.EPSILON * Math.max(1, a)) r += 1;
  return x < 0 ? -r : r;
}

function roundTo(x: Val, mult: Val, mode: 'floor' | 'ceil' | 'round'): Val {
  const q = math.divide(x as Unit, mult as Unit) as unknown;
  const qn = typeof q === 'number' ? q : toNumber(q as Val);
  const r = mode === 'floor' ? floorS(qn) : mode === 'ceil' ? ceilS(qn) : roundHalf(qn);
  return math.multiply(mult as Unit, r) as Val;
}

function compareVals(a: Val, b: Val): number {
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  // zero is compatible with every unit (Mathcad)
  if (a === 0 && isUnit(b)) return Math.sign(0 - ((b as Unit).value as number));
  if (b === 0 && isUnit(a)) return Math.sign(((a as Unit).value as number) - 0);
  return math.compare(a as number, b as number) as number;
}

function normalPdf(x: number, mu: number, s: number) {
  return Math.exp(-0.5 * ((x - mu) / s) ** 2) / (s * Math.sqrt(2 * Math.PI));
}

let seed = 1;
function rand() {
  // mulberry32 – deterministic so worksheets recalc reproducibly
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export function resetRandom(s = 1) { seed = s; }
export function getRandomState(): number { return seed; }
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function linterp(vx: Val[], vy: Val[], x: Val): Val {
  const n = vx.length;
  if (n !== vy.length || n < 2) throw new CalcError('linterp: Vektoren gleicher Länge (≥ 2) erwartet');
  const xs = vx.map(v => (isUnit(v) ? (v as Unit).value as number : toNumber(v)));
  const xv = isUnit(x) ? (x as Unit).value as number : toNumber(x);
  let i = 0;
  if (xv <= xs[0]) i = 0;
  else if (xv >= xs[n - 1]) i = n - 2;
  else while (i < n - 2 && xs[i + 1] < xv) i++;
  const t = (xv - xs[i]) / (xs[i + 1] - xs[i]);
  return math.add(vy[i] as number, math.multiply(math.subtract(vy[i + 1] as number, vy[i] as number), t) as number) as Val;
}

export const BUILTINS: Record<string, Builtin> = {
  // elementary
  sin: trig('sin'), cos: trig('cos'), tan: trig('tan'), cot: trig('cot'), sec: trig('sec'), csc: trig('csc'),
  asin: mj('asin'), acos: mj('acos'), atan: mj('atan'), acot: map1(x => { const v = toNumber(x); return Math.PI / 2 - Math.atan(v); }), asec: mj('asec'), acsc: mj('acsc'),
  sinh: trig('sinh'), cosh: trig('cosh'), tanh: trig('tanh'), coth: trig('coth'), sech: trig('sech'), csch: trig('csch'),
  asinh: mj('asinh'), acosh: mj('acosh'), atanh: mj('atanh'), acoth: mj('acoth'), asech: mj('asech'), acsch: mj('acsch'),
  sinc: map1(x => { const v = toNumber(x); return v === 0 ? 1 : Math.sin(v) / v; }),
  ln0: map1(x => { const v = toNumber(x); return v === 0 ? -Infinity : logOf(v); }),
  exp: map1(x => (typeof x === 'number' ? Math.exp(x) : math.exp(toNumberOrComplex(x)) as Val)),
  ln: map1(x => logOf(x)),
  log: (args) => {
    nargs('log', args, 1, 2);
    if (args.length === 2) return math.divide(logOf(args[0]) as number, Math.log(toNumber(args[1], 'Basis'))) as Val;
    return math.divide(logOf(args[0]) as number, Math.LN10) as Val;
  },
  log10: map1(x => math.divide(logOf(x) as number, Math.LN10) as Val),
  log2: map1(x => math.divide(logOf(x) as number, Math.LN2) as Val),
  atan2: (args) => { nargs('atan2', args, 2); return Math.atan2(siNum(args[1]), siNum(args[0])); },
  angle: (args) => { nargs('angle', args, 2); const a = Math.atan2(siNum(args[1]), siNum(args[0])); return a < 0 ? a + 2 * Math.PI : a; },
  sqrt: map1(x => (typeof x === 'number' && x >= 0 ? Math.sqrt(x) : math.sqrt(x as number) as Val)),
  abs: map1(x => math.abs(x as number) as Val),
  sign: map1(x => Math.sign(siNum(x))),
  signum: map1(x => (siNum(x) === 0 ? 0 : Math.sign(siNum(x)))),
  csgn: map1(x => { const c = isComplex(x) ? (x as Complex) : { re: siNum(x), im: 0 }; return c.re > 0 || (c.re === 0 && c.im > 0) ? 1 : c.re === 0 && c.im === 0 ? 0 : -1; }),
  floor: map1(x => floorS(toNumber(x))),
  ceil: map1(x => ceilS(toNumber(x))),
  trunc: map1(x => Math.trunc(toNumber(x))),
  round: (args) => {
    nargs('round', args, 1, 2);
    const n = args.length === 2 ? toInt(args[1], 'Stellen') : 0;
    const f = (x: Val) => {
      const v = toNumber(x);
      if (n >= 0) {
        // decimal rounding on the shortest decimal representation of x
        const [m, e] = v.toExponential(15).split('e');
        return Number(`${roundHalf(Number(`${m}e${Number(e) + n}`))}e${-n}`);
      }
      const p = Math.pow(10, -n);
      return roundHalf(v / p) * p;
    };
    return isMatrix(args[0]) ? math.map(args[0] as Matrix, (x: unknown) => f(x as Val)) as Matrix : f(args[0]);
  },
  Floor: (args) => { nargs('Floor', args, 2); return roundTo(args[0], args[1], 'floor'); },
  Ceil: (args) => { nargs('Ceil', args, 2); return roundTo(args[0], args[1], 'ceil'); },
  Round: (args) => { nargs('Round', args, 2); return roundTo(args[0], args[1], 'round'); },
  Trunc: (args) => { nargs('Trunc', args, 2); const q = toNumber(math.divide(args[0] as Unit, args[1] as Unit) as Val); return math.multiply(args[1] as Unit, Math.trunc(q)) as Val; },
  mod: (args) => { nargs('mod', args, 2); return mathcadMod(args[0], args[1]); },
  gcd: (args) => elements(args).map(x => toInt(x)).reduce((a, b) => math.gcd(a, b)),
  lcm: (args) => elements(args).map(x => toInt(x)).reduce((a, b) => math.lcm(a, b)),
  combin: (args) => broadcast(args, ([n0, k0]) => {
    const n = toInt(n0), k = toInt(k0);
    if (k < 0 || k > n) return 0;
    const c = math.combinations(n, k) as number;
    return isFinite(c) && c <= Number.MAX_SAFE_INTEGER ? c : Math.round(Math.exp(lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1)));
  }),
  permut: (args) => { nargs('permut', args, 2); return math.permutations(toInt(args[0]), toInt(args[1])); },
  'Γ': map1(x => gammaFn(toNumber(x))),
  gamma: map1(x => gammaFn(toNumber(x))),
  erf: map1(x => math.erf(toNumber(x))),
  erfc: map1(x => erfc(toNumber(x))),
  /** x ∈ set for the number sets ℕ, ℤ, ℚ, ℝ, ℂ (ℚ: fraction with a denominator up to 10⁴). */
  elementOf: (args) => {
    nargs('elementOf', args, 2);
    const set = args[1];
    if (typeof set !== 'string') throw new CalcError('elementOf(x, "ℤ") erwartet eine Zahlenmenge als Zeichenkette');
    const test = (x: Val): number => {
      if (isComplex(x)) { const c = x as Complex; if (c.im !== 0) return set === 'ℂ' ? 1 : 0; x = c.re; }
      const v = siNum(x);
      switch (set) {
        case 'ℂ': case 'ℝ': return isFinite(v) ? 1 : 0;
        case 'ℤ': return Number.isInteger(v) ? 1 : 0;
        case 'ℕ': return Number.isInteger(v) && v >= 0 ? 1 : 0;
        case 'ℚ': {
          for (let q = 1; q <= 10000; q++) if (Math.abs(v * q - Math.round(v * q)) <= 1e-12 * Math.max(1, Math.abs(v * q))) return 1;
          return 0;
        }
      }
      throw new CalcError(`Unbekannte Zahlenmenge „${set}“`);
    };
    return isMatrix(args[0]) ? math.map(args[0] as Matrix, (x: unknown) => test(x as Val)) as Matrix : test(args[0]);
  },
  Re: map1(x => (isComplex(x) ? (x as Complex).re : x)),
  Im: map1(x => (isComplex(x) ? (x as Complex).im : 0)),
  re: map1(x => (isComplex(x) ? (x as Complex).re : x)),
  im: map1(x => (isComplex(x) ? (x as Complex).im : 0)),
  arg: map1(x => (isComplex(x) ? math.arg(x as Complex) : (toNumber(x) < 0 ? Math.PI : 0))),
  conj: map1(x => (isComplex(x) ? math.conj(x as Complex) : x)),
  Heaviside: map1(x => (siNum(x) >= 0 ? 1 : 0)),
  'Φ': map1(x => (siNum(x) >= 0 ? 1 : 0)),
  'δ': (args) => { nargs('δ', args, 2); return toNumber(args[0]) === toNumber(args[1]) ? 1 : 0; },
  'ε': (args) => {
    const v = args.map(a => toInt(a));
    let s = 1;
    for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) { if (v[i] === v[j]) return 0; if (v[i] > v[j]) s = -s; }
    return s;
  },

  // statistics / aggregation
  max: (args) => { const e = elements(args); if (!e.length) throw new CalcError('max: keine Werte'); return zeroLike(e.reduce((a, b) => (compareVals(b, a) > 0 ? b : a)), e); },
  min: (args) => { const e = elements(args); if (!e.length) throw new CalcError('min: keine Werte'); return zeroLike(e.reduce((a, b) => (compareVals(b, a) < 0 ? b : a)), e); },
  mean: (args) => { const e = elements(args); if (e.every(x => typeof x === 'number')) return (e as number[]).reduce((a, b) => a + b, 0) / e.length; { const s = qSum(e); if (s !== undefined) return divQ(s, e.length); } return math.divide(e.reduce((a, b) => math.add(a as number, b as number) as Val) as number, e.length) as Val; },
  median: (args) => { const e = elements(args).slice().sort(compareVals); const n = e.length; return n % 2 ? e[(n - 1) / 2] : math.divide(math.add(e[n / 2 - 1] as number, e[n / 2] as number), 2) as Val; },
  stdev: (args) => stdev(elements(args), false),
  Stdev: (args) => stdev(elements(args), true),
  var: (args) => variance(elements(args), false),
  Var: (args) => variance(elements(args), true),
  gmean: (args) => { const e = elements(args).map(x => toNumber(x)); return Math.exp(e.reduce((a, b) => a + Math.log(b), 0) / e.length); },
  hmean: (args) => { const e = elements(args).map(x => toNumber(x)); return e.length / e.reduce((a, b) => a + 1 / b, 0); },
  sum: (args) => { const e = elements(args); if (e.every(x => typeof x === 'number')) return (e as number[]).reduce((a, b) => a + b, 0); { const s = qSum(e); if (s !== undefined) return s as Val; } return e.reduce((a, b) => math.add(a as number, b as number) as Val, 0 as Val) },

  // vectors & matrices
  length: (args) => { nargs('length', args, 1); const a = args[0]; if (typeof a === 'string') return a.length; const s = asMatrix(a).size(); return s[0] * s[1] === 0 ? 0 : (s[1] === 1 ? s[0] : s[0] === 1 ? s[1] : s[0]); },
  rows: (args) => { nargs('rows', args, 1); return isMatrix(args[0]) ? (args[0] as Matrix).size()[0] : 1; },
  cols: (args) => { nargs('cols', args, 1); return isMatrix(args[0]) ? (args[0] as Matrix).size()[1] : 1; },
  last: (args, ev) => { nargs('last', args, 1); const s = asMatrix(args[0]).size(); return Math.max(s[0], s[1]) - 1 + ev.opts.origin; },
  identity: (args) => { nargs('identity', args, 1); const n = toInt(args[0]); return math.identity(n, n) as Matrix; },
  zeros: (args) => { nargs('zeros', args, 1, 2); const r = toInt(args[0]); const c = args[1] !== undefined ? toInt(args[1]) : 1; return math.zeros(r, c) as Matrix; },
  diag: (args) => {
    nargs('diag', args, 1);
    const m = asMatrix(args[0]); const [r, c] = m.size();
    if (c === 1 || r === 1) {
      const e = m.toArray().flat() as Val[];
      return makeMatrix(e.map((x, i) => e.map((_, j) => (i === j ? x : 0))));
    }
    return column((math.diag(m) as Matrix).toArray() as Val[]);
  },
  tr: (args) => { nargs('tr', args, 1); return math.trace(asMatrix(args[0])) as Val; },
  trace: (args) => { nargs('trace', args, 1); return math.trace(asMatrix(args[0])) as Val; },
  det: (args) => { nargs('det', args, 1); return determinant(asMatrix(args[0])); },
  inverse: (args) => { nargs('inverse', args, 1); return math.inv(asMatrix(args[0])); },
  rank: (args) => { nargs('rank', args, 1); return matrixRank(asMatrix(args[0])); },
  transpose: (args) => { nargs('transpose', args, 1); return math.transpose(asMatrix(args[0])); },
  augment: (args) => {
    const ms = args.map(a => matrixRows(asMatrix(a)));
    const r = ms[0].length;
    if (ms.some(m => m.length !== r)) throw new CalcError('augment: Zeilenzahl muss übereinstimmen');
    return makeMatrix(ms[0].map((_, i) => ms.flatMap(m => m[i])));
  },
  stack: (args) => {
    const ms = args.map(a => matrixRows(asMatrix(a)));
    const c = ms[0][0].length;
    if (ms.some(m => m[0].length !== c)) throw new CalcError('stack: Spaltenzahl muss übereinstimmen');
    return makeMatrix(ms.flat());
  },
  submatrix: (args, ev) => {
    nargs('submatrix', args, 5);
    const m = matrixRows(asMatrix(args[0]));
    const o = ev.opts.origin;
    const [ir, jr, ic, jc] = args.slice(1).map(a => toInt(a) - o);
    if (ir < 0 || ic < 0 || jr >= m.length || jc >= m[0].length || jr < ir || jc < ic) throw new CalcError('submatrix: Indizes außerhalb des Bereichs');
    return makeMatrix(m.slice(ir, jr + 1).map(r => r.slice(ic, jc + 1)));
  },
  lsolve: (args, ev) => {
    nargs('lsolve', args, 2);
    const A = asMatrix(args[0]), b = asMatrix(args[1]);
    if (!ev.isSquare(A)) throw new CalcError('lsolve: Koeffizientenmatrix muss quadratisch sein');
    if (A.size()[0] !== b.size()[0]) throw new CalcError('lsolve: Zeilenzahl von Matrix und rechter Seite passt nicht');
    const hasUnits = [A, b].some(m => (m.valueOf() as unknown as Val[][]).some(r => (Array.isArray(r) ? r : [r]).some(x => isUnit(x))));
    if (hasUnits) return ev.multiply(ev.power(A, -1, false), b, false);
    return math.lusolve(A, b) as Matrix;
  },
  eigenvals: (args) => {
    nargs('eigenvals', args, 1);
    const M = asMatrix(args[0]);
    try { return column(sortEig(toArr(math.eigs(M).values))); } catch {
      // fallback for matrices where the QR iteration does not converge: roots of the characteristic polynomial
      return column(sortEig(polyRoots(charPoly(matrixRows(M).map(r => r.map(x => toNumber(x)))))));
    }
  },
  eigenvec: (args) => {
    nargs('eigenvec', args, 2);
    const r = math.eigs(asMatrix(args[0]));
    const lam = toNumber(args[1]);
    let best = 0, bd = Infinity;
    toArr(r.values).forEach((v, i) => { const d = Math.abs((isComplex(v) ? (v as Complex).re : v as number) - lam); if (d < bd) { bd = d; best = i; } });
    return column(normVec(toArr(r.eigenvectors[best].vector)));
  },
  norm: (args) => { nargs('norm', args, 1); return math.norm(asMatrix(args[0]).toArray().flat() as number[], 2) as Val; },
  cond1: (args) => condNum(args[0], 1),
  cond2: (args) => condNum(args[0], 2),
  conde: (args) => condNum(args[0], 'fro'),
  condi: (args) => condNum(args[0], 'inf'),
  genvals: (args) => { nargs('genvals', args, 2); const r = math.eigs(math.multiply(math.inv(asMatrix(args[1])), asMatrix(args[0])) as Matrix); return column(sortEig(toArr(r.values))); },
  genvecs: (args) => {
    nargs('genvecs', args, 2, 3);
    // "L": left eigenvectors yᵀM = λ yᵀN, i.e. eigenvectors of (Nᵀ)⁻¹Mᵀ; otherwise right ones of N⁻¹M
    const left = args[2] !== undefined && String(args[2]).toUpperCase() === 'L';
    const A = asMatrix(args[0]), B = asMatrix(args[1]);
    const r = math.eigs((left ? math.multiply(math.inv(math.transpose(B)), math.transpose(A)) : math.multiply(math.inv(B), A)) as Matrix);
    const re = (x: Val) => (isComplex(x) ? (x as Complex).re : x as number);
    // normalised as LAPACK (dggev) and Mathcad: the largest component has magnitude 1
    // sign fixed as for eigenvecs (largest component positive, last one on ties): the iteration starts randomly
    const maxNorm = (v: Val[]) => {
      let k = 0;
      v.forEach((x, i) => { if (Math.abs(re(x)) >= Math.abs(re(v[k])) - 1e-9) k = i; });
      const m = Math.abs(re(v[k])) * (re(v[k]) < 0 ? -1 : 1);
      return m !== 0 ? v.map(x => (isComplex(x) ? math.divide(x as Complex, m) as Val : (x as number) / m)) : v;
    };
    const pairs = r.eigenvectors.map(e => ({ v: e.value as unknown as Val, vec: maxNorm(toArr(e.vector)) })).sort((a, b) => re(b.v) - re(a.v));
    const vecs = pairs.map(p => p.vec);
    return makeMatrix(vecs[0].map((_, i) => vecs.map(v => v[i])));
  },
  geninv: (args) => { nargs('geninv', args, 1); return math.pinv(asMatrix(args[0])) as Matrix; },
  rref: (args) => { nargs('rref', args, 1); return rref(asMatrix(args[0])); },
  linspace: (args) => { nargs('linspace', args, 3); const a = siOrNum(args[0]), b = siOrNum(args[1]); const n = toInt(args[2]); return column(Array.from({ length: n }, (_, i) => scaleLike(args[0], a + (b - a) * (n === 1 ? 0 : i / (n - 1))))); },
  logspace: (args) => { nargs('logspace', args, 3); const a = Math.log10(toNumber(args[0])), b = Math.log10(toNumber(args[1])); const n = toInt(args[2]); return column(Array.from({ length: n }, (_, i) => Math.pow(10, a + (b - a) * (n === 1 ? 0 : i / (n - 1))))); },
  mode: (args) => {
    const e = elements(args).map(x => toNumber(x));
    const cnt = new Map<number, number>();
    for (const x of e) cnt.set(x, (cnt.get(x) ?? 0) + 1);
    let best = NaN, bc = 0;
    for (const [k, c] of cnt) if (c > bc) { bc = c; best = k; }
    if (bc < 2) throw new CalcError('mode: kein Wert kommt mehrfach vor');
    return best;
  },
  percentile: (args) => { nargs('percentile', args, 2); return percentile(elements([args[0]]).map(x => toNumber(x)), toNumber(args[1])); },
  skew: (args) => { const e = elements(args).map(x => siNum(x)); const n = e.length; if (n < 3) throw new CalcError('skew: mindestens 3 Werte nötig'); if (e.every(x => x === e[0])) throw new CalcError('skew: alle Werte gleich'); const m = e.reduce((a, b) => a + b, 0) / n; const s = Math.sqrt(e.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)); return n / ((n - 1) * (n - 2)) * e.reduce((a, b) => a + ((b - m) / s) ** 3, 0); },
  kurt: (args) => { const e = elements(args).map(x => siNum(x)); const n = e.length; if (n < 4) throw new CalcError('kurt: mindestens 4 Werte nötig'); if (e.every(x => x === e[0])) throw new CalcError('kurt: alle Werte gleich'); const m = e.reduce((a, b) => a + b, 0) / n; const s = Math.sqrt(e.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)); return n * (n + 1) / ((n - 1) * (n - 2) * (n - 3)) * e.reduce((a, b) => a + ((b - m) / s) ** 4, 0) - 3 * (n - 1) ** 2 / ((n - 2) * (n - 3)); },
  corr: (args) => { nargs('corr', args, 2); const a = elements([args[0]]).map(x => toNumber(x)), b = elements([args[1]]).map(x => toNumber(x)); const n = a.length; const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } if (!(saa > 0 && sbb > 0)) throw new CalcError('corr: ein Vektor ist konstant'); return sab / Math.sqrt(saa * sbb); },
  cvar: (args) => { nargs('cvar', args, 2); const a = elements([args[0]]).map(x => toNumber(x)), b = elements([args[1]]).map(x => toNumber(x)); const n = a.length; const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n; let s = 0; for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb); return s / n; },
  slope: (args) => regress(args, 'slope'),
  intercept: (args) => regress(args, 'intercept'),
  eigenvecs: (args) => {
    nargs('eigenvecs', args, 1, 2);
    let M = asMatrix(args[0]);
    if (args[1] !== undefined && String(args[1]).toUpperCase() === 'L') M = math.transpose(M);
    const r = math.eigs(M);
    const pairs = r.eigenvectors.map(e => ({ v: e.value as unknown as Val, vec: normVec(toArr(e.vector)) }));
    const re = (x: Val) => (isComplex(x) ? (x as Complex).re : x as number);
    pairs.sort((a, b) => re(b.v as Val) - re(a.v as Val));
    const vecs = pairs.map(p => p.vec);
    return makeMatrix(vecs[0].map((_, i) => vecs.map(v => v[i])));
  },
  dhypergeom: (args) => broadcast(args, (xs) => { const [m, a, b, n] = xs.map(x => toNumber(x)); return hyper(m, a, b, n); }),
  phypergeom: (args) => broadcast(args, (xs) => { const [m, a, b, n] = xs.map(x => toNumber(x)); let s = 0; for (let k = Math.max(0, n - b); k <= Math.floor(m); k++) s += hyper(k, a, b, n); return s; }),
  qhypergeom: (args) => broadcast(args, (xs) => { const [p, a, b, n] = xs.map(x => toNumber(x)); let s = 0; for (let k = Math.max(0, n - b); k <= Math.min(a, n); k++) { s += hyper(k, a, b, n); if (s >= p - 1e-12) return k; } return Math.min(a, n); }),
  match: (args, ev) => {
    nargs('match', args, 2);
    const rows = matrixRows(asMatrix(args[1]));
    const out: Val[] = [];
    // Mathcad searches column by column
    const nc = rows[0]?.length ?? 0;
    for (let j = 0; j < nc; j++) rows.forEach((r, i) => { if (valEq(r[j], args[0])) out.push(nc === 1 ? i + ev.opts.origin : makeMatrix([[i + ev.opts.origin], [j + ev.opts.origin]])); });
    if (!out.length) throw new CalcError('match: Wert nicht gefunden');
    return column(out);
  },
  lookup: (args) => { nargs('lookup', args, 3); return lookupBy(args[0], elements([args[1]]), elements([args[2]])); },
  vlookup: (args, ev) => {
    nargs('vlookup', args, 3);
    const rows = matrixRows(asMatrix(args[1])); const c = toInt(args[2]) - ev.opts.origin;
    return lookupBy(args[0], rows.map(r => r[0]), rows.map(r => r[c]));
  },
  hlookup: (args, ev) => {
    nargs('hlookup', args, 3);
    const rows = matrixRows(asMatrix(args[1])); const r = toInt(args[2]) - ev.opts.origin;
    return lookupBy(args[0], rows[0], rows[r]);
  },
  row: (args, ev) => { nargs('row', args, 2); const rows = matrixRows(asMatrix(args[0])); const i = toInt(args[1]) - ev.opts.origin; if (!rows[i]) throw new CalcError('Zeilenindex außerhalb des Bereichs'); return makeMatrix([rows[i]]); },
  cross: (args) => { nargs('cross', args, 2); return crossFn(args[0], args[1]); },
  dot: (args) => { nargs('dot', args, 2); return math.dot(asMatrix(args[0]), asMatrix(args[1])) as Val; },
  norm1: (args) => math.norm(asMatrix(args[0]), 1) as Val,
  norm2: (args) => math.norm(asMatrix(args[0]), 2) as Val,
  norme: (args) => math.norm(asMatrix(args[0]), 'fro') as Val,
  normi: (args) => math.norm(asMatrix(args[0]), 'inf') as Val,
  sort: (args) => { nargs('sort', args, 1); return column(elements(args).slice().sort(compareVals)); },
  reverse: (args) => { nargs('reverse', args, 1); return makeMatrix(matrixRows(asMatrix(args[0])).slice().reverse()); },
  csort: (args, ev) => {
    nargs('csort', args, 2);
    const j = toInt(args[1]) - ev.opts.origin;
    return makeMatrix(matrixRows(asMatrix(args[0])).slice().sort((a, b) => compareVals(a[j], b[j])));
  },
  rsort: (args, ev) => {
    nargs('rsort', args, 2);
    const i = toInt(args[1]) - ev.opts.origin;
    const rows = matrixRows(asMatrix(args[0]));
    const order = rows[i].map((_, k) => k).sort((a, b) => compareVals(rows[i][a], rows[i][b]));
    return makeMatrix(rows.map(r => order.map(k => r[k])));
  },
  matrix: (args, ev) => {
    nargs('matrix', args, 3);
    const m = toInt(args[0]), n = toInt(args[1]);
    const f = args[2];
    if (!isFn(f)) throw new CalcError('matrix(m, n, f): f muss eine Funktion sein');
    const o = ev.opts.origin;
    return makeMatrix(Array.from({ length: m }, (_, i) => Array.from({ length: n }, (_, j) => ev.callFn(f as FnVal, [i + o, j + o]))));
  },
  linterp: (args) => {
    nargs('linterp', args, 3);
    const vx = elements([args[0]]), vy = elements([args[1]]);
    if (isMatrix(args[2])) return math.map(args[2] as Matrix, (x: unknown) => linterp(vx, vy, x as Val) as never) as Matrix;
    return linterp(vx, vy, args[2]);
  },
  polyroots: (args) => {
    nargs('polyroots', args, 1);
    const c = elements(args).map(x => toNumber(x));
    while (c.length > 1 && c[c.length - 1] === 0) c.pop();
    const n = c.length - 1;
    if (n < 1) throw new CalcError('polyroots: Polynom vom Grad ≥ 1 erwartet');
    if (n === 1) return column([-c[0] / c[1]]);
    const vals = polyRoots(c);
    const re = (v: Val) => (isComplex(v) ? (v as Complex).re : (v as number));
    const im = (v: Val) => (isComplex(v) ? (v as Complex).im : 0);
    vals.sort((a, b) => re(a) - re(b) || im(a) - im(b));
    return column(vals);
  },

  // probability
  dnorm: (args) => { nargs('dnorm', args, 3); return broadcast(args, ([x, m, sd]) => normalPdf(siNum(x), siNum(m), siNum(sd))); },
  pnorm: (args) => { nargs('pnorm', args, 3); return broadcast(args, ([x, m, sd]) => pnormStd((siNum(x) - siNum(m)) / siNum(sd))); },
  cnorm: (args) => { nargs('cnorm', args, 1); return broadcast(args, ([x]) => pnormStd(siNum(x))); },
  qnorm: (args) => {
    nargs('qnorm', args, 3);
    return broadcast(args, ([p, m, sd]) => {
      const pp = siNum(p);
      if (!(pp >= 0 && pp <= 1)) throw new CalcError('Wahrscheinlichkeit muss zwischen 0 und 1 liegen');
      return siNum(m) + siNum(sd) * qnormStd(pp);
    });
  },
  rnorm: (args) => { nargs('rnorm', args, 3); const m = toInt(args[0]); return column(Array.from({ length: m }, () => siNum(args[1]) + siNum(args[2]) * randn())); },
  runif: (args) => { nargs('runif', args, 3); const m = toInt(args[0]); const a = siNum(args[1]), b = siNum(args[2]); return column(Array.from({ length: m }, () => a + (b - a) * rand())); },
  rnd: (args) => { nargs('rnd', args, 1); return rand() * toNumber(args[0]); },
  Seed: (args) => { resetRandom(toInt(args[0])); setStatsSeed(toInt(args[0])); return toInt(args[0]); },

  // strings
  concat: (args) => args.map(a => (typeof a === 'string' ? a : (() => { throw new CalcError('concat erwartet Zeichenketten'); })())).join(''),
  strlen: (args) => { nargs('strlen', args, 1); if (typeof args[0] !== 'string') throw new CalcError('strlen erwartet eine Zeichenkette'); return args[0].length; },
  substr: (args) => { nargs('substr', args, 3); return String(args[0]).substr(toInt(args[1]), toInt(args[2])); },
  num2str: (args) => { nargs('num2str', args, 1); return String(toNumber(args[0])); },
  str2num: (args) => { nargs('str2num', args, 1); const n = parseFloat(String(args[0])); if (isNaN(n)) throw new CalcError('str2num: keine Zahl'); return n; },
  error: (args) => { throw new CalcError(String(args[0] ?? 'Fehler')); },

  // units
  UnitsOf: (args) => { nargs('UnitsOf', args, 1); const a = args[0]; if (!isUnit(a)) return 1; return withValue(a as Unit, 1); },
  SIUnitsOf: (args) => { nargs('SIUnitsOf', args, 1); const a = args[0]; if (!isUnit(a)) return 1; return withValue(a as Unit, 1); },
  IsString: (args) => (typeof args[0] === 'string' ? 1 : 0),
  IsScalar: (args) => (!isMatrix(args[0]) && typeof args[0] !== 'string' ? 1 : 0),
  IsArray: (args) => (isMatrix(args[0]) ? 1 : 0),
};
BUILTINS['Max'] = BUILTINS.max;
// probability distributions: dX, pX, qX, rX
for (const dist of Object.keys(DISTRIBUTIONS)) {
  for (const kind of ['d', 'p', 'q'] as const) {
    const f = distFunction(kind, dist);
    if (f && !(kind + dist in BUILTINS)) BUILTINS[kind + dist] = (args) => broadcast(args, (xs) => f(xs.map(a => toNumber(a))));
  }
  if (!('r' + dist in BUILTINS)) BUILTINS['r' + dist] = (args) => column(distRandom(dist, toInt(args[0]), args.slice(1).map(a => toNumber(a))));
}

/** Apply a scalar function element-wise over any matrix arguments (Mathcad auto-vectorizes these). */
function broadcast(args: Val[], f: (xs: Val[]) => Val): Val {
  const m = args.find(a => isMatrix(a)) as Matrix | undefined;
  if (!m) return f(args);
  return math.map(m, (_x: unknown, idx: number[]) => f(args.map(a => (isMatrix(a) ? (a as Matrix).get(idx) : a))) as never) as Matrix;
}

function lookupBy(z: Val, keys: Val[], vals: Val[]): Val {
  const out: Val[] = [];
  keys.forEach((k, i) => { if (valEq(k, z)) out.push(vals[i]); });
  if (!out.length) throw new CalcError('Wert nicht gefunden');
  return column(out);
}
function valEq(a: Val, b: Val): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  try { return math.equal(a as number, b as number) as boolean; } catch { return false; }
}

/** A plain 0 among quantities takes their unit. */
function zeroLike(v: Val, all: Val[]): Val {
  if (v !== 0) return v;
  const u = all.find(x => isUnit(x)) as Unit | undefined;
  if (!u) return v;
  return withValue(u, 0);
}

function divQ(s: unknown, n: number): Val {
  if (typeof s === 'number') return s / n;
  return withValue(s as Unit, ((s as unknown as { value: number }).value) / n);
}

/** Roots of a real polynomial (coefficients in ascending order): Durand–Kerner with Newton polishing. */
function polyRoots(coef: number[]): Val[] {
  const c = coef.slice();
  while (c.length > 1 && c[c.length - 1] === 0) c.pop();
  const n = c.length - 1;
  if (n < 1) return [];
  const a = c.map(x => x / c[n]);                      // monic
  type C = [number, number];
  const mul = (x: C, y: C): C => [x[0] * y[0] - x[1] * y[1], x[0] * y[1] + x[1] * y[0]];
  const div = (x: C, y: C): C => { const d = y[0] * y[0] + y[1] * y[1]; return [(x[0] * y[0] + x[1] * y[1]) / d, (x[1] * y[0] - x[0] * y[1]) / d]; };
  const evalP = (z: C, cs: number[]): C => { let r: C = [cs[cs.length - 1], 0]; for (let k = cs.length - 2; k >= 0; k--) r = [mul(r, z)[0] + cs[k], mul(r, z)[1]]; return r; };
  const dcs = a.slice(1).map((x, k) => x * (k + 1));
  const R = 1 + Math.max(...a.slice(0, n).map(Math.abs));
  let z: C[] = Array.from({ length: n }, (_, k) => { const t = 2 * Math.PI * k / n + 0.4; return [R * 0.9 * Math.cos(t), R * 0.9 * Math.sin(t)]; });
  for (let it = 0; it < 500; it++) {
    let delta = 0;
    z = z.map((zi, i) => {
      let den: C = [1, 0];
      z.forEach((zj, j) => { if (j !== i) den = mul(den, [zi[0] - zj[0], zi[1] - zj[1]]); });
      const step = div(evalP(zi, a), den);
      delta = Math.max(delta, Math.hypot(step[0], step[1]));
      return [zi[0] - step[0], zi[1] - step[1]];
    });
    if (delta < 1e-15 * R) break;
  }
  // Newton polishing on the original polynomial
  z = z.map(zi => { for (let k = 0; k < 3; k++) { const d = evalP(zi, dcs); if (Math.hypot(d[0], d[1]) === 0) break; const s = div(evalP(zi, a), d); zi = [zi[0] - s[0], zi[1] - s[1]]; } return zi; });
  return z.map(([re, im]) => (Math.abs(im) <= 1e-10 * Math.max(1, Math.abs(re)) ? re : math.complex(re, im) as unknown as Val));
}

/** Characteristic polynomial (ascending coefficients) via Faddeev–LeVerrier. */
function charPoly(A: number[][]): number[] {
  const n = A.length;
  const cs = new Array(n + 1).fill(0);
  cs[n] = 1;
  let M = A.map(r => r.map(() => 0));
  for (let k = 1; k <= n; k++) {
    const AM = A.map((r, i) => r.map((_, j) => r.reduce((s, x, t) => s + x * M[t][j], 0)));
    for (let i = 0; i < n; i++) AM[i][i] += cs[n - k + 1];
    M = AM;
    const AMk = A.map((r, i) => r.map((_, j) => r.reduce((s, x, t) => s + x * M[t][j], 0)));
    cs[n - k] = -AMk.reduce((s, r, i) => s + r[i], 0) / k;
  }
  return cs;
}

function sortEig(v: Val[]): Val[] {
  const re = (x: Val) => (isComplex(x) ? (x as Complex).re : x as number);
  return v.map(x => (isComplex(x) && Math.abs((x as Complex).im) < 1e-12 ? (x as Complex).re : x)).sort((a, b) => re(b) - re(a));
}
function normVec(v: Val[]): Val[] {
  const xs = v.map(x => toNumber(x));
  const n = Math.sqrt(xs.reduce((s, x) => s + x * x, 0));
  // sign convention (as observed in Mathcad): the largest component is positive (last one on ties)
  let k = 0;
  xs.forEach((x, i) => { if (Math.abs(x) >= Math.abs(xs[k]) - 1e-9) k = i; });
  const sgn = xs[k] < 0 ? -1 : 1;
  return xs.map(x => sgn * x / n);
}
function condNum(a: Val, p: 1 | 2 | 'fro' | 'inf'): number {
  const m = asMatrix(a);
  if (p === 2) {
    const s = math.eigs(math.multiply(math.transpose(m), m) as Matrix).values;
    const vals = toArr(s).map(x => Math.sqrt(Math.abs(toNumber(x))));
    return Math.max(...vals) / Math.min(...vals);
  }
  return (math.norm(m, p) as number) * (math.norm(math.inv(m), p) as number);
}
function rref(m: Matrix): Matrix {
  const A = matrixRows(m).map(r => r.map(x => toNumber(x)));
  const rows = A.length, cols = A[0].length;
  let lead = 0;
  for (let r = 0; r < rows && lead < cols; r++) {
    let i = r;
    while (Math.abs(A[i][lead]) < 1e-12) { i++; if (i === rows) { i = r; lead++; if (lead === cols) return makeMatrix(A); } }
    [A[i], A[r]] = [A[r], A[i]];
    const lv = A[r][lead];
    A[r] = A[r].map(x => x / lv);
    for (let k = 0; k < rows; k++) if (k !== r) { const f = A[k][lead]; A[k] = A[k].map((x, j) => x - f * A[r][j]); }
    lead++;
  }
  return makeMatrix(A.map(r => r.map(x => (Math.abs(x) < 1e-14 ? 0 : x))));
}
function hyper(m: number, a: number, b: number, n: number): number {
  if (m < Math.max(0, n - b) || m > Math.min(a, n) || m !== Math.floor(m)) return 0;
  const lc = (x: number, k: number) => lgammaN(x + 1) - lgammaN(k + 1) - lgammaN(x - k + 1);
  return Math.exp(lc(a, m) + lc(b, n - m) - lc(a + b, n));
}
function lgammaN(x: number): number { return lgamma(x); }

/** Determinant; plain numeric matrices via LU with partial pivoting (no NaN from overflowing intermediate values). */
export function determinant(m: Matrix): Val {
  const s = m.size();
  if (s.length !== 2 || s[0] !== s[1]) throw new CalcError('Determinante nur für quadratische Matrizen');
  const rows = matrixRows(m);
  if (!rows.every(r => r.every(x => typeof x === 'number'))) return math.det(m) as Val;
  const n = s[0];
  const A = rows.map(r => (r as number[]).slice());
  let logAbs = 0, sign = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (A[p][c] === 0) return 0;
    if (p !== c) { [A[p], A[c]] = [A[c], A[p]]; sign = -sign; }
    const piv = A[c][c];
    if (piv < 0) sign = -sign;
    logAbs += Math.log(Math.abs(piv));
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / piv;
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
    }
  }
  // exact product for moderate values, otherwise via the logarithm (may give ±∞)
  if (logAbs < 700) { let d = sign; for (let c = 0; c < n; c++) d *= Math.abs(A[c][c]); return d; }
  return sign * Math.exp(logAbs);
}

/** Γ(x) with an error at the poles 0, −1, −2, … */
function gammaFn(x: number): number {
  if (x <= 0 && Number.isInteger(x)) throw new CalcError('Γ hat bei 0, −1, −2, … Polstellen');
  return math.gamma(x) as number;
}

/** Complementary error function without cancellation for large x. */
function erfc(x: number): number {
  if (x < 0) return 2 - erfc(-x);
  if (x < 0.5) return 1 - (math.erf(x) as number);
  return gammaQ(0.5, x * x);
}
function siOrNum(v: Val): number { return isUnit(v) ? (v as Unit).value as number : toNumber(v); }
function scaleLike(tmpl: Val, x: number): Val { return isUnit(tmpl) ? withValue(tmpl as Unit, x) : x; }
function regress(args: Val[], what: 'slope' | 'intercept'): number {
  const a = elements([args[0]]).map(x => toNumber(x)), b = elements([args[1]]).map(x => toNumber(x));
  const n = a.length; const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; }
  const k = sab / saa;
  return what === 'slope' ? k : mb - k * ma;
}
BUILTINS['Min'] = BUILTINS.min;

function toArr(v: unknown): Val[] {
  if (math.isMatrix(v)) return (v as Matrix).toArray().flat() as Val[];
  return (v as Val[]).flat() as Val[];
}

function matrixRank(m: Matrix): number {
  const A = matrixRows(m).map(r => r.map(x => toNumber(x)));
  const rows = A.length, cols = A[0].length;
  let rank = 0;
  const eps = 1e-10 * Math.max(1, ...A.flat().map(Math.abs));
  for (let c = 0; c < cols && rank < rows; c++) {
    let p = rank;
    for (let r = rank + 1; r < rows; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) <= eps) continue;
    [A[rank], A[p]] = [A[p], A[rank]];
    for (let r = rank + 1; r < rows; r++) {
      const f = A[r][c] / A[rank][c];
      for (let k = c; k < cols; k++) A[r][k] -= f * A[rank][k];
    }
    rank++;
  }
  return rank;
}

function siNum(v: Val): number {
  if (isUnit(v)) return (v as Unit).value as number;
  return toNumber(v);
}
function toNumberOrComplex(x: Val): number | Complex {
  if (isComplex(x)) return x as Complex;
  return toNumber(x, 'Exponent');
}
function logOf(x: Val): Val {
  if (isComplex(x)) return math.log(x as Complex) as Val;
  const n = toNumber(x, 'Logarithmus-Argument');
  if (n < 0) return math.log(math.complex(n, 0)) as Val;
  if (n === 0) throw new CalcError('Logarithmus von 0 ist nicht definiert');
  return Math.log(n);
}
function variance(e: Val[], sample: boolean): Val {
  const n = e.length;
  if (n < (sample ? 2 : 1)) throw new CalcError('Zu wenige Werte');
  if (e.every(x => typeof x === 'number')) {
    const xs = e as number[];
    const m = xs.reduce((a, b) => a + b, 0) / n;
    return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (sample ? n - 1 : n);
  }
  // quantities (a plain 0 is compatible with every unit)
  const firstU = e.find(x => isUnit(x));
  if (firstU && e.every(x => x === 0 || (isUnit(x) && typeof (x as unknown as { value: unknown }).value === 'number' && !hasOffset(x as unknown as Unit)))) {
    const xs = e.map(x => (x === 0 ? 0 : (x as unknown as { value: number }).value));
    const d = (firstU as unknown as { dimensions: number[] }).dimensions;
    if (e.every(x => x === 0 || (x as unknown as { dimensions: number[] }).dimensions.every((v, i) => v === d[i]))) {
      const m = xs.reduce((a, b) => a + b, 0) / n;
      return mkQ(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (sample ? n - 1 : n), d.map(v => 2 * v));
    }
  }
  const mean = math.divide(e.reduce((a, b) => math.add(a as number, b as number) as Val) as number, n) as Val;
  let s: Val | undefined;
  for (const x of e) {
    const d = math.subtract(x as number, mean as number) as Val;
    const sq = math.multiply(d as number, d as number) as Val;
    s = s === undefined ? sq : math.add(s as number, sq as number) as Val;
  }
  return math.divide(s as number, sample ? n - 1 : n) as Val;
}
function stdev(e: Val[], sample: boolean): Val { return math.sqrt(variance(e, sample) as number) as Val; }

/* ------------------------------------------------------------------ */
/* Lazy builtins (receive unevaluated nodes)                           */
/* ------------------------------------------------------------------ */

/** Side of a one-sided limit: "right"/"rechts"/"+" → 1, "left"/"links"/"-" → −1. */
export function limitSide(n: Node | undefined): -1 | 0 | 1 {
  if (!n) return 0;
  const s = n.k === 'str' ? n.v.toLowerCase() : n.k === 'id' ? n.name.toLowerCase() : '';
  if (['right', 'rechts', '+'].includes(s)) return 1;
  if (['left', 'links', '-'].includes(s)) return -1;
  throw new CalcError('lim: Seite "left" oder "right"');
}

const varName = (n: Node, fn: string): string => {
  if (n.k !== 'id') throw new CalcError(`${fn}: zweites Argument muss eine Variable sein`);
  return n.name;
};

export const LAZY_BUILTINS: Record<string, Lazy> = {
  if: (args, scope, ev) => {
    if (args.length !== 3) throw new CalcError('if(Bedingung, dann, sonst) erwartet');
    return ev.truthy(ev.eval(args[0], scope)) ? ev.eval(args[1], scope) : ev.eval(args[2], scope);
  },
  root: (args, scope, ev) => {
    if (args.length !== 2 && args.length !== 4) throw new CalcError('root(f(x), x) oder root(f(x), x, a, b) erwartet');
    const v = varName(args[1], 'root');
    if (args.length === 4) {
      const a = ev.eval(args[2], scope), b = ev.eval(args[3], scope);
      const { f } = ev.numericFn(args[0], v, scope, a);
      const ta = isUnit(a) ? (a as Unit).value as number : toNumber(a);
      const tb = isUnit(b) ? (b as Unit).value as number : toNumber(b);
      const x = brent(f, ta, tb);
      checkRoot(f, x, [ta, tb]);
      return withUnit(x, a);
    }
    const guess = scope.get(v);
    if (guess === undefined) throw new CalcError(`root: Schätzwert für ${v} muss vorher definiert sein`, v);
    const { f } = ev.numericFn(args[0], v, scope, guess);
    const t0 = isUnit(guess) ? (guess as Unit).value as number : toNumber(guess);
    const x = rootFromGuess(f, t0);
    checkRoot(f, x, [t0]);
    return withUnit(x, guess);
  },
  /** lim(f, x, a [, "left" | "right"]): numerical limit (symbolically with →). */
  lim: (args, scope, ev) => {
    if (args.length < 3 || args.length > 4) throw new CalcError('lim(f(x), x, a) oder lim(f(x), x, a, "right") erwartet');
    const v = varName(args[1], 'lim');
    const a = ev.eval(args[2], scope);
    const side = limitSide(args[3]);
    const ta = isUnit(a) ? (a as Unit).value as number : toNumber(a);
    const { f, probe } = ev.numericFn(args[0], v, scope, a);
    const L = limitNumeric(f, ta, side);
    // keep the unit of the function value
    const pv = probe(Math.abs(ta) >= 1e300 ? Math.sign(ta) * 1e6 : ta + (side || 1) * 1e-3);
    return isUnit(pv) ? withUnit(L, pv) : L;
  },
  Find: (args, scope, ev) => solveBlock(args, scope, ev, false),
  find: (args, scope, ev) => solveBlock(args, scope, ev, false),
  Minerr: (args, scope, ev) => solveBlock(args, scope, ev, true),
};

/** Accept a root only if |f(x)| is really small (rejects poles and jumps). */
function checkRoot(f: (x: number) => number, x: number, ref: number[]) {
  const fx = Math.abs(f(x));
  let s = 0;
  for (const t of ref) { const v = Math.abs(f(t)); if (isFinite(v)) s = Math.max(s, v); }
  if (!(fx <= 1e-3 * Math.min(1, s) + 1e-7 * s) && !(fx <= 1e-12)) {
    throw new CalcError('root: keine Nullstelle gefunden (Polstelle oder Sprung?) – Schätzwert/Intervall ändern');
  }
}

function withUnit(t: number, tmpl: Val): Val {
  if (isUnit(tmpl)) return withValue(tmpl as Unit, t);
  return t;
}

function solveBlock(args: Node[], outer: Scope, ev: Evaluator, allowResidual: boolean): Val {
  const names = args.map(a => varName(a, 'Find'));
  // guess values of the block are evaluated here, so they may depend on function arguments
  const scope = new Scope(outer);
  for (const g of ev.guesses) {
    try { scope.set(g.name, ev.eval(g.expr, scope)); } catch { /* keep an outer value if there is one */ }
  }
  if (!ev.constraints.length) throw new CalcError('Find: keine Bedingungen – „Given“ und Gleichungen davor einfügen');
  const guesses = names.map(n => {
    const g = scope.get(n);
    if (g === undefined) throw new CalcError(`Find: Schätzwert für ${n} fehlt`, n);
    return g;
  });
  const x0 = guesses.map(g => (isUnit(g) ? (g as Unit).value as number : toNumber(g)));
  const num = (v: Val) => (isUnit(v) ? (v as Unit).value as number : toNumber(v));
  /** Raw residual of every constraint: kind, difference a−b and magnitude max(|a|,|b|). */
  const raw = (x: number[]) => {
    const out: { op: string; d: number; m: number }[] = [];
    for (const c of ev.constraints) {
      const local = new Scope(scope);
      names.forEach((n, i) => local.set(n, withUnit(x[i], guesses[i])));
      const node = c.node.k === 'paren' ? c.node.a : c.node;
      if (node.k !== 'bin') continue;
      if (!['==', '<', '<=', '>', '>='].includes(node.op)) continue;
      const a = ev.eval(node.a, local), b = ev.eval(node.b, local);
      out.push({ op: node.op, d: num(ev.binary('-', a, b)), m: Math.max(Math.abs(num(a)), Math.abs(num(b))) });
    }
    return out;
  };
  const viol = (r: { op: string; d: number }) =>
    r.op === '==' ? r.d : r.op === '<' || r.op === '<=' ? Math.max(0, r.d) : Math.min(0, r.d);
  // residual scaling: magnitude at the guess for Find (units of any size), none for Minerr (plain least squares)
  const r0 = raw(x0);
  const scales = r0.map(r => (allowResidual ? 1 : (r.m > 0 && isFinite(r.m) ? r.m : 1)));
  const residuals = (eqOnly: boolean) => (x: number[]): number[] => {
    const rs = raw(x);
    const out: number[] = [];
    rs.forEach((r, i) => { if (!eqOnly || r.op === '==') out.push(viol(r) / scales[i]); });
    return out;
  };
  /** Mathcad's constraint tolerance CTOL = 10⁻³, relative for large magnitudes. */
  const satisfied = (x: number[]) => raw(x).every((r, i) => {
    const v = Math.abs(viol(r));
    // magnitude: at the solution, but at least 10⁻³ of the magnitude at the guess (equations like f(x) = 0)
    const ref = r0[i] && r0[i].m > 0 && isFinite(r0[i].m) ? r0[i].m : 1;
    const m = Math.max(r.m, 1e-3 * ref);
    return isFinite(v) && v <= 1e-3 * Math.min(1, m) + 1e-6 * m + 1e-12;
  });
  /**
   * Residual left by numerical noise (e.g. nested integrals): a Newton step from x would move it only
   * negligibly. At a false solution (local minimum of the residual) the Jacobian is nearly singular and the
   * Newton step is large.
   */
  const converged = (x: number[]) => {
    const rs = raw(x);
    const eqs = rs.map((r, i) => i).filter(i => rs[i].op === '==');
    if (rs.some(r => r.op !== '==' && Math.abs(viol(r)) > 0)) return false;
    const r = eqs.map(i => rs[i].d);
    if (!r.every(isFinite)) return false;
    if (Math.hypot(...eqs.map(i => r[eqs.indexOf(i)] / scales[i])) > 1e-4) return false;
    const n = x.length;
    const J: number[][] = r.map(() => new Array(n).fill(0));
    const hs = x.map((v, j) => 1e-6 * Math.max(Math.abs(v), Math.abs(x0[j])) || 1e-9);
    const big = x.map((v, j) => Math.max(Math.abs(v), Math.abs(x0[j])));
    for (let j = 0; j < n; j++) {
      // a variable that is (almost) 0 needs a larger step than its own magnitude
      for (let tries = 0; tries < 6; tries++) {
        const xp = x.slice(); xp[j] += hs[j];
        const rp = raw(xp);
        eqs.forEach((i, k) => { J[k][j] = (rp[i].d - r[k]) / hs[j]; });
        if (J.some(row => row[j] !== 0)) break;
        hs[j] = Math.max(hs[j] * 1e3, 1e-12);
      }
    }
    // least squares step (JᵀJ) δ = Jᵀ r
    const A = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J.reduce((s, row) => s + row[a] * row[b], 0)));
    const g = Array.from({ length: n }, (_, a) => J.reduce((s, row, k) => s + row[a] * r[k], 0));
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let q = c + 1; q < n; q++) if (Math.abs(A[q][c]) > Math.abs(A[piv][c])) piv = q;
      if (!(Math.abs(A[piv][c]) > 0)) return false;
      [A[c], A[piv]] = [A[piv], A[c]]; [g[c], g[piv]] = [g[piv], g[c]];
      for (let q = c + 1; q < n; q++) {
        const f = A[q][c] / A[c][c];
        for (let w = c; w < n; w++) A[q][w] -= f * A[c][w];
        g[q] -= f * g[c];
      }
    }
    const d = new Array(n).fill(0);
    for (let c = n - 1; c >= 0; c--) {
      let t = g[c];
      for (let w = c + 1; w < n; w++) t -= A[c][w] * d[w];
      d[c] = t / A[c][c];
    }
    // the remaining residual must be explained by the linear model as well (not a minimum of |r|)
    const lin = J.map((row, k) => r[k] - row.reduce((s, v, j) => s + v * d[j], 0));
    if (Math.hypot(...lin) > 1e-3 * Math.hypot(...r)) return false;
    // step small compared with the variable (or with the finite-difference step for a variable at 0)
    return d.every((v, j) => isFinite(v) && Math.abs(v) <= 1e-6 * big[j] + 1e-3 * hs[j]);
  };
  ev.inSolver++;
  let x: number[] = x0;
  let ok = false;
  try {
    const attempt = (start: number[], eqOnly: boolean) => {
      try { return solveSystem(residuals(eqOnly), start).x; } catch (e) { if (e instanceof CalcError) throw e; return null; }
    };
    const starts = [x0];
    starts.push(x0.map(v => -v), x0.map(v => v + 1), x0.map(v => -v - 1), x0.map(v => 2 * v + 1), x0.map(v => -2 * v - 1));
    if (allowResidual) {
      x = attempt(x0, false) ?? x0;
      ok = true;
    } else {
      const hasIneq = r0.some(r => r.op !== '==');
      outer: for (const eqOnly of [false, true]) {
        // second pass: equations only (inequalities checked afterwards) from several starting points
        for (const st of eqOnly ? (hasIneq ? starts : starts.slice(1)) : [x0]) {
          const cand = attempt(st, eqOnly);
          if (cand && (satisfied(cand) || converged(cand))) { x = cand; ok = true; break outer; }
        }
      }
      // one unknown, one equation: secant/bracket search as for root()
      if (!ok && names.length === 1 && r0.filter(r => r.op === '==').length === 1) {
        const k = r0.findIndex(r => r.op === '==');
        try {
          const t = rootFromGuess(v => raw([v])[k].d, x0[0]);
          if (satisfied([t])) { x = [t]; ok = true; }
        } catch (e) { if (!(e instanceof CalcError)) throw e; }
      }
    }
  } finally { ev.inSolver--; }
  if (!ok) throw new CalcError('Find: keine Lösung gefunden – Schätzwerte oder Bedingungen prüfen');
  const vals = x.map((t, i) => withUnit(t, guesses[i]));
  return vals.length === 1 ? vals[0] : column(vals);
}

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

/** Physical constants of Mathcad Prime (accessible as 'name, e.g. 'k, 'N_A). */
export const PHYS_CONSTANTS: Record<string, () => Val> = {
  h: () => math.unit(6.62607015e-34, 'J s'),
  'ℏ': () => math.unit(1.054571817e-34, 'J s'),
  k: () => math.unit(1.380649e-23, 'J/K'),
  k_B: () => math.unit(1.380649e-23, 'J/K'),
  m_u: () => math.unit(1.66053906660e-27, 'kg'),
  m_e: () => math.unit(9.1093837015e-31, 'kg'),
  m_p: () => math.unit(1.67262192369e-27, 'kg'),
  N_A: () => math.unit(6.02214076e23, 'mol^-1'),
  R: () => math.unit(8.314462618, 'J/(K mol)'),
  'R_∞': () => math.unit(10973731.568160, 'm^-1'),
  'α': () => 7.2973525693e-3,
  'γ': () => 0.5772156649015329,
  'ε_0': () => math.unit(8.8541878128e-12, 'F/m'),
  'μ_0': () => math.unit(1.25663706212e-6, 'H/m'),
  e_c: () => math.unit(1.602176634e-19, 'C'),
  q_e: () => math.unit(1.602176634e-19, 'C'),
  'σ_SB': () => math.unit(5.670374419e-8, 'W/(m^2 K^4)'),
  'σ': () => math.unit(5.670374419e-8, 'W/(m^2 K^4)'),
  'Φ_0': () => math.unit(2.067833848e-15, 'Wb'),
  'G_0': () => math.unit(7.748091729e-5, 'S'),
  'K_J': () => math.unit(483597.8484e9, 'Hz/V'),
  'R_K': () => math.unit(25812.80745, 'ohm'),
  'a_0': () => math.unit(5.29177210903e-11, 'm'),
  'F_c': () => math.unit(96485.33212, 'C/mol'),
  'V_m': () => math.unit(22.41396954e-3, 'm^3/mol'),
  c: () => math.unit(299792458, 'm/s'),
  g: () => math.unit(9.80665, 'm/s^2'),
  G: () => math.unit(6.6743e-11, 'm^3/(kg s^2)'),
  e: () => Math.E,
  'π': () => Math.PI,
};

export const CONSTANTS: Record<string, () => Val> = {
  'π': () => Math.PI,
  pi: () => Math.PI,
  e: () => Math.E,
  '∞': () => 1e307,
  g: () => math.unit(9.80665, 'm/s^2'),
  NaN: () => NaN,
  TOL: () => 1e-3,
  CTOL: () => 1e-3,
  true: () => 1,
  false: () => 0,
};

/** All names offered by autocompletion. */
export const BUILTIN_NAMES = [...Object.keys(BUILTINS), ...Object.keys(LAZY_BUILTINS), 'sum', 'prod', 'int', 'deriv', 'nthroot', 'vec', 'col'].sort();

export function isBuiltinFunction(name: string) { return name in BUILTINS || name in LAZY_BUILTINS; }

// further Mathcad functions (interpolation, prediction, outlier tests, rank statistics …)
Object.assign(BUILTINS, EXTRA_BUILTINS);

// lookup tables without prototype: names like "toString" or "__proto__" are not functions/constants
for (const t of [BUILTINS, LAZY_BUILTINS, PHYS_CONSTANTS, CONSTANTS]) Object.setPrototypeOf(t, null);
