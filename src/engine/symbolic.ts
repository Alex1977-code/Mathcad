/**
 * Symbolic evaluation "→" (Mathcad's live symbolics, a practical subset): defined numbers, quantities and
 * functions are substituted, unknown names stay symbolic, then the expression is simplified with mathjs.
 * Keywords after the arrow:  → simplify  (default) · → expand · → float, n · → solve, x.
 * Derivatives (d/dx, deriv) are formed symbolically.
 */
import type { MathNode } from 'mathjs';
import type { Node } from './ast';
import { math, lookupUnit } from './units';
import { CalcError, isUnit, type FnVal, type Scope, type Val } from './values';
import { siUnitFactors } from './format';
import type { Unit } from 'mathjs';

export interface SymKeyword { name: string; args: Node[] }
export const SYM_KEYWORDS = ['simplify', 'expand', 'float', 'solve'];

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
      const inner = go(n.body, new Map([...env, [n.v, s]]));
      let d: MathNode = math.parse(inner);
      for (let k = 0; k < (n.order ?? 1); k++) d = math.derivative(d, s);
      return `(${d.toString()})`;
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
      throw unsupported(n.k === 'matrix' ? 'Matrizen' : n.k === 'int' ? 'Integrale' : n.k === 'iter' ? 'Summen/Produkte' : n.k);
  }
}

/** mathjs tree → our syntax tree (for the LaTeX display). */
function fromMath(m: MathNode, names: Names): Node {
  const go = (x: MathNode) => fromMath(x, names);
  const node = m as MathNode & Record<string, unknown>;
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
      // n-ary add / multiply
      return args.slice(1).reduce<Node>((acc, a) => ({ k: 'bin', op, a: acc, b: go(a) }), go(args[0]));
    }
    case 'FunctionNode': {
      const name = (node.fn as { name: string }).name;
      const args = (node.args as MathNode[]).map(go);
      if (name === 'sqrt') return { k: 'un', op: 'sqrt', a: args[0] };
      if (name === 'abs') return { k: 'un', op: 'abs', a: args[0] };
      if (name === 'nthRoot') return { k: 'nroot', n: args[1] ?? { k: 'num', v: 2 }, a: args[0] };
      if (name === 'log' && args.length === 2) return { k: 'call', name: 'log', args };
      return { k: 'call', name: FROM_MATH[name] ?? name, args };
    }
    default:
      throw unsupported(m.type);
  }
}

const isZero = (m: MathNode) => { const s = math.simplify(m); return s.type === 'ConstantNode' && (s as unknown as { value: number }).value === 0; };
const subst = (m: MathNode, sym: string, by: MathNode) =>
  m.transform(x => (x.type === 'SymbolNode' && (x as unknown as { name: string }).name === sym ? by : x));

/** Round all numbers of a tree to n significant digits (→ float, n). */
const roundDigits = (m: MathNode, n: number) =>
  m.transform(x => (x.type === 'ConstantNode' && typeof (x as unknown as { value: unknown }).value === 'number'
    ? new math.ConstantNode(+(x as unknown as { value: number }).value.toPrecision(n)) : x));

/** Symbolic result of an expression (or equation  lhs == rhs  for solve). */
export function symbolicEval(expr: Node, kw: SymKeyword | undefined, scope: Scope): Node {
  const names = new Names();
  const name = kw?.name ?? 'simplify';
  if (!SYM_KEYWORDS.includes(name)) throw new CalcError(`Unbekanntes Schlüsselwort „${name}“ (simplify, expand, float, solve)`);
  let text: string;
  if (expr.k === 'bin' && expr.op === '==') text = `(${toMathText(expr.a, scope, new Map(), names)}) - (${toMathText(expr.b, scope, new Map(), names)})`;
  else text = toMathText(expr, scope, new Map(), names);
  let m: MathNode;
  try { m = math.parse(text); } catch { throw unsupported('Ausdruck'); }

  if (name === 'solve') {
    const v = kw!.args[0];
    if (!v || v.k !== 'id') throw new CalcError('solve braucht die Unbekannte:  → solve, x');
    const x = names.sym(v.name);
    const d1 = math.simplify(math.derivative(m, x));
    if (isZero(d1)) throw new CalcError(`Die Gleichung hängt nicht von ${v.name} ab`);
    const d2 = math.simplify(math.derivative(d1, x));
    const at0 = (t: MathNode) => math.simplify(subst(t, x, new math.ConstantNode(0)));
    if (isZero(d2)) return fromMath(math.simplify(math.parse(`-(${at0(m).toString()}) / (${d1.toString()})`)), names);
    if (isZero(math.derivative(d2, x))) {
      const a = `(${d2.toString()}) / 2`, b = `(${at0(d1).toString()})`, c = `(${at0(m).toString()})`;
      const r = (sgn: string) => fromMath(math.simplify(math.parse(`(-${b} ${sgn} sqrt(${b}^2 - 4 * ${a} * ${c})) / (2 * ${a})`)), names);
      return { k: 'matrix', rows: [[r('-')], [r('+')]] };
    }
    throw new CalcError('solve: symbolisch nur lineare und quadratische Gleichungen – numerisch mit Given/Find oder root()');
  }

  let out: MathNode;
  if (name === 'expand') {
    try { out = math.rationalize(m) as MathNode; } catch { out = math.simplify(m); }
  } else out = math.simplify(m);
  if (name === 'float') {
    const digits = kw!.args[0]?.k === 'num' ? Math.max(1, Math.min(15, Math.round(kw!.args[0].v))) : 20;
    // fully numeric: evaluate, otherwise round the constants
    let free = false;
    out.traverse(x => { if (x.type === 'SymbolNode' && names.name((x as unknown as { name: string }).name) !== undefined) free = true; });
    if (!free) {
      const val = out.evaluate();
      if (typeof val === 'number') return val < 0 ? { k: 'un', op: 'neg', a: { k: 'num', v: +(-val).toPrecision(Math.min(digits, 15)) } } : { k: 'num', v: +val.toPrecision(Math.min(digits, 15)) };
    }
    out = roundDigits(out, Math.min(digits, 15));
  }
  return fromMath(out, names);
}
