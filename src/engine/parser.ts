import type { Node, Stmt, MathStmt, DefTarget, BinOp } from './ast';

/* ------------------------------------------------------------------ */
/* Lexer                                                               */
/* ------------------------------------------------------------------ */

export type TokType = 'num' | 'imag' | 'id' | 'str' | 'op' | 'eof';
export interface Token { t: TokType; v: string; pos: number; end: number; spaceBefore: boolean }

export class ParseError extends Error {
  constructor(msg: string, public pos: number, public end: number = pos + 1) { super(msg); }
}

const OPS = [
  ':==', '::=', ':=', '≔', '≡', '←', '<-', '..', '…', '==', '!=', '<=', '>=', '≠', '≤', '≥', '→',
  '+', '-', '−', '*', '·', '×', '/', '÷', '^', '(', ')', '[', ']', '{', '}', ',', ';', '|', '!', '%',
  '<', '>', '=', '√', '∛', '∜', 'ᵀ', '¬', '∧', '∨', '⊕', '∈', '?', '\'', '∑', '∏', '∫',
];

const ID_START = /[\p{L}_°∞ℏ‰]/u;
const ID_CHAR = /[\p{L}\p{N}_°'∞ℏ‰]/u;

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let space = false;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ' ') { i++; space = true; continue; }
    const start = i;
    // numbers
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      while (i < src.length && /[0-9]/.test(src[i])) i++;
      if (src[i] === '.' && src[i + 1] !== '.') { i++; while (i < src.length && /[0-9]/.test(src[i])) i++; }
      if ((src[i] === 'e' || src[i] === 'E') && /[0-9]/.test(src[i + 1] === '+' || src[i + 1] === '-' ? (src[i + 2] ?? '') : (src[i + 1] ?? ''))) {
        i++; if (src[i] === '+' || src[i] === '-') i++;
        while (i < src.length && /[0-9]/.test(src[i])) i++;
      }
      const raw = src.slice(start, i);
      // imaginary literal: 2i / 2j (must not continue as identifier, e.g. "2in")
      if ((src[i] === 'i' || src[i] === 'j') && !ID_CHAR.test(src[i + 1] ?? ' ')) {
        i++;
        out.push({ t: 'imag', v: raw, pos: start, end: i, spaceBefore: space });
      } else {
        out.push({ t: 'num', v: raw, pos: start, end: i, spaceBefore: space });
      }
      space = false;
      continue;
    }
    if (ID_START.test(c)) {
      i++;
      while (i < src.length) {
        const ch = src[i];
        if (ID_CHAR.test(ch)) { i++; continue; }
        // dots are allowed inside literal subscripts (σ_c.d) but not ".."
        if (ch === '.' && src[i + 1] !== '.' && ID_CHAR.test(src[i + 1] ?? ' ') && src.slice(start, i).includes('_')) { i++; continue; }
        break;
      }
      out.push({ t: 'id', v: src.slice(start, i), pos: start, end: i, spaceBefore: space });
      space = false;
      continue;
    }
    // explicit unit reference:  'm  (used when a variable with the same name exists)
    if (c === "'" && ID_START.test(src[i + 1] ?? ' ')) {
      i++;
      while (i < src.length && ID_CHAR.test(src[i])) i++;
      out.push({ t: 'id', v: src.slice(start, i), pos: start, end: i, spaceBefore: space });
      space = false;
      continue;
    }
    if (c === '"') {
      i++;
      let s = '';
      while (i < src.length && src[i] !== '"') {
        // escapes: \"  \\  \n  \t (other backslashes stay as they are, e.g. in file paths)
        if (src[i] === '\\' && i + 1 < src.length && '"\\nt'.includes(src[i + 1])) {
          const e = src[i + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
          continue;
        }
        s += src[i]; i++;
      }
      if (src[i] !== '"') throw new ParseError('Zeichenkette nicht abgeschlossen', start, i);
      i++;
      out.push({ t: 'str', v: s, pos: start, end: i, spaceBefore: space });
      space = false;
      continue;
    }
    let op = OPS.find(o => src.startsWith(o, i));
    if (!op) throw new ParseError(`Unerwartetes Zeichen „${c}“`, i);
    // "x<-1" is a comparison; the arrow needs a following blank:  a <- 5
    if (op === '<-' && !/\s/.test(src[i + 2] ?? '')) op = '<';
    // "5!=" / "A<<1>>=" at the end: factorial / column operator followed by the evaluation sign
    if ((op === '!=' || op === '>=') && src.slice(i + 2).trim() === '') op = op[0];
    i += op.length;
    let v = op;
    if (v === '−') v = '-';
    if (v === '≔') v = ':=';
    if (v === '…') v = '..';
    if (v === '÷') v = '/';
    if (v === '≠') v = '!=';
    if (v === '≤') v = '<=';
    if (v === '≥') v = '>=';
    if (v === ':==' || v === '::=') v = '≡';
    if (v === '<-') v = '←';
    out.push({ t: 'op', v, pos: start, end: i, spaceBefore: space });
    space = false;
  }
  out.push({ t: 'eof', v: '', pos: src.length, end: src.length, spaceBefore: space });
  return out;
}

/* ------------------------------------------------------------------ */
/* Expression parser (Pratt style, recursive descent)                  */
/* ------------------------------------------------------------------ */

/** Names that are parsed as special operators when called like functions. */
const ITER_FUNCS: Record<string, 'sum' | 'prod'> = { __proto__: null as never, sum: 'sum', Σ: 'sum', '∑': 'sum', prod: 'prod', Π: 'prod', '∏': 'prod' };

class Parser {
  i = 0;
  constructor(public toks: Token[], public src: string) {}

  peek(o = 0) { return this.toks[Math.min(this.i + o, this.toks.length - 1)]; }
  next() { return this.toks[this.i++]; }
  isOp(v: string, o = 0) { const t = this.peek(o); return t.t === 'op' && t.v === v; }
  eat(v: string) { if (this.isOp(v)) { this.i++; return true; } return false; }
  expect(v: string) {
    const t = this.peek();
    if (!this.eat(v)) throw new ParseError(`„${v}“ erwartet${t.t === 'eof' ? ' (Ende erreicht)' : ` statt „${t.v}“`}`, t.pos, t.end);
  }
  atEnd() { return this.peek().t === 'eof'; }

  /** Top level: allows stepped ranges "a, b .. c" when allowRange. */
  parseTop(allowRange: boolean): Node {
    const first = this.parseOr();
    if (allowRange) {
      if (this.isOp(',') && this.containsRangeAhead()) {
        this.next();
        const second = this.parseOr();
        this.expect('..');
        const end = this.parseOr();
        return { k: 'range', start: first, second, end };
      }
      if (this.isOp('..')) {
        this.next();
        const end = this.parseOr();
        return { k: 'range', start: first, end };
      }
    }
    return first;
  }

  containsRangeAhead() {
    let depth = 0;
    for (let j = this.i; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (t.t !== 'op') continue;
      if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
      else if (t.v === ')' || t.v === ']' || t.v === '}') { if (depth === 0) return false; depth--; }
      else if (t.v === '..' && depth === 0) return true;
    }
    return false;
  }

  parseOr(): Node {
    let a = this.parseAnd();
    for (;;) {
      if (this.eat('∨') || this.eatWord('or')) a = { k: 'bin', op: 'or', a, b: this.parseAnd() };
      else if (this.eat('⊕') || this.eatWord('xor')) a = { k: 'bin', op: 'xor', a, b: this.parseAnd() };
      else return a;
    }
  }
  parseAnd(): Node {
    let a = this.parseNot();
    while (this.eat('∧') || this.eatWord('and')) a = { k: 'bin', op: 'and', a, b: this.parseNot() };
    return a;
  }
  parseNot(): Node {
    if (this.eat('¬') || this.eatWord('not')) return { k: 'un', op: 'not', a: this.parseNot() };
    return this.parseCmp();
  }
  eatWord(w: string) {
    const t = this.peek();
    // word operators only when followed by something that can start an operand
    if (t.t === 'id' && t.v === w && this.peek(1).t !== 'eof' && !(this.peek(1).t === 'op' && [')', ']', ',', ';', '=', ':=', '('].includes(this.peek(1).v))) { this.i++; return true; }
    return false;
  }
  parseCmp(): Node {
    let a = this.parseAdd();
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(t.v)) {
        this.next();
        const b = this.parseAdd();
        // chained comparison  a ≤ x < b  →  (a ≤ x) ∧ (x < b)
        if (a.k === 'bin' && ['<', '>', '<=', '>='].includes(a.op) && ['<', '>', '<=', '>='].includes(t.v)) {
          a = { k: 'bin', op: 'and', a, b: { k: 'bin', op: t.v as BinOp, a: a.b, b } };
        } else a = { k: 'bin', op: t.v as BinOp, a, b };
      } else return a;
    }
  }
  parseAdd(): Node {
    let a = this.parseMul();
    for (;;) {
      if (this.eat('+')) a = { k: 'bin', op: '+', a, b: this.parseMul() };
      else if (this.eat('-')) a = { k: 'bin', op: '-', a, b: this.parseMul() };
      else return a;
    }
  }
  parseMul(): Node {
    let a = this.parseUnary();
    for (;;) {
      if (this.eat('*') || this.eat('·')) a = { k: 'bin', op: '*', a, b: this.parseUnary() };
      else if (this.eat('×')) a = { k: 'bin', op: 'cross', a, b: this.parseUnary() };
      else if (this.eat('/')) a = { k: 'bin', op: '/', a, b: this.parseUnary() };
      else if (this.startsImplicitOperand()) {
        const b = this.parsePow();
        // "k·20 °C": the temperature unit belongs to the number directly before it
        if (b.k === 'id' && TEMP_UNITS.has(b.name) && a.k === 'bin' && (a.op === '*' || a.op === '/') && !a.implicit && a.b.k === 'num') {
          a = { ...a, b: { k: 'bin', op: '*', a: a.b, b, implicit: true } };
        } else a = { k: 'bin', op: '*', a, b, implicit: true };
      } else return a;
    }
  }
  /** Can the next token start an operand that is implicitly multiplied? */
  startsImplicitOperand() {
    const t = this.peek();
    const prev = this.toks[this.i - 1];
    if ((t.t === 'num' || t.t === 'imag') && prev && (prev.t === 'num' || prev.t === 'imag')) {
      throw new ParseError('Zwei Zahlen ohne Rechenzeichen dazwischen', t.pos, t.end);
    }
    if (t.t === 'id') return !['and', 'or', 'xor', 'not'].includes(t.v);
    if (t.t === 'num' || t.t === 'imag') return true;
    if (t.t === 'op' && (t.v === '(' || t.v === '√' || t.v === '∛' || t.v === '∜')) return true;
    return false;
  }
  parseUnary(): Node {
    if (this.eat('-')) return { k: 'un', op: 'neg', a: this.parseUnary() };
    if (this.eat('+')) return this.parseUnary();
    return this.parsePow();
  }
  parsePow(): Node {
    const base = this.parsePostfix();
    if (this.isOp('^')) {
      this.next();
      // A^T  → transpose
      const t = this.peek();
      if (t.t === 'id' && t.v === 'T' && !this.isCallOrIndexAt(1)) {
        this.next();
        // written as x^T: if T is a variable and x no matrix, the evaluator computes the power
        return this.parsePostfixOps({ k: 'un', op: 'transpose', a: base, caret: true });
      }
      let exp: Node;
      if (this.eat('-')) exp = { k: 'un', op: 'neg', a: this.parsePowOperand() };
      else { this.eat('+'); exp = this.parsePowOperand(); }
      return { k: 'bin', op: '^', a: base, b: exp };
    }
    return base;
  }
  isCallOrIndexAt(o: number) {
    const t = this.peek(o + 1);
    return t.t === 'op' && (t.v === '(' || t.v === '[') && !t.spaceBefore;
  }
  parsePowOperand(): Node {
    // right associative
    const b = this.parsePostfix();
    if (this.isOp('^')) {
      this.next();
      let exp: Node;
      if (this.eat('-')) exp = { k: 'un', op: 'neg', a: this.parsePowOperand() };
      else exp = this.parsePowOperand();
      return { k: 'bin', op: '^', a: b, b: exp };
    }
    return b;
  }
  parsePostfix(): Node {
    return this.parsePostfixOps(this.parsePrimary());
  }
  parsePostfixOps(n: Node): Node {
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op') return n;
      if (t.v === '!' && !this.isOp('=', 1)) { this.next(); n = { k: 'un', op: 'fact', a: n }; continue; }
      if (t.v === '%') { this.next(); n = { k: 'un', op: 'pct', a: n }; continue; }
      if (t.v === 'ᵀ') { this.next(); n = { k: 'un', op: 'transpose', a: n }; continue; }
      if (t.v === '[' && !t.spaceBefore) {
        this.next();
        const idx = [this.parseOr()];
        while (this.eat(',')) idx.push(this.parseOr());
        this.expect(']');
        n = { k: 'index', a: n, idx };
        continue;
      }
      if (t.v === '<' && !t.spaceBefore && this.isOp('<', 1)) {
        // column operator  A<<j>>
        this.next(); this.next();
        const j = this.parseAdd();
        this.expect('>'); this.expect('>');
        n = { k: 'col', a: n, j };
        continue;
      }
      return n;
    }
  }

  parseArgs(): Node[] {
    this.expect('(');
    const args: Node[] = [];
    if (this.eat(')')) return args;
    args.push(this.parseTop(true));
    while (this.eat(',')) args.push(this.parseTop(true));
    this.expect(')');
    return args;
  }

  parsePrimary(): Node {
    const t = this.peek();
    if (t.t === 'num') { this.next(); return { k: 'num', v: parseFloat(t.v), raw: t.v }; }
    if (t.t === 'imag') { this.next(); return { k: 'imag', v: parseFloat(t.v), raw: t.v }; }
    if (t.t === 'str') { this.next(); return { k: 'str', v: t.v }; }
    if (t.t === 'id') {
      this.next();
      const name = t.v;
      const call = this.isOp('(') && !this.peek().spaceBefore;
      if (call) return this.parseCall(name, t);
      return { k: 'id', name };
    }
    if (t.t === 'op') {
      switch (t.v) {
        case '(': {
          this.next();
          const a = this.parseTop(true);
          this.expect(')');
          return { k: 'paren', a };
        }
        case '[': return this.parseMatrix();
        case '|': {
          this.next();
          const a = this.parseAdd();
          this.expect('|');
          return { k: 'un', op: 'abs', a };
        }
        case '√': this.next(); return { k: 'un', op: 'sqrt', a: this.parseRadicand() };
        case '∛': this.next(); return { k: 'nroot', n: { k: 'num', v: 3 }, a: this.parseRadicand() };
        case '∜': this.next(); return { k: 'nroot', n: { k: 'num', v: 4 }, a: this.parseRadicand() };
        case '∑': case '∏': case '∫': this.next(); return this.parseCall(t.v === '∑' ? 'sum' : t.v === '∏' ? 'prod' : 'int', t);
        case '?': this.next(); return { k: 'placeholder' };
      }
    }
    if (t.t === 'eof') throw new ParseError('Ausdruck unvollständig', t.pos, t.end);
    throw new ParseError(`Unerwartetes „${t.v}“`, t.pos, t.end);
  }

  parseRadicand(): Node {
    if (this.isOp('(')) { this.next(); const a = this.parseTop(false); this.expect(')'); return a; }
    return this.parsePostfix();
  }

  parseCall(name: string, t: Token): Node {
    const args = this.parseArgs();
    const iter = ITER_FUNCS[name];
    const boundVar = (n: Node | undefined, what: string): string => {
      if (!n || n.k !== 'id') throw new ParseError(`${what}: Laufvariable muss ein Name sein`, t.pos, t.end);
      return n.name;
    };
    if (iter && args.length >= 2) {
      if (args.length === 2) return { k: 'iter', op: iter, body: args[0], v: boundVar(args[1], name) };
      if (args.length === 4) return { k: 'iter', op: iter, body: args[0], v: boundVar(args[1], name), lo: args[2], hi: args[3] };
      throw new ParseError(`${name}(Ausdruck, i, Start, Ende) erwartet`, t.pos, t.end);
    }
    if (iter && args.length === 1) return { k: 'iter', op: iter, body: args[0] };
    if (name === 'int' || name === '∫') {
      if (args.length !== 4) throw new ParseError('int(Ausdruck, x, a, b) erwartet', t.pos, t.end);
      return { k: 'int', body: args[0], v: boundVar(args[1], 'int'), lo: args[2], hi: args[3] };
    }
    if (name === 'deriv') {
      if (args.length < 2 || args.length > 3) throw new ParseError('deriv(Ausdruck, x [, Ordnung]) erwartet', t.pos, t.end);
      let order: number | undefined;
      if (args[2]) {
        if (args[2].k !== 'num') throw new ParseError('Ableitungsordnung muss eine Zahl sein', t.pos, t.end);
        order = args[2].v;
      }
      return { k: 'deriv', body: args[0], v: boundVar(args[1], 'deriv'), order };
    }
    if (name === 'sqrt' && args.length === 1) return { k: 'un', op: 'sqrt', a: args[0] };
    if (name === 'nthroot' && args.length === 2) return { k: 'nroot', n: args[1], a: args[0] };
    if (name === 'vec' && args.length === 1) return { k: 'un', op: 'vec', a: args[0] };
    if (name === 'col' && args.length === 2) return { k: 'col', a: args[0], j: args[1] };
    return { k: 'call', name, args };
  }

  parseMatrix(): Node {
    this.expect('[');
    const rows: Node[][] = [];
    let row: Node[] = [];
    if (this.eat(']')) return { k: 'matrix', rows: [] };
    for (;;) {
      row.push(this.parseOr());
      if (this.eat(',')) continue;
      if (this.eat(';')) { rows.push(row); row = []; continue; }
      this.expect(']');
      rows.push(row);
      break;
    }
    const w = rows[0].length;
    if (rows.some(r => r.length !== w)) throw new ParseError('Alle Matrixzeilen müssen gleich lang sein', this.peek().pos);
    return { k: 'matrix', rows };
  }
}

export function parseExpression(src: string, allowRange = true): Node {
  const p = new Parser(tokenize(src), src);
  const n = p.parseTop(allowRange);
  if (!p.atEnd()) {
    const t = p.peek();
    throw new ParseError(`Unerwartetes „${t.v}“`, t.pos, t.end);
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Statements                                                           */
/* ------------------------------------------------------------------ */

function findTopLevel(toks: Token[], pred: (t: Token) => boolean, from = 0): number {
  let depth = 0;
  for (let j = from; j < toks.length; j++) {
    const t = toks[j];
    if (t.t !== 'op') continue;
    if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
    else if (t.v === ')' || t.v === ']' || t.v === '}') depth--;
    else if (depth === 0 && pred(t)) return j;
  }
  return -1;
}

function parseTarget(src: string): DefTarget {
  const toks = tokenize(src);
  const p = new Parser(toks, src);
  if (p.isOp('[')) {
    p.next();
    const multi: Node[] = [];
    for (;;) {
      const a = p.parsePostfix();
      if (a.k !== 'id' && !(a.k === 'index' && a.a.k === 'id')) throw new ParseError('Mehrfachzuweisung: nur Namen oder Elemente erlaubt', p.peek().pos);
      multi.push(a);
      if (p.eat(']')) break;
      if (!p.eat(';')) p.expect(',');
    }
    if (!p.atEnd()) { const x = p.peek(); throw new ParseError(`Unerwartetes „${x.v}“`, x.pos, x.end); }
    const first = multi[0];
    return { name: first.k === 'id' ? first.name : (first as { a: { name: string } }).a.name, multi };
  }
  const t = p.next();
  if (t.t !== 'id') throw new ParseError('Links von „:=“ muss ein Name stehen', t.pos, t.end);
  const target: DefTarget = { name: t.v };
  if (p.isOp('(')) {
    p.next();
    const params: string[] = [];
    if (!p.eat(')')) {
      for (;;) {
        const a = p.next();
        if (a.t !== 'id') throw new ParseError('Parameter müssen Namen sein', a.pos, a.end);
        params.push(a.v);
        if (p.eat(')')) break;
        p.expect(',');
      }
    }
    target.params = params;
  } else if (p.isOp('[')) {
    p.next();
    const idx = [p.parseOr()];
    while (p.eat(',')) idx.push(p.parseOr());
    p.expect(']');
    target.index = idx;
  }
  if (!p.atEnd()) { const x = p.peek(); throw new ParseError(`Unerwartetes „${x.v}“ in der Definition`, x.pos, x.end); }
  return target;
}

const TEMP_UNITS = new Set(['°C', '°F', 'degC', 'degF']);
const RESERVED = new Set(['and', 'or', 'xor', 'not', 'if', 'else', 'for', 'while', 'return', 'break', 'continue', 'otherwise']);

function at<T>(offset: number, fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof ParseError) throw new ParseError(e.message, e.pos + offset, e.end + offset);
    throw e;
  }
}

/** Unit placeholder after "=": "%" alone is allowed as display unit. */
function parseUnit(src: string): Node {
  if (src.trim() === '%') return { k: 'id', name: '%' };
  return parseExpression(src, false);
}

/** Parse the content of a math region (may span several lines for programs). */
export function parseMathRegion(src: string): MathStmt {
  const text = src.replace(/\r/g, '');
  const lines0 = text.split('\n');
  const fi = lines0.findIndex(l => l.trim() !== '');
  const headOffset = fi > 0 ? lines0.slice(0, fi).join('\n').length + 1 : 0;
  return at(headOffset, () => parseMathRegionInner(text));
}

function parseMathRegionInner(text: string): MathStmt {
  if (!text.trim()) return { kind: 'empty' };
  const lines = text.split('\n');
  const firstIdx = lines.findIndex(l => l.trim() !== '');
  const head = lines[firstIdx];
  const rest = lines.slice(firstIdx + 1);
  const hasBody = rest.some(l => l.trim() !== '');

  const toks = tokenize(head);
  const defIdx = findTopLevel(toks, t => t.v === ':=' || t.v === '≡');
  if (defIdx >= 0) {
    const global = toks[defIdx].v === '≡';
    const lhsSrc = head.slice(0, toks[defIdx].pos);
    const target = parseTarget(lhsSrc);
    for (const n of [target.name, ...(target.params ?? [])]) {
      if (RESERVED.has(n)) throw new ParseError(`„${n}“ ist ein reserviertes Wort und kann nicht definiert werden`, 0, lhsSrc.length);
    }
    let rhsSrc = head.slice(toks[defIdx].end);
    if (hasBody) {
      if (rhsSrc.trim() !== '' && rhsSrc.trim() !== '{') {
        throw new ParseError('Für ein Programm muss die erste Zeile nach „:=“ enden', toks[defIdx].end);
      }
      const offset = head.length + 1;
      const body = parseProgramLines(rest, offset);
      return { kind: 'define', target, global, expr: { k: 'program', body } };
    }
    // trailing "=" displays the value:   x := 5 m =   or   x := 5 m = mm
    const rhsToks = tokenize(rhsSrc);
    const eqIdx = findTopLevel(rhsToks, t => t.v === '=');
    let show: { unit?: Node } | undefined;
    if (eqIdx >= 0) {
      const unitSrc = rhsSrc.slice(rhsToks[eqIdx].end);
      show = {};
      const uoff = toks[defIdx].end + rhsToks[eqIdx].end;
      if (unitSrc.trim()) show.unit = at(uoff, () => parseUnit(unitSrc));
      rhsSrc = rhsSrc.slice(0, rhsToks[eqIdx].pos);
    }
    const base = toks[defIdx].end;
    let expr: Node;
    try {
      expr = parseExpression(rhsSrc, true);
    } catch (e) {
      if (e instanceof ParseError) throw new ParseError(e.message, e.pos + base, e.end + base);
      throw e;
    }
    return { kind: 'define', target, global, expr, show };
  }
  if (hasBody) throw new ParseError('Mehrzeilige Ausdrücke sind nur als Programm nach „:=“ erlaubt', head.length);
  const eqIdx = findTopLevel(toks, t => t.v === '=' || t.v === '→');
  if (eqIdx >= 0) {
    const expr = parseExpression(head.slice(0, toks[eqIdx].pos), true);
    const unitSrc = head.slice(toks[eqIdx].end);
    const unit = unitSrc.trim() ? at(toks[eqIdx].end, () => parseUnit(unitSrc)) : undefined;
    return { kind: 'eval', expr, unit };
  }
  return { kind: 'expr', expr: parseExpression(head, true) };
}


/* ------------------------------------------------------------------ */
/* Programs (indentation based)                                        */
/* ------------------------------------------------------------------ */

interface Line { indent: number; text: string; pos: number }

function parseProgramLines(lines: string[], offset: number): Stmt[] {
  const ls: Line[] = [];
  let pos = offset;
  for (const raw of lines) {
    const cleaned = raw.replace(/\t/g, '  ');
    const trimmed = cleaned.trim();
    if (trimmed && trimmed !== '{' && trimmed !== '}') {
      ls.push({ indent: cleaned.length - cleaned.trimStart().length, text: trimmed, pos: pos + (raw.length - raw.trimStart().length) });
    }
    pos += raw.length + 1;
  }
  if (!ls.length) throw new ParseError('Leeres Programm', offset);
  const [stmts, next] = parseBlock(ls, 0, ls[0].indent);
  if (next < ls.length) throw new ParseError('Einrückung passt nicht', ls[next].pos);
  return stmts;
}

function wrapErr<T>(line: Line, inner: number, fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof ParseError) throw new ParseError(e.message, line.pos + inner + e.pos, line.pos + inner + e.end);
    throw e;
  }
}

function parseBlock(ls: Line[], i: number, indent: number): [Stmt[], number] {
  const out: Stmt[] = [];
  while (i < ls.length && ls[i].indent >= indent) {
    const line = ls[i];
    if (line.indent > indent) throw new ParseError('Unerwartete Einrückung', line.pos);
    const text = line.text;
    // keyword: leading letters, so that "if(x > 0)" is recognised as well
    const kw = (/^([\p{L}]+)/u.exec(text) ?? /^(\S+)/.exec(text))![1];
    const childIndent = () => (i + 1 < ls.length && ls[i + 1].indent > indent ? ls[i + 1].indent : -1);
    const body = (): Stmt[] => {
      const ci = childIndent();
      if (ci < 0) throw new ParseError('Eingerückter Block erwartet', line.pos);
      const [b, n] = parseBlock(ls, i + 1, ci);
      i = n;
      return b;
    };
    if (kw === 'if') {
      const cond = wrapErr(line, 2, () => parseExpression(text.slice(2), false));
      const branches: { cond: Node; body: Stmt[]; also?: boolean }[] = [{ cond, body: body() }];
      let otherwise: Stmt[] | undefined;
      while (i < ls.length && ls[i].indent === indent) {
        const l2 = ls[i];
        const m = /^(else\s+if|elseif|also\s+if)\b(.*)$/.exec(l2.text);
        if (m) {
          const c = wrapErr(l2, l2.text.length - m[2].length, () => parseExpression(m[2], false));
          const ci = i + 1 < ls.length && ls[i + 1].indent > indent ? ls[i + 1].indent : -1;
          if (ci < 0) throw new ParseError('Eingerückter Block erwartet', l2.pos);
          const [b, n] = parseBlock(ls, i + 1, ci);
          i = n;
          branches.push(m[1].startsWith('also') ? { cond: c, body: b, also: true } : { cond: c, body: b });
          continue;
        }
        if (/^(else|otherwise)$/.test(l2.text)) {
          const ci = i + 1 < ls.length && ls[i + 1].indent > indent ? ls[i + 1].indent : -1;
          if (ci < 0) throw new ParseError('Eingerückter Block erwartet', l2.pos);
          const [b, n] = parseBlock(ls, i + 1, ci);
          i = n;
          otherwise = b;
        }
        break;
      }
      out.push({ k: 'if', branches, otherwise });
      continue;
    }
    if (kw === 'for') {
      const m = /^for\s+(.+?)\s*(?:∈|\bin\b)\s*(.+)$/.exec(text);
      if (!m) throw new ParseError('Syntax: for i ∈ Bereich', line.pos);
      const v = m[1].trim();
      const iter = wrapErr(line, text.length - m[2].length, () => parseExpression(m[2], true));
      out.push({ k: 'for', v, iter, body: body() });
      continue;
    }
    if (kw === 'while') {
      const cond = wrapErr(line, 5, () => parseExpression(text.slice(5), false));
      out.push({ k: 'while', cond, body: body() });
      continue;
    }
    if (kw === 'try') {
      const b = body();
      let onError: Stmt[] = [];
      if (i < ls.length && ls[i].indent === indent && /^(on\s+error|catch)$/.test(ls[i].text)) {
        const ci = i + 1 < ls.length && ls[i + 1].indent > indent ? ls[i + 1].indent : -1;
        if (ci < 0) throw new ParseError('Eingerückter Block erwartet', ls[i].pos);
        const [bb, n] = parseBlock(ls, i + 1, ci);
        i = n; onError = bb;
      }
      out.push({ k: 'try', body: b, onError });
      continue;
    }
    if (kw === 'return') {
      out.push({ k: 'return', value: wrapErr(line, 6, () => parseExpression(text.slice(6), true)) });
      i++; continue;
    }
    if (text === 'break') { out.push({ k: 'break' }); i++; continue; }
    if (text === 'continue') { out.push({ k: 'continue' }); i++; continue; }
    if (/^(else|otherwise|elseif|else\s+if|also\s+if)\b/.test(text)) throw new ParseError('„else“ ohne passendes „if“', line.pos);
    const am = /^(.+?)\s*(←|<-(?=\s)|:=)\s*(.+)$/.exec(text);
    if (am) {
      const target = wrapErr(line, 0, () => parseExpression(am[1], false));
      if (target.k !== 'id' && target.k !== 'index' && target.k !== 'col') throw new ParseError('Zuweisung nur an Namen oder Elemente', line.pos);
      const value = wrapErr(line, text.length - am[3].length, () => parseExpression(am[3], true));
      out.push({ k: 'assign', target, value });
      i++; continue;
    }
    out.push({ k: 'expr', value: wrapErr(line, 0, () => parseExpression(text, true)) });
    i++;
  }
  return [out, i];
}
