/**
 * Symbolic evaluation "→" (Mathcad's live symbolics, a practical subset): defined numbers, quantities and
 * functions are substituted, unknown names stay symbolic, then the expression is simplified with mathjs.
 *
 * Keywords after the arrow:
 *   → simplify (default) · → expand · → float, n · → solve, x  (also systems: [eq1; eq2] → solve, x, y)
 *   → substitute, x = a + 1 · → factor · → coeffs, x · → series, x = a, n
 * Derivatives (d/dx, deriv) and integrals (int(f, x), int(f, x, a, b)) are formed symbolically.
 */
import type { MathNode, Unit } from 'mathjs';
import type { Node } from './ast';
import { math, lookupUnit } from './units';
import { CalcError, isUnit, type FnVal, type Scope, type Val } from './values';
import { siUnitFactors } from './format';
import { limitNumeric } from './numeric';
import { limitSide } from './builtins';

export interface SymKeyword { name: string; args: Node[] }
export const SYM_KEYWORDS = ['simplify', 'expand', 'float', 'solve', 'substitute', 'factor', 'coeffs', 'series', 'parfrac'];

/** Our function names → mathjs names (and back). */
const TO_MATH: Record<string, string> = {
  ln: 'log', log: 'log10', exp: 'exp', sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc',
  asin: 'asin', acos: 'acos', atan: 'atan', sinh: 'sinh', cosh: 'cosh', tanh: 'tanh', asinh: 'asinh', acosh: 'acosh', atanh: 'atanh',
  sqrt: 'sqrt', abs: 'abs', sign: 'sign',
};
const FROM_MATH: Record<string, string> = Object.fromEntries(Object.entries(TO_MATH).map(([a, b]) => [b, a]));

const unsupported = (what: string) => new CalcError(`Symbolisch nicht unterstützt: ${what}`);

/** Translates between our names and safe mathjs symbol names. */
class Names {
  private toSym = new Map<string, string>();
  private fromSym = new Map<string, string>();
  sym(name: string): string {
    let s = this.toSym.get(name);
    if (!s) {
      s = 'v' + String.fromCharCode(97 + Math.floor(this.toSym.size / 26)) + String.fromCharCode(97 + (this.toSym.size % 26));
      this.toSym.set(name, s); this.fromSym.set(s, name);
    }
    return s;
  }
  name(sym: string): string | undefined { return this.fromSym.get(sym); }
}

const num = (v: number) => (Number.isInteger(v) || Math.abs(v) >= 1e-6 ? String(v) : v.toExponential());

/** Value of a defined name as mathjs text, or null to keep the name symbolic. */
function valueText(v: Val, names: Names): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? `(${num(v)})` : null;
  if (isUnit(v)) {
    const u = v as Unit;
    const val = u.value as unknown;
    if (typeof val !== 'number') return null;
    const f = siUnitFactors(u.dimensions);
    return `(${num(val)}${f.map(([s, p]) => ` * ${names.sym(s)}${p === 1 ? '' : `^(${p})`}`).join('')})`;
  }
  return null;
}

/* ------------------------------ mathjs helpers ----------------------------- */

type MNode = MathNode & Record<string, unknown>;
const P = (t: string) => math.parse(t);
/** Simplify; constant function values that are exact integers (sin(π), cos(π), ln(e) …) become numbers. */
const S = (m: MathNode | string): MathNode => {
  const s = math.simplify(m);
  let changed = false;
  const f = s.transform(n => {
    if (n.type !== 'FunctionNode' || hasAnySymbol(n)) return n;
    try {
      const v = n.evaluate();
      if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v - Math.round(v)) < 1e-12) { changed = true; return new math.ConstantNode(Math.round(v)); }
    } catch { /* keep */ }
    return n;
  });
  return changed ? math.simplify(f) : s;
};
const str = (m: MathNode) => `(${m.toString()})`;
const symName = (m: MathNode) => (m.type === 'SymbolNode' ? (m as MNode).name as string : undefined);
const constVal = (m: MathNode): number | undefined => {
  const s = S(m);
  if (s.type === 'ConstantNode' && typeof (s as MNode).value === 'number') return (s as MNode).value as number;
  if (s.type === 'OperatorNode' && (s as MNode).fn === 'unaryMinus') { const v = constVal(((s as MNode).args as MathNode[])[0]); return v === undefined ? undefined : -v; }
  if (!hasAnySymbol(s)) { try { const v = s.evaluate(); if (typeof v === 'number') return v; } catch { /* not numeric */ } }
  return undefined;
};
const isZero = (m: MathNode) => constVal(m) === 0;
const hasSym = (m: MathNode, x: string) => { let f = false; m.traverse(n => { if (symName(n) === x) f = true; }); return f; };
function hasAnySymbol(m: MathNode) { let f = false; m.traverse((n, path) => { const s = symName(n); if (s && path !== 'fn' && !['pi', 'e', 'i'].includes(s)) f = true; }); return f; }
const subst = (m: MathNode, sym: string, by: MathNode) => m.transform(n => (symName(n) === sym ? by : n));
const D = (m: MathNode, x: string) => S(math.derivative(m, x));
const fact = (k: number) => { let f = 1; for (let i = 2; i <= k; i++) f *= i; return f; };

/** Coefficients c0, c1, … of a polynomial in x (null if not a polynomial up to degree 30). */
function polyCoeffs(m: MathNode, x: string): MathNode[] | null {
  if (!isPolyIn(m, x)) return null;
  const out: MathNode[] = [];
  let d: MathNode = S(m);
  for (let k = 0; k <= 30; k++) {
    if (isZero(d) && k > 0) return out;
    out.push(S(P(`${str(subst(d, x, new math.ConstantNode(0)))} / ${fact(k)}`)));
    d = D(d, x);
  }
  return null;
}

/** Structural test: built from +, −, ·, / by constants and non-negative integer powers of x. */
function isPolyIn(m: MathNode, x: string): boolean {
  if (!hasSym(m, x)) return true;
  const n = m as MNode;
  if (m.type === 'SymbolNode') return true;
  if (m.type === 'ParenthesisNode') return isPolyIn(n.content as MathNode, x);
  if (m.type !== 'OperatorNode') return false;
  const args = n.args as MathNode[];
  switch (n.fn) {
    case 'add': case 'subtract': case 'multiply': case 'unaryMinus': case 'unaryPlus': return args.every(a => isPolyIn(a, x));
    case 'divide': return !hasSym(args[1], x) && isPolyIn(args[0], x);
    case 'pow': { const k = hasSym(args[1], x) ? undefined : constVal(args[1]); return k !== undefined && Number.isInteger(k) && k >= 0 && k <= 30 && isPolyIn(args[0], x); }
    default: return false;
  }
}

/** Linear in x:  m = p·x + q  with p constant (≠ 0) → p, else null. */
function linearSlope(m: MathNode, x: string): MathNode | null {
  const p = D(m, x);
  if (hasSym(p, x) || isZero(p)) return null;
  return p;
}

/* ------------------------------- integration ------------------------------- */

/** Antiderivative by rules: linearity, powers/exponentials/trig of linear arguments, integration by parts. */
function integrate(m0: MathNode, x: string, depth = 0): MathNode {
  if (depth > 12) throw unsupported('Integral (zu verschachtelt)');
  const m = m0.type === 'ParenthesisNode' ? (m0 as MNode).content as MathNode : m0;
  const fail = () => unsupported(`Integral von ${m.toString().replace(/\bv[a-z]{2}\b/g, '…')}`);
  if (!hasSym(m, x)) return P(`${str(m)} * ${x}`);
  if (symName(m) === x) return P(`${x}^2 / 2`);
  const node = m as MNode;
  if (m.type === 'OperatorNode') {
    const fn = node.fn as string, args = node.args as MathNode[];
    if (fn === 'unaryMinus') return P(`-${str(integrate(args[0], x, depth + 1))}`);
    if (fn === 'unaryPlus') return integrate(args[0], x, depth + 1);
    if (fn === 'add' || fn === 'subtract') {
      const parts = args.map(a => str(integrate(a, x, depth + 1)));
      return P(fn === 'add' ? parts.join(' + ') : `${parts[0]} - ${parts[1]}`);
    }
    if (fn === 'multiply') {
      const cst = args.filter(a => !hasSym(a, x)), vars = args.filter(a => hasSym(a, x));
      if (cst.length) return P(`${cst.map(str).join(' * ')} * ${str(integrate(vars.length === 1 ? vars[0] : P(vars.map(str).join(' * ')), x, depth + 1))}`);
      // polynomial product: expand
      try { const e = math.rationalize(m) as MathNode; if (polyCoeffs(e, x)) return integrate(e, x, depth + 1); } catch { /* no polynomial */ }
      // integration by parts: polynomial · (exp | sin | cos | …)
      if (vars.length === 2) {
        for (const [a, b] of [[vars[0], vars[1]], [vars[1], vars[0]]]) {
          if (!polyCoeffs(a, x)) continue;
          let F: MathNode;
          try { F = S(integrate(b, x, depth + 1)); } catch { continue; }
          const da = D(a, x);
          const rest = isZero(da) ? '0' : str(integrate(S(P(`${str(da)} * ${str(F)}`)), x, depth + 1));
          return P(`${str(a)} * ${str(F)} - ${rest}`);
        }
      }
      throw fail();
    }
    if (fn === 'divide') {
      const [a, b] = args;
      if (!hasSym(b, x)) return P(`${str(integrate(a, x, depth + 1))} / ${str(b)}`);
      if (!hasSym(a, x)) {
        const p = linearSlope(b, x);
        if (p) return P(`${str(a)} * log(${str(b)}) / ${str(p)}`);
      }
      return integrate(P(`${str(a)} * ${str(b)}^(-1)`), x, depth + 1);
    }
    if (fn === 'pow') {
      const [base, ex] = args;
      if (!hasSym(ex, x)) {
        const p = linearSlope(base, x);
        if (p) {
          if (constVal(ex) === -1) return P(`log(${str(base)}) / ${str(p)}`);
          return P(`${str(base)}^(${str(ex)} + 1) / ((${str(ex)} + 1) * ${str(p)})`);
        }
        const n = constVal(ex);
        if (n !== undefined && Number.isInteger(n) && n > 1) {
          try { const e = math.rationalize(m) as MathNode; if (polyCoeffs(e, x)) return integrate(e, x, depth + 1); } catch { /* no polynomial */ }
        }
        throw fail();
      }
      if (!hasSym(base, x)) {
        const p = linearSlope(ex, x);
        if (p) return symName(base) === 'e' ? P(`e^${str(ex)} / ${str(p)}`) : P(`${str(base)}^${str(ex)} / (${str(p)} * log(${str(base)}))`);
      }
      throw fail();
    }
    throw fail();
  }
  if (m.type === 'FunctionNode') {
    const name = (node.fn as { name: string }).name, args = node.args as MathNode[];
    const u = args[0];
    const p = u && args.length === 1 ? linearSlope(u, x) : null;
    if (!p) throw fail();
    const U = str(u), Pp = str(p);
    const rules: Record<string, string> = {
      sin: `-cos(${U}) / ${Pp}`, cos: `sin(${U}) / ${Pp}`, exp: `exp(${U}) / ${Pp}`, tan: `-log(cos(${U})) / ${Pp}`,
      sinh: `cosh(${U}) / ${Pp}`, cosh: `sinh(${U}) / ${Pp}`, log: `(${U} * log(${U}) - ${U}) / ${Pp}`,
      sqrt: `2 / 3 * ${U}^(3 / 2) / ${Pp}`,
    };
    if (rules[name]) return P(rules[name]);
  }
  throw fail();
}

/* ---------------------------- sums and products ---------------------------- */

/** Bernoulli numbers B0 … B10 (B1 = +1/2) for Faulhaber's formula. */
const BERNOULLI = ['1', '1/2', '1/6', '0', '-1/30', '0', '1/42', '0', '-1/30', '0', '5/66'];
const binom = (n: number, k: number) => { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return Math.round(r); };
/** Σ_{i=1}^{n} i^k as mathjs text in n. */
function faulhaber(k: number, n: string): string {
  if (k === 0) return n;
  const terms: string[] = [];
  for (let j = 0; j <= k; j++) if (BERNOULLI[j] !== '0') terms.push(`${binom(k + 1, j)} * (${BERNOULLI[j]}) * ${n}^${k + 1 - j}`);
  return `(${terms.join(' + ')}) / ${k + 1}`;
}
const isInf = (m: MathNode) => { const v = constVal(m); return v !== undefined && !Number.isFinite(v); };

/** Closed form of Σ / Π over i = lo … hi. */
function closedIter(op: 'sum' | 'prod', f: MathNode, i: string, lo: MathNode, hi: MathNode): MathNode {
  const loV = constVal(lo), hiV = constVal(hi);
  // small numeric range: write the terms out
  if (loV !== undefined && hiV !== undefined && Number.isInteger(loV) && Number.isFinite(hiV) && Number.isInteger(hiV) && hiV - loV <= 200) {
    if (hiV < loV) return new math.ConstantNode(op === 'sum' ? 0 : 1);
    const parts: string[] = [];
    for (let k = loV; k <= hiV; k++) parts.push(str(subst(f, i, new math.ConstantNode(k))));
    return S(P(parts.join(op === 'sum' ? ' + ' : ' * ')));
  }
  if (op === 'prod') {
    if (!hasSym(f, i) && !isInf(hi)) return S(P(`${str(f)}^(${str(hi)} - ${str(lo)} + 1)`));
    if (symName(f) === i && constVal(lo) === 1 && !isInf(hi)) return S(P(`${str(hi)}!`));
    throw unsupported('Produkt mit symbolischen Grenzen');
  }
  if (!hasSym(f, i)) {
    if (isInf(hi)) throw new CalcError('Die Summe divergiert');
    return S(P(`${str(f)} * (${str(hi)} - ${str(lo)} + 1)`));
  }
  // polynomial in i: Faulhaber
  const cs = polyCoeffs(f, i);
  if (cs && cs.length <= BERNOULLI.length) {
    if (isInf(hi)) throw new CalcError('Die Summe divergiert');
    const loM1 = `(${str(lo)} - 1)`;
    return S(P(cs.map((c, k) => (isZero(c) ? '0' : `${str(c)} * ((${faulhaber(k, str(hi))}) - (${faulhaber(k, loM1)}))`)).join(' + ')));
  }
  // geometric: constant ratio f(i+1)/f(i)
  const r = S(P(`${str(subst(f, i, P(`${i} + 1`)))} / ${str(f)}`));
  if (!hasSym(r, i)) {
    const first = S(subst(f, i, lo));
    if (isInf(hi)) {
      const rv = constVal(r);
      if (rv === undefined || Math.abs(rv) >= 1) throw new CalcError('Die geometrische Reihe konvergiert nur für |q| < 1');
      return S(P(`${str(first)} / (1 - ${str(r)})`));
    }
    return S(P(`${str(first)} * (${str(r)}^(${str(hi)} - ${str(lo)} + 1) - 1) / (${str(r)} - 1)`));
  }
  throw unsupported('Summe (nur Polynome und geometrische Reihen in geschlossener Form)');
}

/* --------------------------------- limits ---------------------------------- */

/** Recognise e, π and fractions in a numerical limit. */
function niceNumber(v: number): MathNode {
  if (!Number.isFinite(v)) return P(v < 0 ? '-Infinity' : 'Infinity');
  for (const [c, t] of [[Math.E, 'e'], [Math.PI, 'pi']] as const) {
    const q = v / c, f = toFraction(q);
    if (f && f[1] <= 12 && Math.abs(f[0]) <= 100 && Math.abs(q - f[0] / f[1]) < 1e-8) return S(P(`${f[0]} / ${f[1]} * ${t}`));
  }
  const f = toFraction(v);
  return f && f[1] <= 1000 ? S(P(`${f[0]} / ${f[1]}`)) : new math.ConstantNode(v);
}

/** lim_{x→a} f: substitution, L'Hôpital for 0/0 and ∞/∞, otherwise numerically (only without other unknowns). */
function limitOf(f: MathNode, x: string, at: MathNode, side: -1 | 0 | 1, depth = 0): MathNode {
  if (depth > 8) throw new CalcError('lim: kein Ergebnis (zu viele Umformungen)');
  const av = constVal(at);
  const others = (() => { let o = false; f.traverse((n, path) => { const s = symName(n); if (s && path !== 'fn' && s !== x && !['pi', 'e', 'i', 'Infinity'].includes(s)) o = true; }); return o; })();
  const numeric = () => {
    if (others || av === undefined) throw new CalcError('lim: symbolisch nicht bestimmbar');
    const fn = (t: number) => { const v = f.evaluate({ [x]: t }); return typeof v === 'number' ? v : NaN; };
    return niceNumber(limitNumeric(fn, Number.isFinite(av) ? av : Math.sign(av) * 1e308, side));
  };
  if (av !== undefined && !Number.isFinite(av)) {
    if (!others) return numeric();
    // x → ±∞: x = ±1/t, t → 0+
    const t = x + 'q';
    return limitOf(S(subst(f, x, P(`${av < 0 ? '-' : ''}1 / ${t}`))), t, new math.ConstantNode(0), 1, depth + 1);
  }
  const node = f as MNode;
  if (f.type === 'OperatorNode' && node.fn === 'divide') {
    const [a, b] = node.args as MathNode[];
    const a0 = S(subst(a, x, at)), b0 = S(subst(b, x, at));
    const z = (m: MathNode) => isZero(m), inf = (m: MathNode) => isInf(m);
    if ((z(a0) && z(b0)) || (inf(a0) && inf(b0))) return limitOf(S(P(`${str(D(a, x))} / ${str(D(b, x))}`)), x, at, side, depth + 1);
    if (!z(b0) && !inf(b0) && !inf(a0)) { const r = S(P(`${str(a0)} / ${str(b0)}`)); if (!hasNaN(r)) return r; }
    return numeric();
  }
  const direct = S(subst(f, x, at));
  if (!hasNaN(direct) && (others || constVal(direct) === undefined || Number.isFinite(constVal(direct)!))) return direct;
  return numeric();
}
function hasNaN(m: MathNode) {
  let bad = false;
  m.traverse(n => { if (n.type === 'ConstantNode' && typeof (n as MNode).value === 'number' && !Number.isFinite((n as MNode).value as number)) bad = true; if (symName(n) === 'NaN' || symName(n) === 'Infinity') bad = true; });
  if (!bad && !hasAnySymbol(m)) { try { const v = m.evaluate(); if (typeof v === 'number' && !Number.isFinite(v)) bad = true; } catch { bad = true; } }
  return bad;
}

/* -------------------------- our tree → mathjs text -------------------------- */

/** Our syntax tree → mathjs text, with substitution of known values and inlining of user functions. */
function toMathText(n: Node, scope: Scope, env: Map<string, string>, names: Names, depth = 0): string {
  if (depth > 40) throw new CalcError('Symbolisch: zu tiefe Verschachtelung (Rekursion?)');
  const go = (x: Node, e = env) => toMathText(x, scope, e, names, depth + 1);
  switch (n.k) {
    case 'num': return `(${num(n.v)})`;
    case 'imag': return `(${num(n.v)} * i)`;
    case 'paren': return `(${go(n.a)})`;
    case 'id': {
      const bound = env.get(n.name);
      if (bound !== undefined) return bound;
      if (n.name === 'π') return 'pi';
      if (n.name === '∞') return 'Infinity';
      if (n.name === 'e' && scope.get('e') === undefined) return 'e';
      const v = scope.get(n.name);
      if (v !== undefined) { const t = valueText(v, names); if (t !== null) return t; }
      else if (lookupUnit(n.name) !== null) {
        const u = lookupUnit(n.name)!;
        if (typeof u === 'number') return `(${num(u)})`;
        return valueText(u, names) ?? names.sym(n.name);
      }
      return names.sym(n.name);
    }
    case 'bin': {
      const ops: Record<string, string> = { '+': '+', '-': '-', '*': '*', '/': '/', '^': '^' };
      if (!ops[n.op]) throw unsupported(`Operator ${n.op}`);
      return `(${go(n.a)}) ${ops[n.op]} (${go(n.b)})`;
    }
    case 'un':
      if (n.op === 'neg') return `-(${go(n.a)})`;
      if (n.op === 'sqrt') return `sqrt(${go(n.a)})`;
      if (n.op === 'abs') return `abs(${go(n.a)})`;
      if (n.op === 'fact') return `(${go(n.a)})!`;
      throw unsupported(n.op);
    case 'nroot': return `nthRoot(${go(n.a)}, ${go(n.n)})`;
    case 'deriv': {
      // d/dx: the variable stays symbolic inside the derivative
      const s = names.sym(n.v);
      let d: MathNode = P(go(n.body, new Map([...env, [n.v, s]])));
      for (let k = 0; k < (n.order ?? 1); k++) d = math.derivative(d, s);
      return str(d);
    }
    case 'int': {
      const s = names.sym(n.v);
      const F = S(integrate(S(P(go(n.body, new Map([...env, [n.v, s]])))), s));
      if (!n.lo || !n.hi) return str(F);
      return `(${str(subst(F, s, P(go(n.hi))))} - ${str(subst(F, s, P(go(n.lo))))})`;
    }
    case 'iter': {
      if (!n.v || !n.lo || !n.hi) throw unsupported('Summen/Produkte über Vektoren');
      const s = names.sym(n.v);
      const body = S(P(go(n.body, new Map([...env, [n.v, s]]))));
      return str(closedIter(n.op, body, s, S(P(go(n.lo))), S(P(go(n.hi)))));
    }
    case 'call': {
      if (n.name === 'lim' && !scope.get('lim')) {
        if (n.args.length < 3 || n.args[1].k !== 'id') throw new CalcError('lim(f(x), x, a) oder lim(f(x), x, a, "right") erwartet');
        const s = names.sym(n.args[1].name);
        const f = S(P(go(n.args[0], new Map([...env, [n.args[1].name, s]]))));
        return str(limitOf(f, s, S(P(go(n.args[2]))), limitSide(n.args[3])));
      }
      const f = env.has(n.name) ? undefined : scope.get(n.name);
      if (f && typeof f === 'object' && (f as FnVal).kind === 'fn' && (f as FnVal).body && (f as FnVal).body!.k !== 'program') {
        const fn = f as FnVal;
        if (fn.params.length !== n.args.length) throw new CalcError(`${n.name} erwartet ${fn.params.length} Argument(e)`);
        const local = new Map<string, string>();
        fn.params.forEach((p, i) => local.set(p, `(${go(n.args[i])})`));
        return `(${toMathText(fn.body!, fn.scope ?? scope, local, names, depth + 1)})`;
      }
      const m = TO_MATH[n.name];
      if (m && !f) {
        if (n.name === 'log' && n.args.length === 2) return `log(${go(n.args[0])}, ${go(n.args[1])})`;
        return `${m}(${n.args.map(a => go(a)).join(', ')})`;
      }
      throw unsupported(`${n.name}(…)`);
    }
    default:
      throw unsupported(n.k === 'matrix' ? 'Matrizen' : n.k);
  }
}

/* -------------------------- mathjs tree → our tree -------------------------- */

function fromMath(m: MathNode, names: Names): Node {
  const go = (x: MathNode) => fromMath(x, names);
  const node = m as MNode;
  switch (m.type) {
    case 'ConstantNode': {
      const v = node.value as number;
      if (typeof v !== 'number') throw unsupported('Konstante');
      if (!Number.isFinite(v)) return v < 0 ? { k: 'un', op: 'neg', a: { k: 'id', name: '∞' } } : { k: 'id', name: '∞' };
      return v < 0 ? { k: 'un', op: 'neg', a: { k: 'num', v: -v } } : { k: 'num', v };
    }
    case 'SymbolNode': {
      const s = node.name as string;
      if (s === 'pi') return { k: 'id', name: 'π' };
      if (s === 'Infinity') return { k: 'id', name: '∞' };
      if (s === 'i') return { k: 'imag', v: 1 };
      return { k: 'id', name: names.name(s) ?? s };
    }
    case 'ParenthesisNode': return { k: 'paren', a: go(node.content as MathNode) };
    case 'OperatorNode': {
      const args = node.args as MathNode[];
      const fn = node.fn as string;
      if (args.length === 1) {
        if (fn === 'unaryMinus') return { k: 'un', op: 'neg', a: go(args[0]) };
        if (fn === 'unaryPlus') return go(args[0]);
        if (fn === 'factorial') return { k: 'un', op: 'fact', a: go(args[0]) };
      }
      const ops: Record<string, '+' | '-' | '*' | '/' | '^'> = { add: '+', subtract: '-', multiply: '*', divide: '/', pow: '^' };
      const op = ops[fn];
      if (!op) throw unsupported(fn);
      return args.slice(1).reduce<Node>((acc, a) => ({ k: 'bin', op, a: acc, b: go(a) }), go(args[0]));
    }
    case 'FunctionNode': {
      const name = (node.fn as { name: string }).name;
      const args = (node.args as MathNode[]).map(go);
      if (name === 'sqrt') return { k: 'un', op: 'sqrt', a: args[0] };
      if (name === 'abs') return { k: 'un', op: 'abs', a: args[0] };
      if (name === 'nthRoot') return { k: 'nroot', n: args[1] ?? { k: 'num', v: 2 }, a: args[0] };
      if (name === 'log' && args.length === 2) return { k: 'call', name: 'log', args };
      // Mathcad shows e^x
      if (name === 'exp' && args.length === 1) return { k: 'bin', op: '^', a: { k: 'id', name: 'e' }, b: args[0] };
      return { k: 'call', name: FROM_MATH[name] ?? name, args };
    }
    default:
      throw unsupported(m.type);
  }
}

/** Round all numbers of a tree to n significant digits (→ float, n). */
const roundDigits = (m: MathNode, n: number) =>
  m.transform(x => (x.type === 'ConstantNode' && typeof (x as MNode).value === 'number'
    ? new math.ConstantNode(+((x as MNode).value as number).toPrecision(n)) : x));

/* --------------------------------- solving --------------------------------- */

/** Linear system  e_i(x) = 0  by Cramer's rule (symbolic coefficients allowed, up to 4 unknowns). */
function solveLinearSystem(eqs: MathNode[], xs: string[]): MathNode[] {
  const n = xs.length;
  if (eqs.length !== n) throw new CalcError(`solve: ${eqs.length} Gleichungen für ${n} Unbekannte`);
  if (n > 4) throw new CalcError('solve: symbolisch höchstens 4 Unbekannte');
  const A: string[][] = [], b: string[] = [];
  for (const e of eqs) {
    const row = xs.map(x => D(e, x));
    for (const c of row) for (const x of xs) if (hasSym(c, x)) throw new CalcError('solve: Gleichungssysteme symbolisch nur linear – numerisch mit Given/Find');
    let at0: MathNode = e;
    for (const x of xs) at0 = subst(at0, x, new math.ConstantNode(0));
    A.push(row.map(str)); b.push(`-${str(S(at0))}`);
  }
  const det = (M: string[][]): string => {
    if (M.length === 1) return M[0][0];
    return M[0].map((c, j) => `${j % 2 ? '-' : '+'}${c} * (${det(M.slice(1).map(r => r.filter((_, k) => k !== j)))})`).join(' ');
  };
  const dA = S(P(det(A)));
  if (isZero(dA)) throw new CalcError('solve: das Gleichungssystem ist nicht eindeutig lösbar');
  return xs.map((_, j) => S(P(`(${det(A.map((r, i) => r.map((c, k) => (k === j ? b[i] : c))))}) / ${str(dA)}`)));
}

/** Single equation: linear or quadratic in x. */
function solveOne(e: MathNode, x: string, names: Names): Node {
  const d1 = D(e, x);
  if (isZero(d1)) throw new CalcError(`Die Gleichung hängt nicht von ${names.name(x)} ab`);
  const d2 = D(d1, x);
  const at0 = (t: MathNode) => S(subst(t, x, new math.ConstantNode(0)));
  if (isZero(d2)) return fromMath(S(P(`-${str(at0(e))} / ${str(d1)}`)), names);
  if (isZero(D(d2, x))) {
    const a = `(${str(d2)} / 2)`, b = str(at0(d1)), c = str(at0(e));
    const r = (sgn: string) => fromMath(S(P(`(-${b} ${sgn} sqrt(${b}^2 - 4 * ${a} * ${c})) / (2 * ${a})`)), names);
    return { k: 'matrix', rows: [[r('-')], [r('+')]] };
  }
  throw new CalcError('solve: symbolisch nur lineare und quadratische Gleichungen (und lineare Systeme) – numerisch mit Given/Find oder root()');
}

/* ---------------------------------- factor --------------------------------- */

/** Rational approximation p/q of a number (q ≤ 10000) or null. */
function toFraction(v: number): [number, number] | null {
  for (let q = 1; q <= 10000; q++) { const p = Math.round(v * q); if (Math.abs(p / q - v) < 1e-9 * Math.max(1, Math.abs(v))) return [p, q]; }
  return null;
}
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));

/** Factor a polynomial in one variable with rational coefficients: lead · Π (x − r)^m · rest. */
function factorPoly(m: MathNode, names: Names): Node {
  const syms = new Set<string>();
  m.traverse(n => { const s = symName(n); if (s && names.name(s)) syms.add(s); });
  if (syms.size !== 1) throw new CalcError('factor: nur Polynome in einer Variablen');
  const x = [...syms][0];
  const cs = polyCoeffs(m, x);
  const vals = cs?.map(constVal);
  if (!cs || !vals || vals.some(v => v === undefined)) throw new CalcError('factor: nur Polynome mit Zahlenkoeffizienten');
  const lead = (vals as number[])[vals.length - 1];
  const { roots, rest: c } = rationalRoots(vals as number[]);
  if (!roots.length) throw new CalcError('factor: keine rationalen Nullstellen – das Polynom ist über den rationalen Zahlen nicht zerlegbar');
  const X: Node = { k: 'id', name: names.name(x)! };
  const counts = new Map<number, number>();
  for (const r of roots) counts.set(r, (counts.get(r) ?? 0) + 1);
  const factors: Node[] = [];
  let scale = lead;
  // order as in Mathcad: x first, then (x + 1), (2·x + 1) …
  for (const [r, k] of [...counts].sort((a, b) => (a[0] === 0 ? -1 : b[0] === 0 ? 1 : a[0] - b[0]))) {
    const fr = toFraction(Math.abs(r));
    let base: Node;
    if (fr && fr[1] > 1) {
      // root p/q → (q·x ∓ p); the leading factor shrinks by q per power
      base = { k: 'paren', a: { k: 'bin', op: r < 0 ? '+' : '-', a: { k: 'bin', op: '*', a: { k: 'num', v: fr[1] }, b: X }, b: { k: 'num', v: fr[0] } } };
      scale /= fr[1] ** k;
    } else base = linFactor(X, r);
    factors.push(k === 1 ? base : { k: 'bin', op: '^', a: base, b: { k: 'num', v: k } });
  }
  if (c.length > 1) {
    // remaining factor without rational roots (normalised by the leading coefficient)
    const restTxt = c.map((a, i) => `(${a / lead}) * ${x}^${i}`).join(' + ');
    factors.push({ k: 'paren', a: fromMath(S(P(restTxt)), names) });
  }
  let prod = factors.reduce((acc, f) => ({ k: 'bin', op: '*', a: acc, b: f }) as Node);
  const fs = toFraction(Math.abs(scale));
  if (!fs) return { k: 'bin', op: '*', a: numNode(scale), b: prod };
  if (fs[0] !== 1) prod = { k: 'bin', op: '*', a: { k: 'num', v: fs[0] }, b: prod };
  if (fs[1] !== 1) prod = { k: 'bin', op: '/', a: prod, b: { k: 'num', v: fs[1] } };
  return scale < 0 ? { k: 'un', op: 'neg', a: prod } : prod;
}

/** Number as exact fraction node (−3/4 …). */
function numNode(v: number): Node {
  const f = toFraction(Math.abs(v)) ?? [Math.abs(v), 1];
  const a: Node = f[1] === 1 ? { k: 'num', v: f[0] } : { k: 'bin', op: '/', a: { k: 'num', v: f[0] }, b: { k: 'num', v: f[1] } };
  return v < 0 ? { k: 'un', op: 'neg', a } : a;
}
/** (x − r), or x for r = 0. */
function linFactor(X: Node, r: number): Node {
  return r === 0 ? X : { k: 'paren', a: { k: 'bin', op: r < 0 ? '+' : '-', a: X, b: numNode(Math.abs(r)) } };
}

/** Rational roots (with multiplicity) of a polynomial c0 + c1·x + …; rest = remaining coefficients. */
function rationalRoots(c0: number[]): { roots: number[]; rest: number[] } {
  let c = c0.slice();
  const roots: number[] = [];
  // rational root theorem on the integer-scaled polynomial; repeated roots allowed
  const scaleInt = (q: number[]) => {
    const fr = q.map(toFraction);
    if (fr.some(f => !f)) return null;
    const l = fr.reduce((acc, f) => acc * f![1] / gcd(acc, f![1]), 1);
    return fr.map(f => f![0] * (l / f![1]));
  };
  const divisors = (k: number) => { const out: number[] = []; k = Math.abs(Math.round(k)); for (let d = 1; d <= Math.min(k, 100000); d++) if (k % d === 0) out.push(d); return out; };
  const evalP = (q: number[], v: number) => q.reduceRight((acc, a) => acc * v + a, 0);
  for (let guard = 0; guard < 30 && c.length > 1; guard++) {
    if (Math.abs(c[0]) < 1e-12) { roots.push(0); c = c.slice(1); continue; }
    const ints = scaleInt(c);
    if (!ints) break;
    const ps = divisors(ints[0]), qs = divisors(ints[ints.length - 1]);
    let found: number | undefined;
    for (const p of ps) { for (const q of qs) for (const sg of [1, -1]) { const r = sg * p / q; if (Math.abs(evalP(ints, r)) < 1e-7 * Math.max(...ints.map(Math.abs))) { found = r; break; } } if (found !== undefined) break; }
    if (found === undefined) break;
    roots.push(found);
    // synthetic division by (x − r)
    const nc: number[] = new Array(c.length - 1).fill(0);
    let carry = 0;
    for (let i = c.length - 1; i >= 1; i--) { carry = c[i] + carry * found; nc[i - 1] = carry; }
    c = nc;
  }
  return { roots, rest: c };
}

/* ------------------------------ partial fractions ------------------------------ */

function partialFractions(m: MathNode, xArg: Node | undefined, names: Names): Node {
  let x: string;
  if (xArg) { if (xArg.k !== 'id') throw new CalcError('parfrac, x'); x = names.sym(xArg.name); }
  else {
    const syms = new Set<string>();
    m.traverse((n, path) => { const s = symName(n); if (s && path !== 'fn' && names.name(s)) syms.add(s); });
    if (syms.size !== 1) throw new CalcError('parfrac braucht die Variable:  → parfrac, x');
    x = [...syms][0];
  }
  let nd: { numerator: MathNode; denominator: MathNode };
  try { nd = math.rationalize(m, {}, true) as unknown as { numerator: MathNode; denominator: MathNode }; } catch { throw new CalcError('parfrac: nur gebrochen rationale Funktionen'); }
  const coeffs = (p: MathNode | null) => { const cs = p ? polyCoeffs(p, x) : [new math.ConstantNode(1)]; const v = cs?.map(constVal); if (!v || v.some(q => q === undefined)) throw new CalcError('parfrac: nur Zahlenkoeffizienten'); return v as number[]; };
  let num = coeffs(nd.numerator);
  const den = coeffs(nd.denominator ?? null);
  if (den.length < 2) throw new CalcError('parfrac: der Nenner hängt nicht von der Variablen ab');
  // polynomial part by long division
  const quot: number[] = new Array(Math.max(0, num.length - den.length + 1)).fill(0);
  num = num.slice();
  for (let k = num.length - den.length; k >= 0; k--) {
    const q = num[k + den.length - 1] / den[den.length - 1];
    quot[k] = q;
    for (let j = 0; j < den.length; j++) num[k + j] -= q * den[j];
  }
  const rem = num.slice(0, den.length - 1);
  const { roots, rest } = rationalRoots(den);
  const restMonic = rest.map(c => c / rest[rest.length - 1]);
  const evalP = (q: number[], v: number) => q.reduceRight((acc, a) => acc * v + a, 0);
  // unknowns: A/(x − r)^j for every root multiplicity, and (B0 + B1·x + …)/rest
  const counts = new Map<number, number>();
  for (const r of roots) counts.set(r, (counts.get(r) ?? 0) + 1);
  const basis: { f: (v: number) => number; node: (c: number) => Node | null }[] = [];
  const X: Node = { k: 'id', name: names.name(x)! };
  const restNode: Node | null = restMonic.length > 1 ? fromMath(S(P(restMonic.map((c, i) => `(${c}) * ${x}^${i}`).join(' + '))), names) : null;
  for (const [r, mult] of [...counts].sort((a, b) => a[0] - b[0])) {
    for (let j = 1; j <= mult; j++) {
      basis.push({
        f: v => 1 / (v - r) ** j,
        node: c => {
          const f = toFraction(Math.abs(c)) ?? [Math.abs(c), 1];
          const pow: Node = j === 1 ? linFactor(X, r) : { k: 'bin', op: '^', a: linFactor(X, r), b: { k: 'num', v: j } };
          const t: Node = { k: 'bin', op: '/', a: { k: 'num', v: f[0] }, b: f[1] === 1 ? pow : { k: 'bin', op: '*', a: { k: 'num', v: f[1] }, b: pow } };
          return c < 0 ? { k: 'un', op: 'neg', a: t } : t;
        },
      });
    }
  }
  const restCoef: number[] = [];
  for (let k = 0; k < restMonic.length - 1; k++) basis.push({ f: v => v ** k / evalP(restMonic, v), node: () => null });
  // fit at sample points (exact for the right basis)
  const n = basis.length;
  const pts = Array.from({ length: n }, (_, i) => 0.37 + 1.13 * i + 0.071 * i * i).map(v => (roots.some(r => Math.abs(v - r) < 1e-3) ? v + 0.5 : v));
  const A = pts.map(v => basis.map(b => b.f(v)));
  const rhs = pts.map(v => evalP(rem, v) / evalP(den, v));
  const sol = gaussSolve(A, rhs).map(c => { const f = toFraction(c); return f ? f[0] / f[1] : c; });
  const terms: Node[] = [];
  if (quot.some(c => Math.abs(c) > 1e-12)) terms.push(fromMath(S(P(quot.map((c, i) => `(${c}) * ${x}^${i}`).join(' + '))), names));
  sol.forEach((c, i) => { if (i < basis.length - (restMonic.length - 1)) { if (Math.abs(c) > 1e-12) terms.push(basis[i].node(c)!); } else restCoef.push(c); });
  if (restNode && restCoef.some(c => Math.abs(c) > 1e-12)) {
    const numer = fromMath(S(P(restCoef.map((c, i) => `(${toFraction(c) ? toFraction(c)!.join('/') : c}) * ${x}^${i}`).join(' + '))), names);
    terms.push({ k: 'bin', op: '/', a: numer, b: restNode });
  }
  if (!terms.length) return { k: 'num', v: 0 };
  return terms.reduce((acc, t) => {
    if (t.k === 'un' && t.op === 'neg') return { k: 'bin', op: '-', a: acc, b: t.a };
    if (t.k === 'bin' && t.op === '/' && t.a.k === 'un' && t.a.op === 'neg') return { k: 'bin', op: '-', a: acc, b: { ...t, a: t.a.a } };
    return { k: 'bin', op: '+', a: acc, b: t };
  });
}

/** Small dense linear solve (partial pivoting). */
function gaussSolve(A: number[][], b: number[]): number[] {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-14) throw new CalcError('parfrac: Zerlegung nicht bestimmbar');
    for (let r = 0; r < n; r++) if (r !== c) { const q = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= q * M[c][k]; }
  }
  return M.map((r, i) => r[n] / M[i][i]);
}

/* ---------------------------------- main ----------------------------------- */

/** Symbolic result of an expression (or equation  lhs == rhs, or a vector of them for solve). */
export function symbolicEval(expr: Node, kw: SymKeyword | undefined, scope: Scope): Node {
  const names = new Names();
  const name = kw?.name ?? 'simplify';
  if (!SYM_KEYWORDS.includes(name)) throw new CalcError(`Unbekanntes Schlüsselwort „${name}“ (${SYM_KEYWORDS.join(', ')})`);
  const args = kw?.args ?? [];

  // substitute, x = a + 1, y = 2  (also as a prefix for the other keywords' arguments)
  const env = new Map<string, string>();
  if (name === 'substitute') {
    if (!args.length) throw new CalcError('substitute braucht z. B.  → substitute, x = a + 1');
    for (const a of args) {
      if (a.k !== 'bin' || a.op !== '==' || a.a.k !== 'id') throw new CalcError('substitute: Form  x = Ausdruck');
      env.set(a.a.name, `(${toMathText(a.b, scope, new Map(), names)})`);
    }
  }
  const text = (n: Node) => (n.k === 'bin' && n.op === '=='
    ? `(${toMathText(n.a, scope, env, names)}) - (${toMathText(n.b, scope, env, names)})`
    : toMathText(n, scope, env, names));
  const parse = (n: Node) => { const t = text(n); try { return P(t); } catch { throw unsupported('Ausdruck'); } };
  const varSym = (a: Node | undefined, what: string) => {
    if (!a || a.k !== 'id') throw new CalcError(`${what} braucht die Variable, z. B.  → ${what}, x`);
    return names.sym(a.name);
  };

  if (name === 'solve') {
    const vars = args.flatMap(a => (a.k === 'matrix' ? a.rows.flat() : [a]));
    if (!vars.length) throw new CalcError('solve braucht die Unbekannte:  → solve, x');
    const xs = vars.map(v => varSym(v, 'solve'));
    const eqs = expr.k === 'matrix' ? expr.rows.flat() : [expr];
    if (eqs.length === 1 && xs.length === 1) return solveOne(parse(eqs[0]), xs[0], names);
    const sol = solveLinearSystem(eqs.map(parse), xs);
    return { k: 'matrix', rows: [sol.map(s => fromMath(s, names))] };
  }

  // vectors and matrices: element by element
  if (expr.k === 'matrix') return { k: 'matrix', rows: expr.rows.map(r => r.map(c => symbolicEval(c, kw, scope))) };

  const m = parse(expr);
  switch (name) {
    case 'factor': return factorPoly(S(m), names);
    case 'parfrac': return partialFractions(m, args[0], names);
    case 'coeffs': {
      const x = varSym(args[0], 'coeffs');
      const cs = polyCoeffs(m, x);
      if (!cs) throw new CalcError('coeffs: der Ausdruck ist kein Polynom in dieser Variablen');
      return { k: 'matrix', rows: cs.map(c => [fromMath(S(c), names)]) };
    }
    case 'series': {
      // series, x = a, n   or   series, x, n   (n terms, default 6)
      let at: MathNode = new math.ConstantNode(0), x: string, nTerms = 6;
      const a0 = args[0];
      if (a0?.k === 'bin' && a0.op === '==' && a0.a.k === 'id') { x = names.sym(a0.a.name); at = P(text(a0.b)); }
      else x = varSym(a0, 'series');
      if (args[1]) { if (args[1].k !== 'num') throw new CalcError('series: Anzahl der Glieder als Zahl'); nTerms = Math.max(1, Math.min(20, Math.round(args[1].v))); }
      // terms in ascending order (each simplified on its own, so the order stays as in Mathcad)
      const terms: Node[] = [];
      let d: MathNode = m;
      for (let k = 0; k < nTerms; k++) {
        const c = S(P(`${str(subst(d, x, at))} / ${fact(k)}`));
        if (!isZero(c)) terms.push(fromMath(S(P(k === 0 ? str(c) : `${str(c)} * (${x} - ${str(at)})^${k}`)), names));
        d = D(d, x);
      }
      if (!terms.length) return { k: 'num', v: 0 };
      return terms.reduce((acc, t) => {
    if (t.k === 'un' && t.op === 'neg') return { k: 'bin', op: '-', a: acc, b: t.a };
    if (t.k === 'bin' && t.op === '/' && t.a.k === 'un' && t.a.op === 'neg') return { k: 'bin', op: '-', a: acc, b: { ...t, a: t.a.a } };
    return { k: 'bin', op: '+', a: acc, b: t };
  });
    }
    case 'expand': {
      let out: MathNode;
      try { out = math.rationalize(m) as MathNode; } catch { out = S(m); }
      return fromMath(out, names);
    }
    case 'float': {
      const digits = args[0]?.k === 'num' ? Math.max(1, Math.min(15, Math.round(args[0].v))) : 15;
      const out = S(m);
      let free = false;
      out.traverse(x => { const s = symName(x); if (s && names.name(s) !== undefined) free = true; });
      if (!free) {
        const val = out.evaluate();
        if (typeof val === 'number') return val < 0 ? { k: 'un', op: 'neg', a: { k: 'num', v: +(-val).toPrecision(digits) } } : { k: 'num', v: +val.toPrecision(digits) };
      }
      return fromMath(roundDigits(out, digits), names);
    }
    default:
      // closed-form sums: factored like Mathcad, n·(n + 1)/2
      if (expr.k === 'iter') { try { return factorPoly(S(m), names); } catch { /* not factorable */ } }
      return fromMath(S(m), names);
  }
}
