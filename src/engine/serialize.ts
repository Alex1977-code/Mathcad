import type { Node, Stmt, MathStmt, DefTarget } from './ast';

/** Precedence of a node when printed (higher binds tighter). */
export function prec(n: Node): number {
  switch (n.k) {
    case 'bin':
      switch (n.op) {
        case 'or': case 'xor': return 1;
        case 'and': return 2;
        case '==': case '!=': case '<': case '>': case '<=': case '>=': return 4;
        case '+': case '-': return 5;
        case '*': case '/': case 'cross': return 6;
        case '^': return 8;
      }
      return 0;
    case 'un':
      switch (n.op) {
        case 'not': return 3;
        case 'neg': return 7;
        case 'fact': case 'pct': case 'transpose': return 9;
        default: return 10;
      }
    case 'num': return n.v < 0 ? 7 : 10;
    case 'range': return 0;
    case 'program': return 0;
    default: return 10;
  }
}

function fmtNum(v: number, raw?: string): string {
  if (raw && parseFloat(raw) === v) return raw;
  if (Number.isInteger(v) && Math.abs(v) < 1e21) return String(v);
  return String(v).replace('e+', 'e');
}

const OP_TEXT: Record<string, string> = {
  '+': ' + ', '-': ' - ', '*': '*', '/': '/', '^': '^',
  '==': ' == ', '!=': ' ≠ ', '<': ' < ', '>': ' > ', '<=': ' ≤ ', '>=': ' ≥ ',
  and: ' ∧ ', or: ' ∨ ', xor: ' ⊕ ', cross: ' × ',
};

export function toText(n: Node): string {
  const wrap = (c: Node, minPrec: number) => {
    const s = toText(c);
    return prec(c) < minPrec ? `(${s})` : s;
  };
  switch (n.k) {
    case 'num': return fmtNum(n.v, n.raw);
    case 'imag': return fmtNum(n.v, n.raw) + 'i';
    case 'str': return '"' + n.v.replace(/\\(?=["\\nt])/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
    case 'id': return n.name;
    case 'placeholder': return '?';
    case 'paren': return `(${toText(n.a)})`;
    case 'bin': {
      const p = prec(n);
      if (n.op === '^') {
        // right assoc: left needs strictly higher precedence
        const left = wrap(n.a, 9);
        const r = n.b;
        // a variable named T as exponent must not turn into the transpose
        const right = r.k === 'un' && r.op === 'neg' ? '-' + wrap(r.a, 9) : r.k === 'id' && r.name === 'T' ? '(T)' : wrap(r, 8);
        return `${left}^${right}`;
      }
      if (n.op === '*' && n.implicit) return `${wrap(n.a, p)} ${wrap(n.b, 8)}`;
      const left = wrap(n.a, p);
      // left-assoc: the right side needs parentheses unless it is the same associative operator
      const assoc = n.b.k === 'bin' && n.b.op === n.op && ['+', '*', 'and', 'or'].includes(n.op) && !n.b.implicit;
      const right = wrap(n.b, assoc ? p : p + 1);
      return left + OP_TEXT[n.op] + right;
    }
    case 'un':
      switch (n.op) {
        case 'neg': return '-' + wrap(n.a, 7);
        case 'not': return '¬' + wrap(n.a, 3);
        case 'fact': return wrap(n.a, 10) + '!';
        case 'pct': return wrap(n.a, 10) + '%';
        case 'transpose': return wrap(n.a, 10) + '^T';
        case 'abs': return prec(n.a) < 5 ? `|(${toText(n.a)})|` : `|${toText(n.a)}|`;
        case 'sqrt': return `√(${toText(n.a)})`;
        case 'vec': return `vec(${toText(n.a)})`;
      }
      return '';
    case 'nroot': return `nthroot(${toText(n.a)}, ${toText(n.n)})`;
    case 'call': return `${n.name}(${n.args.map(a => (a.k === 'range' && a.second ? `(${toText(a)})` : toText(a))).join(', ')})`;
    case 'index': return `${wrap(n.a, 10)}[${n.idx.map(toText).join(', ')}]`;
    case 'col': return `${wrap(n.a, 10)}<<${toText(n.j)}>>`;
    case 'matrix': return `[${n.rows.map(r => r.map(toText).join(', ')).join('; ')}]`;
    case 'range':
      return n.second
        ? `${toText(n.start)}, ${toText(n.second)} .. ${toText(n.end)}`
        : `${wrap(n.start, 1)} .. ${wrap(n.end, 1)}`;
    case 'iter': {
      const name = n.op;
      if (!n.v) return `${name}(${toText(n.body)})`;
      if (!n.lo || !n.hi) return `${name}(${toText(n.body)}, ${n.v})`;
      return `${name}(${toText(n.body)}, ${n.v}, ${toText(n.lo)}, ${toText(n.hi)})`;
    }
    case 'int': return n.lo && n.hi ? `int(${toText(n.body)}, ${n.v}, ${toText(n.lo)}, ${toText(n.hi)})` : `int(${toText(n.body)}, ${n.v})`;
    case 'deriv': return `deriv(${toText(n.body)}, ${n.v}${n.order && n.order !== 1 ? ', ' + n.order : ''})`;
    case 'program': return '\n' + stmtsToText(n.body, '  ');
  }
}

function stmtsToText(stmts: Stmt[], ind: string): string {
  const lines: string[] = [];
  const block = (b: Stmt[]) => lines.push(stmtsToText(b, ind + '  '));
  for (const s of stmts) {
    switch (s.k) {
      case 'assign': lines.push(`${ind}${toText(s.target)} ← ${toText(s.value)}`); break;
      case 'expr': lines.push(ind + toText(s.value)); break;
      case 'return': lines.push(`${ind}return ${toText(s.value)}`); break;
      case 'break': lines.push(ind + 'break'); break;
      case 'continue': lines.push(ind + 'continue'); break;
      case 'for': lines.push(`${ind}for ${s.v} ∈ ${toText(s.iter)}`); block(s.body); break;
      case 'while': lines.push(`${ind}while ${toText(s.cond)}`); block(s.body); break;
      case 'if':
        s.branches.forEach((b, i) => { lines.push(`${ind}${i ? (b.also ? 'also if' : 'else if') : 'if'} ${toText(b.cond)}`); block(b.body); });
        if (s.otherwise) { lines.push(ind + 'else'); block(s.otherwise); }
        break;
      case 'try':
        lines.push(ind + 'try'); block(s.body);
        lines.push(ind + 'on error'); block(s.onError.length ? s.onError : [{ k: 'expr', value: { k: 'num', v: 0 } }]);
        break;
    }
  }
  return lines.join('\n');
}

export function targetToText(t: DefTarget): string {
  if (t.multi) return `[${t.multi.map(toText).join('; ')}]`;
  if (t.params) return `${t.name}(${t.params.join(', ')})`;
  if (t.index) return `${t.name}[${t.index.map(toText).join(', ')}]`;
  return t.name;
}

export function stmtToText(s: MathStmt): string {
  switch (s.kind) {
    case 'empty': return '';
    case 'expr': return toText(s.expr);
    case 'eval':
      if (s.sym) return `${toText(s.expr)} →${s.sym.kw ? ' ' + s.sym.kw.name + (s.sym.kw.args.length ? ', ' + s.sym.kw.args.map(a => (a.k === 'bin' && a.op === '==' ? `${toText(a.a)} = ${toText(a.b)}` : toText(a))).join(', ') : '') : ''}`;
      return `${toText(s.expr)} =${s.unit ? ' ' + toText(s.unit) : ''}`;
    case 'define': {
      const op = s.global ? ' ≡ ' : ' := ';
      if (s.expr.k === 'program') return targetToText(s.target) + op.trimEnd() + toText(s.expr);
      let txt = targetToText(s.target) + op + toText(s.expr);
      if (s.show) txt += ' =' + (s.show.unit ? ' ' + toText(s.show.unit) : '');
      return txt;
    }
  }
}
