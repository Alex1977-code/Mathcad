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

export interface SymKeyword { name: string; args: Node[] }
export const SYM_KEYWORDS = ['simplify', 'expand', 'float', 'solve', 'substitute', 'factor', 'coeffs', 'series'];

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
    case 'call': {
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
      throw unsupported(n.k === 'matrix' ? 'Matrizen' : n.k === 'iter' ? 'Summen/Produkte' : n.k);
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
      return v < 0 ? { k: 'un', op: 'neg', a: { k: 'num', v: -v } } : { k: 'num', v };
    }
    case 'SymbolNode': {
      const s = node.name as string;
      if (s === 'pi') return { k: 'id', name: 'π' };
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
  let c = vals as number[];
  const lead = c[c.length - 1];
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
  if (!roots.length) throw new CalcError('factor: keine rationalen Nullstellen – das Polynom ist über den rationalen Zahlen nicht zerlegbar');
  const X: Node = { k: 'id', name: names.name(x)! };
  const numNode = (v: number): Node => {
    const f = toFraction(Math.abs(v))!;
    const a: Node = f[1] === 1 ? { k: 'num', v: f[0] } : { k: 'bin', op: '/', a: { k: 'num', v: f[0] }, b: { k: 'num', v: f[1] } };
    return v < 0 ? { k: 'un', op: 'neg', a } : a;
  };
  const counts = new Map<number, number>();
  for (const r of roots) counts.set(r, (counts.get(r) ?? 0) + 1);
  const factors: Node[] = [];
  for (const [r, k] of [...counts].sort((a, b) => a[0] - b[0])) {
    const base: Node = r === 0 ? X : { k: 'paren', a: { k: 'bin', op: r < 0 ? '+' : '-', a: X, b: numNode(Math.abs(r)) } };
    factors.push(k === 1 ? base : { k: 'bin', op: '^', a: base, b: { k: 'num', v: k } });
  }
  if (c.length > 1) {
    // remaining factor without rational roots (normalised by the leading coefficient)
    const restTxt = c.map((a, i) => `(${a / lead}) * ${x}^${i}`).join(' + ');
    factors.push({ k: 'paren', a: fromMath(S(P(restTxt)), names) });
  }
  const prod = factors.reduce((acc, f) => ({ k: 'bin', op: '*', a: acc, b: f }) as Node);
  return Math.abs(lead - 1) < 1e-12 ? prod : { k: 'bin', op: '*', a: numNode(lead), b: prod };
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
      return terms.reduce((acc, t) => (t.k === 'un' && t.op === 'neg' ? { k: 'bin', op: '-', a: acc, b: t.a } : { k: 'bin', op: '+', a: acc, b: t }));
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
      return fromMath(S(m), names);
  }
}
