import type { Node, Stmt, MathStmt, DefTarget } from './ast';
import { prec } from './serialize';
import { escapeText } from './format';

export interface LatexCtx {
  /** True if the identifier should be rendered as a unit (upright). */
  isUnit?: (name: string) => boolean;
  /** True if the name is a builtin function (rendered upright). */
  isBuiltin?: (name: string) => boolean;
  /** Region-relative highlighting of an identifier (e.g. undefined variable). */
  highlight?: string;
}

const GREEK: Record<string, string> = {
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\varepsilon', ϵ: '\\epsilon', ζ: '\\zeta', η: '\\eta',
  θ: '\\theta', ϑ: '\\vartheta', ι: '\\iota', κ: '\\kappa', λ: '\\lambda', μ: '\\mu', µ: '\\mu', ν: '\\nu', ξ: '\\xi', ο: 'o',
  π: '\\pi', ρ: '\\rho', σ: '\\sigma', ς: '\\varsigma', τ: '\\tau', υ: '\\upsilon', φ: '\\varphi', ϕ: '\\phi', χ: '\\chi',
  ψ: '\\psi', ω: '\\omega', Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi', Π: '\\Pi', Σ: '\\Sigma',
  Υ: '\\Upsilon', Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega', '∞': '\\infty', ℏ: '\\hbar', '°': '{}^{\\circ}', "'": "{}'",
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Χ: 'X',
};

/** Render a run of identifier characters. */
function chars(s: string, upright: boolean): string {
  let out = '';
  let plain = '';
  const flush = () => {
    if (!plain) return;
    out += upright || plain.length > 1 ? `\\mathrm{${plain}}` : plain;
    plain = '';
  };
  for (const ch of s) {
    if (GREEK[ch] !== undefined) {
      flush();
      const g = GREEK[ch];
      out += upright && g.startsWith('\\') && /^[a-z]/i.test(g.slice(1)) && !['\\infty', "{}'", '{}^{\\circ}'].includes(g) ? `{${g}}` : g;
      if (/^\\[a-zA-Z]+$/.test(g)) out += ' ';
    } else if (/[A-Za-z0-9.]/.test(ch)) plain += ch;
    else if (ch === '%') { flush(); out += '\\%'; }
    else { flush(); out += `\\text{${escapeText(ch)}}`; }
  }
  flush();
  return out.trim();
}

export function nameLatex(name: string, ctx: LatexCtx = {}, opts: { upright?: boolean } = {}): string {
  if (name.startsWith("'")) return nameLatex(name.slice(1), { ...ctx, isUnit: () => true }, opts);
  const i = name.indexOf('_');
  const isUnit = ctx.isUnit?.(name) ?? false;
  const upright = opts.upright || isUnit;
  let base: string, sub: string | undefined;
  if (i > 0 && i < name.length - 1) { base = name.slice(0, i); sub = name.slice(i + 1); }
  else base = name;
  let s: string;
  if (base.length > 1 && !upright && /^[A-Za-z]+[0-9]*$/.test(base)) s = `\\mathit{${base}}`;
  else s = chars(base, upright);
  if (sub) s = `{${s}}_{${chars(sub, true)}}`;
  if (ctx.highlight && ctx.highlight === name) s = `\\htmlClass{fw-err-id}{${s}}`;
  return `{${s}}`;
}

const OPS: Record<string, string> = {
  '+': '+', '-': '-', '==': '\\mathbf{=}', '!=': '\\neq', '<': '<', '>': '>', '<=': '\\le', '>=': '\\ge',
  and: '\\wedge', or: '\\vee', xor: '\\oplus', cross: '\\times',
};

export function toLatex(n: Node, ctx: LatexCtx = {}): string {
  const L = (c: Node) => toLatex(c, ctx);
  const wrap = (c: Node, minPrec: number) => {
    const s = L(c);
    return prec(c) < minPrec && c.k !== 'paren' ? `\\left(${s}\\right)` : s;
  };
  switch (n.k) {
    case 'num': {
      const raw = n.raw ?? String(n.v);
      const m = /^(-?[0-9.]+)[eE]([+-]?[0-9]+)$/.exec(raw);
      if (m) return `${m[1]}\\cdot 10^{${parseInt(m[2], 10)}}`;
      return raw;
    }
    case 'imag': return `${n.raw ?? n.v}\\mathrm{i}`;
    case 'str': return `\\text{“${escapeText(n.v)}”}`;
    case 'id': return nameLatex(n.name, ctx);
    case 'placeholder': return '\\blacksquare';
    case 'paren': return `\\left(${L(n.a)}\\right)`;
    case 'bin': {
      const p = prec(n);
      switch (n.op) {
        case '/': {
          // quantities like 18.5 kN/m are written inline, everything else as a fraction
          if (isUnitish(n.b, ctx) && (isUnitish(n.a, ctx) || isQuantity(n.a, ctx))) return `${L(n.a)}/${wrapUnit(n.b, ctx)}`;
          return `\\frac{${L(stripParen(n.a))}}{${L(stripParen(n.b))}}`;
        }
        case '^': {
          const base = n.a.k === 'bin' && n.a.op === '/' ? `\\left(${L(n.a)}\\right)` : wrap(n.a, 9);
          return `{${base}}^{${L(stripParen(n.b))}}`;
        }
        case '*': {
          const a = wrap(n.a, p), b = wrap(n.b, p + (n.b.k === 'bin' && n.b.op === '/' ? 0 : 0));
          const bIsUnit = isUnitish(n.b, ctx);
          if (bIsUnit && (n.a.k === 'num' || n.a.k === 'un' || n.implicit || isNumberish(n.a))) return `${a}\\ ${b}`;
          return `${a}\\cdot ${b}`;
        }
        default: {
          const left = wrap(n.a, p);
          const right = wrap(n.b, n.op === '-' || p === 4 ? p + 1 : p);
          return `${left} ${OPS[n.op]} ${right}`;
        }
      }
    }
    case 'un':
      switch (n.op) {
        // a fraction bar groups by itself: -b/a needs no parentheses
        case 'neg': {
          const inner = n.a.k === 'paren' && n.a.a.k === 'bin' && n.a.a.op === '/' ? n.a.a : n.a;
          return inner.k === 'bin' && inner.op === '/' ? `-${L(inner)}` : `-${wrap(n.a, 7)}`;
        }
        case 'not': return `\\neg ${wrap(n.a, 3)}`;
        case 'fact': return `${wrap(n.a, 10)}!`;
        case 'pct': return `${wrap(n.a, 10)}\\%`;
        case 'transpose': return `{${wrap(n.a, 10)}}^{\\mathsf{T}}`;
        case 'abs': return `\\left|${L(n.a)}\\right|`;
        case 'sqrt': return `\\sqrt{${L(stripParen(n.a))}}`;
        case 'vec': return `\\overrightarrow{${L(stripParen(n.a))}}`;
      }
      return '';
    case 'nroot': return `\\sqrt[${L(n.n)}]{${L(stripParen(n.a))}}`;
    case 'call': {
      // Mathcad's limit operator:  lim_{x→a⁺} f
      if (n.name === 'lim' && n.args.length >= 3 && n.args[1].k === 'id') {
        const sd = n.args[3]?.k === 'str' ? n.args[3].v.toLowerCase() : '';
        const sup = ['right', 'rechts', '+'].includes(sd) ? '^{+}' : ['left', 'links', '-'].includes(sd) ? '^{-}' : '';
        const body = prec(n.args[0]) < 6 ? `\\left(${L(n.args[0])}\\right)` : L(n.args[0]);
        return `\\lim_{${nameLatex(n.args[1].name, ctx)}\\to ${L(n.args[2])}${sup}}${body}`;
      }
      const builtin = ctx.isBuiltin?.(n.name) ?? false;
      const fname = builtin && n.name.length > 1 && /^[A-Za-z]+$/.test(n.name) ? `\\operatorname{${n.name}}` : nameLatex(n.name, ctx, { upright: builtin });
      return `${fname}\\left(${n.args.map(L).join(',\\,')}\\right)`;
    }
    case 'index': {
      const base = wrap(n.a, 10);
      return `{${base}}_{${n.idx.map(L).join(',')}}`;
    }
    case 'col': return `{${wrap(n.a, 10)}}^{\\langle ${L(n.j)}\\rangle}`;
    case 'matrix': return `\\begin{bmatrix}${n.rows.map(r => r.map(L).join(' & ')).join(' \\\\ ')}\\end{bmatrix}`;
    case 'range': return n.second ? `${L(n.start)},${L(n.second)}\\,..\\,${L(n.end)}` : `${L(n.start)}\\,..\\,${L(n.end)}`;
    case 'iter': {
      const sym = n.op === 'sum' ? '\\sum' : '\\prod';
      const body = prec(n.body) < 6 ? `\\left(${L(n.body)}\\right)` : L(n.body);
      if (!n.v) return `${sym}${body}`;
      if (!n.lo || !n.hi) return `${sym}_{${nameLatex(n.v, ctx)}}${body}`;
      return `${sym}_{${nameLatex(n.v, ctx)}=${L(n.lo)}}^{${L(n.hi)}}${body}`;
    }
    case 'int': return `\\int${n.lo && n.hi ? `_{${L(n.lo)}}^{${L(n.hi)}}` : ''}${L(n.body)}\\,\\mathrm{d}${nameLatex(n.v, ctx)}`;
    case 'deriv': {
      const o = n.order && n.order !== 1 ? `^{${n.order}}` : '';
      const body = prec(n.body) < 6 ? `\\left(${L(n.body)}\\right)` : L(n.body);
      return `\\frac{\\mathrm{d}${o}}{\\mathrm{d}${nameLatex(n.v, ctx)}${o}}${body}`;
    }
    case 'program': return programLatex(n.body, ctx);
  }
}

function stripParen(n: Node): Node { return n.k === 'paren' ? n.a : n; }

function isNumberish(n: Node): boolean {
  if (n.k === 'num' || n.k === 'imag') return true;
  if (n.k === 'un' && n.op === 'neg') return isNumberish(n.a);
  if (n.k === 'bin' && n.op === '/' ) return isNumberish(n.a) && isNumberish(n.b);
  return false;
}

function isQuantity(n: Node, ctx: LatexCtx): boolean {
  return n.k === 'bin' && n.op === '*' && isNumberish(n.a) && isUnitish(n.b, ctx);
}
function wrapUnit(n: Node, ctx: LatexCtx): string {
  const s = toLatex(n, ctx);
  return n.k === 'bin' && (n.op === '*' || n.op === '/') ? `\\left(${s}\\right)` : s;
}

function isUnitish(n: Node, ctx: LatexCtx): boolean {
  if (n.k === 'id') return ctx.isUnit?.(n.name) ?? false;
  if (n.k === 'bin' && (n.op === '*' || n.op === '/')) return isUnitish(n.a, ctx) && (isUnitish(n.b, ctx) || n.b.k === 'num');
  if (n.k === 'bin' && n.op === '^') return isUnitish(n.a, ctx);
  if (n.k === 'paren') return isUnitish(n.a, ctx);
  return false;
}

function programLatex(stmts: Stmt[], ctx: LatexCtx): string {
  const lines: string[] = [];
  const kw = (s: string) => `\\textbf{${s}}\\ `;
  const emit = (ss: Stmt[], depth: number) => {
    const ind = depth ? `\\quad`.repeat(depth) + ' ' : '';
    for (const s of ss) {
      switch (s.k) {
        case 'assign': lines.push(`${ind}${toLatex(s.target, ctx)}\\leftarrow ${toLatex(s.value, ctx)}`); break;
        case 'expr': lines.push(`${ind}${toLatex(s.value, ctx)}`); break;
        case 'return': lines.push(`${ind}${kw('return')}${toLatex(s.value, ctx)}`); break;
        case 'break': lines.push(`${ind}\\textbf{break}`); break;
        case 'continue': lines.push(`${ind}\\textbf{continue}`); break;
        case 'for': lines.push(`${ind}${kw('for')}${nameLatex(s.v, ctx)}\\in ${toLatex(s.iter, ctx)}`); emit(s.body, depth + 1); break;
        case 'while': lines.push(`${ind}${kw('while')}${toLatex(s.cond, ctx)}`); emit(s.body, depth + 1); break;
        case 'if':
          s.branches.forEach((b, i) => { lines.push(`${ind}${kw(i ? (b.also ? 'also if' : 'else if') : 'if')}${toLatex(b.cond, ctx)}`); emit(b.body, depth + 1); });
          if (s.otherwise) { lines.push(`${ind}\\textbf{else}`); emit(s.otherwise, depth + 1); }
          break;
        case 'try':
          lines.push(`${ind}\\textbf{try}`); emit(s.body, depth + 1);
          lines.push(`${ind}\\textbf{on error}`); emit(s.onError, depth + 1);
          break;
      }
    }
  };
  emit(stmts, 0);
  return `\\left|\\begin{array}{l}${lines.join(' \\\\ ')}\\end{array}\\right.`;
}

export function targetLatex(t: DefTarget, ctx: LatexCtx): string {
  if (t.multi) return `\\begin{bmatrix}${t.multi.map(n => toLatex(n, ctx)).join(' \\\\ ')}\\end{bmatrix}`;
  const name = nameLatex(t.name, ctx);
  if (t.params) return `${name}\\left(${t.params.map(p => nameLatex(p, ctx)).join(',\\,')}\\right)`;
  if (t.index) return `{${name}}_{${t.index.map(i => toLatex(i, ctx)).join(',')}}`;
  return name;
}

/** LaTeX of the statement without result (the "= result" part is added by the UI). */
export function stmtLatex(s: MathStmt, ctx: LatexCtx = {}): string {
  switch (s.kind) {
    case 'empty': return '';
    case 'expr': return toLatex(s.expr, ctx);
    case 'eval': return toLatex(s.expr, ctx);
    case 'define': return `${targetLatex(s.target, ctx)} ${s.global ? '\\equiv' : '\\coloneqq'} ${toLatex(s.expr, ctx)}`;
  }
}
