/**
 * Abstract syntax tree shared by the text parser, the Mathcad importers,
 * the LaTeX renderer, the serializer and the evaluator.
 */

export type BinOp =
  | '+' | '-' | '*' | '/' | '^'
  | '==' | '!=' | '<' | '>' | '<=' | '>='
  | 'and' | 'or' | 'xor'
  | 'cross';

export type UnOp = 'neg' | 'not' | 'fact' | 'pct' | 'transpose' | 'abs' | 'sqrt' | 'vec';

export type Node =
  | { k: 'num'; v: number; raw?: string }
  | { k: 'imag'; v: number; raw?: string }
  | { k: 'str'; v: string }
  | { k: 'id'; name: string }
  | { k: 'bin'; op: BinOp; a: Node; b: Node; implicit?: boolean }
  | { k: 'un'; op: UnOp; a: Node; caret?: boolean }
  | { k: 'nroot'; n: Node; a: Node }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'index'; a: Node; idx: Node[] }
  | { k: 'col'; a: Node; j: Node }
  | { k: 'matrix'; rows: Node[][] }
  | { k: 'range'; start: Node; second?: Node; end: Node }
  | { k: 'paren'; a: Node }
  | { k: 'iter'; op: 'sum' | 'prod'; body: Node; v?: string; lo?: Node; hi?: Node }
  | { k: 'int'; body: Node; v: string; lo: Node; hi: Node }
  | { k: 'deriv'; body: Node; v: string; order?: number }
  | { k: 'program'; body: Stmt[] }
  | { k: 'placeholder' };

export type Stmt =
  | { k: 'assign'; target: Node; value: Node }
  | { k: 'if'; branches: { cond: Node; body: Stmt[] }[]; otherwise?: Stmt[] }
  | { k: 'for'; v: string; iter: Node; body: Stmt[] }
  | { k: 'while'; cond: Node; body: Stmt[] }
  | { k: 'return'; value: Node }
  | { k: 'break' }
  | { k: 'continue' }
  | { k: 'expr'; value: Node }
  | { k: 'try'; body: Stmt[]; onError: Stmt[] };

/** Left-hand side of a definition. */
export interface DefTarget {
  name: string;
  params?: string[];
  index?: Node[];
  /** Multiple assignment  [a; b[i]; c] := … (names or indexed names) */
  multi?: Node[];
}

export type MathStmt =
  | { kind: 'define'; target: DefTarget; global: boolean; expr: Node; show?: { unit?: Node } }
  | { kind: 'eval'; expr: Node; unit?: Node }
  | { kind: 'expr'; expr: Node }
  | { kind: 'empty' };

export const num = (v: number): Node => ({ k: 'num', v });
export const id = (name: string): Node => ({ k: 'id', name });
export const bin = (op: BinOp, a: Node, b: Node, implicit?: boolean): Node =>
  implicit ? { k: 'bin', op, a, b, implicit } : { k: 'bin', op, a, b };

/** Visit every node (pre-order). Stops descending if fn returns false. */
export function walk(n: Node, fn: (n: Node) => boolean | void): void {
  if (fn(n) === false) return;
  switch (n.k) {
    case 'bin': walk(n.a, fn); walk(n.b, fn); break;
    case 'un': case 'paren': walk(n.a, fn); break;
    case 'nroot': walk(n.n, fn); walk(n.a, fn); break;
    case 'call': n.args.forEach(a => walk(a, fn)); break;
    case 'index': walk(n.a, fn); n.idx.forEach(a => walk(a, fn)); break;
    case 'col': walk(n.a, fn); walk(n.j, fn); break;
    case 'matrix': n.rows.forEach(r => r.forEach(c => walk(c, fn))); break;
    case 'range': walk(n.start, fn); if (n.second) walk(n.second, fn); walk(n.end, fn); break;
    case 'iter': walk(n.body, fn); if (n.lo) walk(n.lo, fn); if (n.hi) walk(n.hi, fn); break;
    case 'int': walk(n.body, fn); walk(n.lo, fn); walk(n.hi, fn); break;
    case 'deriv': walk(n.body, fn); break;
    case 'program': walkStmts(n.body, fn); break;
  }
}

export function walkStmts(stmts: Stmt[], fn: (n: Node) => boolean | void): void {
  for (const s of stmts) {
    switch (s.k) {
      case 'assign': walk(s.target, fn); walk(s.value, fn); break;
      case 'if': s.branches.forEach(b => { walk(b.cond, fn); walkStmts(b.body, fn); }); if (s.otherwise) walkStmts(s.otherwise, fn); break;
      case 'for': walk(s.iter, fn); walkStmts(s.body, fn); break;
      case 'while': walk(s.cond, fn); walkStmts(s.body, fn); break;
      case 'return': case 'expr': walk(s.value, fn); break;
      case 'try': walkStmts(s.body, fn); walkStmts(s.onError, fn); break;
    }
  }
}

/** Split an identifier "F_max" into base and literal subscript. */
export function splitName(name: string): { base: string; sub?: string } {
  const i = name.indexOf('_');
  if (i <= 0 || i === name.length - 1) return { base: name };
  return { base: name.slice(0, i), sub: name.slice(i + 1) };
}
