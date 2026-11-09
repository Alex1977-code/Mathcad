import type { Complex, Matrix, Unit } from 'mathjs';
import type { Node } from './ast';
import type { Evaluator } from './evaluator';
import { math } from './units';
import {
  CalcError, Scope, isFn, isMatrix, isUnit, isComplex, isRange, makeMatrix, matrixRows,
  toInt, toNumber, rangeValues, type FnVal, type Val,
} from './values';
import { cross3 as crossFn } from './evaluator';
import { brent, pnormStd, qnormStd, rootFromGuess, solveSystem } from './numeric';
import { DISTRIBUTIONS, distFunction, distRandom, percentile, setStatsSeed } from './stats';

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
    if (isMatrix(a)) out.push(...((a as Matrix).toArray().flat(3) as Val[]));
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

function roundTo(x: Val, mult: Val, mode: 'floor' | 'ceil' | 'round'): Val {
  const q = math.divide(x as Unit, mult as Unit) as unknown;
  const qn = typeof q === 'number' ? q : toNumber(q as Val);
  const r = mode === 'floor' ? Math.floor(qn + 1e-12) : mode === 'ceil' ? Math.ceil(qn - 1e-12) : Math.round(qn);
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
  floor: map1(x => (Math.floor(toNumber(x) + 1e-13 * Math.abs(toNumber(x))))),
  ceil: map1(x => Math.ceil(toNumber(x) - 1e-13 * Math.abs(toNumber(x)))),
  trunc: map1(x => Math.trunc(toNumber(x))),
  round: (args) => {
    nargs('round', args, 1, 2);
    const n = args.length === 2 ? toInt(args[1], 'Stellen') : 0;
    const f = (x: Val) => { const p = Math.pow(10, n); return Math.round(toNumber(x) * p + Math.sign(toNumber(x)) * 1e-9) / p; };
    return isMatrix(args[0]) ? math.map(args[0] as Matrix, (x: unknown) => f(x as Val)) as Matrix : f(args[0]);
  },
  Floor: (args) => { nargs('Floor', args, 2); return roundTo(args[0], args[1], 'floor'); },
  Ceil: (args) => { nargs('Ceil', args, 2); return roundTo(args[0], args[1], 'ceil'); },
  Round: (args) => { nargs('Round', args, 2); return roundTo(args[0], args[1], 'round'); },
  Trunc: (args) => { nargs('Trunc', args, 2); const q = toNumber(math.divide(args[0] as Unit, args[1] as Unit) as Val); return math.multiply(args[1] as Unit, Math.trunc(q)) as Val; },
  mod: (args) => { nargs('mod', args, 2); return mathcadMod(args[0], args[1]); },
  gcd: (args) => elements(args).map(x => toInt(x)).reduce((a, b) => math.gcd(a, b)),
  lcm: (args) => elements(args).map(x => toInt(x)).reduce((a, b) => math.lcm(a, b)),
  combin: (args) => { nargs('combin', args, 2); return math.combinations(toInt(args[0]), toInt(args[1])); },
  permut: (args) => { nargs('permut', args, 2); return math.permutations(toInt(args[0]), toInt(args[1])); },
  'Γ': map1(x => math.gamma(toNumber(x))),
  gamma: map1(x => math.gamma(toNumber(x))),
  erf: map1(x => math.erf(toNumber(x))),
  erfc: map1(x => 1 - math.erf(toNumber(x))),
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
  mean: (args) => { const e = elements(args); if (e.every(x => typeof x === 'number')) return (e as number[]).reduce((a, b) => a + b, 0) / e.length; return math.divide(e.reduce((a, b) => math.add(a as number, b as number) as Val) as number, e.length) as Val; },
  median: (args) => { const e = elements(args).slice().sort(compareVals); const n = e.length; return n % 2 ? e[(n - 1) / 2] : math.divide(math.add(e[n / 2 - 1] as number, e[n / 2] as number), 2) as Val; },
  stdev: (args) => stdev(elements(args), false),
  Stdev: (args) => stdev(elements(args), true),
  var: (args) => variance(elements(args), false),
  Var: (args) => variance(elements(args), true),
  gmean: (args) => { const e = elements(args).map(x => toNumber(x)); return Math.exp(e.reduce((a, b) => a + Math.log(b), 0) / e.length); },
  hmean: (args) => { const e = elements(args).map(x => toNumber(x)); return e.length / e.reduce((a, b) => a + 1 / b, 0); },
  sum: (args) => { const e = elements(args); if (e.every(x => typeof x === 'number')) return (e as number[]).reduce((a, b) => a + b, 0); return e.reduce((a, b) => math.add(a as number, b as number) as Val, 0 as Val) },

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
    if (c === 1 || r === 1) { const e = m.toArray().flat() as Val[]; return math.diag(e as number[]) as Matrix; }
    return column((math.diag(m) as Matrix).toArray() as Val[]);
  },
  tr: (args) => { nargs('tr', args, 1); return math.trace(asMatrix(args[0])) as Val; },
  trace: (args) => { nargs('trace', args, 1); return math.trace(asMatrix(args[0])) as Val; },
  det: (args) => { nargs('det', args, 1); return math.det(asMatrix(args[0])) as Val; },
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
  lsolve: (args) => { nargs('lsolve', args, 2); return math.lusolve(asMatrix(args[0]), asMatrix(args[1])) as Matrix; },
  eigenvals: (args) => { nargs('eigenvals', args, 1); const r = math.eigs(asMatrix(args[0])); return column(sortEig(toArr(r.values))); },
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
    const r = math.eigs(math.multiply(math.inv(asMatrix(args[1])), asMatrix(args[0])) as Matrix);
    const re = (x: Val) => (isComplex(x) ? (x as Complex).re : x as number);
    const pairs = r.eigenvectors.map(e => ({ v: e.value as unknown as Val, vec: normVec(toArr(e.vector)) })).sort((a, b) => re(b.v) - re(a.v));
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
  skew: (args) => { const e = elements(args).map(x => toNumber(x)); const n = e.length; const m = e.reduce((a, b) => a + b, 0) / n; const s = Math.sqrt(e.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)); return n / ((n - 1) * (n - 2)) * e.reduce((a, b) => a + ((b - m) / s) ** 3, 0); },
  kurt: (args) => { const e = elements(args).map(x => toNumber(x)); const n = e.length; const m = e.reduce((a, b) => a + b, 0) / n; const s = Math.sqrt(e.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)); return n * (n + 1) / ((n - 1) * (n - 2) * (n - 3)) * e.reduce((a, b) => a + ((b - m) / s) ** 4, 0) - 3 * (n - 1) ** 2 / ((n - 2) * (n - 3)); },
  corr: (args) => { nargs('corr', args, 2); const a = elements([args[0]]).map(x => toNumber(x)), b = elements([args[1]]).map(x => toNumber(x)); const n = a.length; const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); },
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
    rows.forEach((r, i) => r.forEach((x, j) => { if (valEq(x, args[0])) out.push(r.length === 1 ? i + ev.opts.origin : makeMatrix([[i + ev.opts.origin], [j + ev.opts.origin]])); }));
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
    const comp = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (j === n - 1 ? -c[i] / c[n] : (i === j + 1 ? 1 : 0))));
    const vals = toArr(math.eigs(comp).values).map(v => (isComplex(v) && Math.abs((v as Complex).im) < 1e-10 ? (v as Complex).re : v));
    vals.sort((a, b) => (isComplex(a) ? (a as Complex).re : (a as number)) - (isComplex(b) ? (b as Complex).re : (b as number)));
    return column(vals);
  },

  // probability
  dnorm: (args) => { nargs('dnorm', args, 3); return normalPdf(siNum(args[0]), siNum(args[1]), siNum(args[2])); },
  pnorm: (args) => { nargs('pnorm', args, 3); return pnormStd((siNum(args[0]) - siNum(args[1])) / siNum(args[2])); },
  cnorm: (args) => { nargs('cnorm', args, 1); return pnormStd(siNum(args[0])); },
  qnorm: (args) => { nargs('qnorm', args, 3); return siNum(args[1]) + siNum(args[2]) * qnormStd(siNum(args[0])); },
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
  UnitsOf: (args) => { nargs('UnitsOf', args, 1); const a = args[0]; if (!isUnit(a)) return 1; const u = (a as Unit).clone(); (u as unknown as { value: number }).value = 1; return u; },
  SIUnitsOf: (args) => { nargs('SIUnitsOf', args, 1); const a = args[0]; if (!isUnit(a)) return 1; const u = (a as Unit).clone(); (u as unknown as { value: number }).value = 1; return u; },
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
  const z = u.clone(); (z as unknown as { value: number }).value = 0;
  return z;
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
function lgammaN(x: number): number { return Math.log(Math.abs(math.gamma(x) as number)); }
function siOrNum(v: Val): number { return isUnit(v) ? (v as Unit).value as number : toNumber(v); }
function scaleLike(tmpl: Val, x: number): Val { if (isUnit(tmpl)) { const u = (tmpl as Unit).clone(); (u as unknown as { value: number }).value = x; return u; } return x; }
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
      return withUnit(brent(f, ta, tb), a);
    }
    const guess = scope.get(v);
    if (guess === undefined) throw new CalcError(`root: Schätzwert für ${v} muss vorher definiert sein`, v);
    const { f } = ev.numericFn(args[0], v, scope, guess);
    const t0 = isUnit(guess) ? (guess as Unit).value as number : toNumber(guess);
    return withUnit(rootFromGuess(f, t0), guess);
  },
  Find: (args, scope, ev) => solveBlock(args, scope, ev, false),
  find: (args, scope, ev) => solveBlock(args, scope, ev, false),
  Minerr: (args, scope, ev) => solveBlock(args, scope, ev, true),
};

function withUnit(t: number, tmpl: Val): Val {
  if (isUnit(tmpl)) { const u = (tmpl as Unit).clone(); (u as unknown as { value: number }).value = t; return u; }
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
  let scales: number[] | null = null;
  const residuals = (x: number[]): number[] => {
    const out: number[] = [];
    const first = scales === null;
    if (first) scales = [];
    let ci = -1;
    for (const c of ev.constraints) {
      ci++;
      const local = new Scope(scope);
      names.forEach((n, i) => local.set(n, withUnit(x[i], guesses[i])));
      const node = c.node.k === 'paren' ? c.node.a : c.node;
      if (node.k !== 'bin') continue;
      const a = ev.eval(node.a, local), b = ev.eval(node.b, local);
      const d = ev.binary('-', a, b);
      const dn = isUnit(d) ? (d as Unit).value as number : toNumber(d);
      // scale residuals by the magnitude at the initial guess (keeps units of any size comparable)
      if (first) {
        const sc = Math.max(Math.abs(isUnit(a) ? (a as Unit).value as number : toNumber(a)), Math.abs(isUnit(b) ? (b as Unit).value as number : toNumber(b)));
        scales!.push(sc > 0 && isFinite(sc) ? sc : 1);
      }
      const scale = scales![ci] ?? 1;
      switch (node.op) {
        case '==': out.push(dn / scale); break;
        case '<': case '<=': out.push(Math.max(0, dn) / scale); break;
        case '>': case '>=': out.push(Math.min(0, dn) / scale); break;
        default: break;
      }
    }
    return out;
  };
  ev.inSolver++;
  let sol: { x: number[]; residual: number };
  try { sol = solveSystem(residuals, x0); } finally { ev.inSolver--; }
  const { x, residual } = sol;
  // Mathcad's constraint tolerance CTOL is 10⁻³; residuals are relative to the magnitude at the guess
  if (!allowResidual && residual > 1e-4) throw new CalcError('Find: keine Lösung gefunden – Schätzwerte ändern');
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
