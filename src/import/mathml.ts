/**
 * Conversion of the Mathcad math XML vocabulary (schemas.mathsoft.com/math30 used by
 * Mathcad 11–15 .xmcd files and math50 used by Mathcad Prime .mcdx files) into the
 * FormelWerk AST.
 */
import type { Node, Stmt, MathStmt, DefTarget, BinOp } from '../engine/ast';

export interface ConvertCtx {
  warnings: string[];
  /** Names defined as variables/functions anywhere in the sheet (for unit disambiguation). */
  definedNames: Set<string>;
  /** Unknown operators encountered. */
  unknown: Set<string>;
}

export const kids = (e: Element): Element[] => Array.from(e.children);
export const local = (e: Element) => e.localName;
export const child = (e: Element, name: string) => kids(e).find(c => c.localName === name);

class ConvertError extends Error {}

/* ---------------------------------- names ---------------------------------- */

const NAME_FIX: Record<string, string> = { find: 'Find', given: 'Given', minerr: 'Minerr' };

function cleanPart(s: string, isSub: boolean): string {
  let out = '';
  for (const ch of s.replace(/\s+/g, '')) {
    if (/[\p{L}\p{N}_°'∞ℏ]/u.test(ch)) out += ch;
    else if (isSub && (ch === '.' || ch === ',')) out += '.';
    else if (ch === '%') out += isSub ? 'pct' : 'pct';
    else if (ch === '$') out += 'S';
    else out += '_';
  }
  if (isSub) out = out.replace(/_/g, '.').replace(/^\.+|\.+$/g, '').replace(/\.{2,}/g, '.');
  return out;
}

/** Read the identifier name from an <ml:id> element (handles Prime XAML subscripts). */
export function idName(e: Element): string {
  let base = '', sub = '';
  const span = kids(e).find(c => c.localName === 'Span');
  if (span) {
    for (const n of Array.from(span.childNodes)) {
      if (n.nodeType === 3) base += n.textContent ?? '';
      else if ((n as Element).localName === 'Subscript') sub += n.textContent ?? '';
      else base += n.textContent ?? '';
    }
  } else {
    base = e.textContent ?? '';
  }
  const subAttr = e.getAttribute('subscript');
  if (subAttr) sub = sub ? sub + '.' + subAttr : subAttr;
  base = base.trim();
  // Mathcad allows literal subscripts typed with "." in the name itself
  let name = cleanPart(base, false);
  if (!name) name = 'x';
  if (/^[0-9]/.test(name)) name = '_' + name;
  if (sub.trim()) {
    const s = cleanPart(sub.trim(), true);
    if (s) name = name.includes('_') ? `${name}.${s}` : `${name}_${s}`;
  }
  return NAME_FIX[name] ?? name;
}

/* -------------------------------- expressions ------------------------------- */

const BIN: Record<string, BinOp> = {
  plus: '+', minus: '-', mult: '*', div: '/', pow: '^', equal: '==', notEqual: '!=', lessThan: '<',
  greaterThan: '>', lessOrEqual: '<=', greaterOrEqual: '>=', and: 'and', or: 'or', xor: 'xor',
  crossProduct: 'cross',
};

function foldBin(op: BinOp, args: Node[], implicit = false): Node {
  if (args.length < 2) throw new ConvertError(`Operator ${op} mit zu wenigen Operanden`);
  return args.slice(1).reduce((a, b) => ({ k: 'bin', op, a, b, ...(implicit ? { implicit: true } : {}) }) as Node, args[0]);
}

function isPlaceholder(e?: Element) { return !e || e.localName === 'placeholder'; }

export function convertExpr(e: Element, ctx: ConvertCtx): Node {
  switch (local(e)) {
    case 'real': {
      const t = (e.textContent ?? '').trim();
      const v = parseFloat(t);
      return { k: 'num', v, raw: t.replace(/E/g, 'e').replace(/e\+/, 'e') };
    }
    case 'imag': return { k: 'imag', v: parseFloat((e.textContent ?? '').trim()) || 0 };
    case 'str': return { k: 'str', v: e.textContent ?? '' };
    case 'id': {
      const name = idName(e);
      const labels = e.getAttribute('labels') ?? '';
      if (labels === 'UNIT' && ctx.definedNames.has(name)) return { k: 'id', name: `'${name}` };
      if (labels === 'CONSTANT' && !['π', 'e', '∞', 'g'].includes(name)) return { k: 'id', name: `'${name}` };
      if (labels === 'CONSTANT' && ctx.definedNames.has(name)) return name === 'e' ? { k: 'call', name: 'exp', args: [{ k: 'num', v: 1 }] } : { k: 'id', name: `'${name}` };
      return { k: 'id', name };
    }
    case 'placeholder': return { k: 'placeholder' };
    case 'parens': {
      const c = kids(e)[0];
      return c ? { k: 'paren', a: convertExpr(c, ctx) } : { k: 'placeholder' };
    }
    case 'matrix': {
      const rows = parseInt(e.getAttribute('rows') ?? '1', 10);
      const cols = parseInt(e.getAttribute('cols') ?? '1', 10);
      const els = kids(e).filter(c => local(c) !== 'display').map(c => convertExpr(c, ctx));
      // Mathcad stores matrices column by column
      const out: Node[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => els[j * rows + i] ?? { k: 'placeholder' }));
      return { k: 'matrix', rows: out };
    }
    case 'range': {
      const [a, b] = kids(e);
      if (a && local(a) === 'sequence') {
        const [s, sec] = kids(a);
        return { k: 'range', start: convertExpr(s, ctx), second: convertExpr(sec, ctx), end: convertExpr(b, ctx) };
      }
      return { k: 'range', start: convertExpr(a, ctx), end: convertExpr(b, ctx) };
    }
    case 'sequence': {
      // a sequence outside of an argument list – keep the first element
      const c = kids(e);
      if (c.length === 1) return convertExpr(c[0], ctx);
      ctx.warnings.push('Folge außerhalb einer Argumentliste vereinfacht');
      return convertExpr(c[0], ctx);
    }
    case 'apply': return convertApply(e, ctx);
    case 'program': return { k: 'program', body: convertProgram(e, ctx) };
    case 'if': case 'for': case 'while': case 'localDefine': case 'ifThen': case 'tryCatch':
      return { k: 'program', body: convertProgramItems([e], ctx) };
    case 'eval': case 'symEval': {
      const c = kids(e)[0];
      return c ? convertExpr(c, ctx) : { k: 'placeholder' };
    }
    case 'lambda': {
      const body = kids(e).find(c => local(c) !== 'boundVars');
      return body ? convertExpr(body, ctx) : { k: 'placeholder' };
    }
    case 'unitedValue': {
      // literal united value (rare in expressions)
      const r = child(e, 'real');
      return r ? convertExpr(r, ctx) : { k: 'placeholder' };
    }
    default:
      ctx.unknown.add(local(e));
      throw new ConvertError(`Nicht unterstütztes Mathcad-Element „${local(e)}“`);
  }
}

function args(c: Element | undefined, ctx: ConvertCtx): Node[] {
  if (!c) return [];
  if (local(c) === 'sequence') return kids(c).map(x => convertExpr(x, ctx));
  return [convertExpr(c, ctx)];
}

function lambdaParts(lam: Element | undefined, ctx: ConvertCtx): { v?: string; body: Node } {
  if (!lam) throw new ConvertError('Operator ohne Ausdruck');
  if (local(lam) !== 'lambda') return { body: convertExpr(lam, ctx) };
  const bv = child(lam, 'boundVars');
  const idEl = bv ? kids(bv)[0] : undefined;
  const v = idEl && local(idEl) === 'id' ? idName(idEl) : undefined;
  const bodyEl = kids(lam).find(c => local(c) !== 'boundVars');
  return { v, body: bodyEl ? convertExpr(bodyEl, ctx) : { k: 'placeholder' } };
}

function bound(e: Element, name: string, ctx: ConvertCtx): Node | undefined {
  let b = child(e, name);
  if (!b) {
    const bounds = child(e, 'bounds');
    if (bounds) b = kids(bounds)[name === 'lowerBound' ? 0 : 1];
  }
  if (!b) return undefined;
  const inner = local(b) === name ? kids(b)[0] : b;
  if (!inner || local(inner) === 'placeholder') return undefined;
  return convertExpr(inner, ctx);
}

function convertApply(e: Element, ctx: ConvertCtx): Node {
  const [opEl, ...rest] = kids(e);
  if (!opEl) throw new ConvertError('Leere Anwendung');
  const op = local(opEl);
  const conv = (x: Element) => convertExpr(x, ctx);
  if (op === 'id') {
    let name = idName(opEl);
    if (name === 'Find' || name === 'Minerr' || name === 'root' || name === 'if' || name === 'polyroots') name = NAME_FIX[name.toLowerCase()] ?? name;
    return { k: 'call', name, args: args(rest[0], ctx) };
  }
  if (op === 'apply' || op === 'parens') {
    // (f)(x) – apply the result of an expression; only function names are supported
    const f = convertExpr(opEl, ctx);
    const inner = f.k === 'paren' ? f.a : f;
    if (inner.k === 'id') return { k: 'call', name: inner.name, args: args(rest[0], ctx) };
    throw new ConvertError('Funktionsanwendung auf Ausdruck nicht unterstützt');
  }
  if (op in BIN) {
    const a = rest.map(conv);
    if (op === 'minus' && a.length === 1) return { k: 'un', op: 'neg', a: a[0] };
    const CMP = ['<', '>', '<=', '>='];
    const l = a[0];
    if (CMP.includes(BIN[op]) && a.length === 2 && l.k === 'bin' && CMP.includes(l.op)) {
      return { k: 'bin', op: 'and', a: l, b: { k: 'bin', op: BIN[op], a: l.b, b: a[1] } };
    }
    // "5·m": number times unit-like identifier is written as implicit multiplication
    if (op === 'mult' && a.length === 2 && (a[0].k === 'num' || (a[0].k === 'bin' && a[0].op === '/' && a[0].a.k === 'num')) && a[1].k === 'id') return foldBin('*', a, true);
    return foldBin(BIN[op], a, op === 'mult' && opEl.getAttribute('style') === 'space');
  }
  switch (op) {
    case 'scale': {
      // value with unit; an empty unit placeholder (e.g. in data tables) is dropped
      const parts = rest.filter(x => local(x) !== 'placeholder').map(conv);
      return parts.length === 1 ? parts[0] : foldBin('*', parts, true);
    }
    case 'neg': return { k: 'un', op: 'neg', a: conv(rest[0]) };
    case 'not': return { k: 'un', op: 'not', a: conv(rest[0]) };
    case 'absval': return { k: 'un', op: 'abs', a: conv(rest[0]) };
    case 'determinant': return { k: 'un', op: 'abs', a: conv(rest[0]) };
    case 'factorial': return { k: 'un', op: 'fact', a: conv(rest[0]) };
    case 'percent': return { k: 'un', op: 'pct', a: conv(rest[0]) };
    case 'transpose': return { k: 'un', op: 'transpose', a: conv(rest[0]) };
    case 'vectorize': return { k: 'un', op: 'vec', a: conv(rest[0]) };
    case 'sqrt': return { k: 'un', op: 'sqrt', a: conv(rest[0]) };
    case 'nthRoot': {
      if (rest.length === 1) return { k: 'un', op: 'sqrt', a: conv(rest[0]) };
      if (isPlaceholder(rest[0])) return { k: 'un', op: 'sqrt', a: conv(rest[1]) };
      return { k: 'nroot', n: conv(rest[0]), a: conv(rest[1]) };
    }
    case 'indexer': return { k: 'index', a: conv(rest[0]), idx: args(rest[1], ctx) };
    case 'matcol': return { k: 'col', a: conv(rest[0]), j: conv(rest[1]) };
    case 'matrow': return { k: 'call', name: 'row', args: [conv(rest[0]), conv(rest[1])] };
    case 'summation': case 'product': {
      const { v, body } = lambdaParts(rest[0], ctx);
      const lo = bound(e, 'lowerBound', ctx), hi = bound(e, 'upperBound', ctx);
      const iop = op === 'summation' ? 'sum' : 'prod';
      if (!v) return { k: 'iter', op: iop, body };
      if (lo && hi) {
        // Mathcad: Σ with lower bound "i=1" may store an equality
        return { k: 'iter', op: iop, body, v, lo, hi };
      }
      return { k: 'iter', op: iop, body, v };
    }
    case 'integral': {
      const { v, body } = lambdaParts(rest[0], ctx);
      const lo = bound(e, 'lowerBound', ctx), hi = bound(e, 'upperBound', ctx);
      if (!v || !lo || !hi) throw new ConvertError('Unbestimmte Integrale werden nicht unterstützt');
      return { k: 'int', body, v, lo, hi };
    }
    case 'derivative': {
      const { v, body } = lambdaParts(rest[0], ctx);
      if (!v) throw new ConvertError('Ableitung ohne Variable');
      const deg = child(e, 'degree');
      const degEl = deg ? kids(deg)[0] : undefined;
      const order = degEl && local(degEl) === 'real' ? parseFloat(degEl.textContent ?? '1') : 1;
      return { k: 'deriv', body, v, order };
    }
    case 'elementOf': throw new ConvertError('Mengen-Operator ∈ wird nicht unterstützt');
    case 'limit': throw new ConvertError('Grenzwerte (lim) werden nur symbolisch in Mathcad berechnet');
    default:
      ctx.unknown.add(op);
      throw new ConvertError(`Nicht unterstützter Operator „${op}“`);
  }
}

/* --------------------------------- programs --------------------------------- */

function convertProgram(e: Element, ctx: ConvertCtx): Stmt[] {
  return convertProgramItems(kids(e), ctx);
}

function convertProgramItems(items: Element[], ctx: ConvertCtx): Stmt[] {
  const out: Stmt[] = [];
  for (let i = 0; i < items.length; i++) {
    const s = items[i];
    switch (local(s)) {
      case 'localDefine': {
        const [t, v] = kids(s);
        out.push({ k: 'assign', target: convertExpr(t, ctx), value: convertExpr(v, ctx) });
        break;
      }
      case 'if': {
        // Prime: <if><test/><then/><elseif><test/><then/></elseif>…<else/></if>
        const branches: { cond: Node; body: Stmt[] }[] = [];
        let otherwise: Stmt[] | undefined;
        const test = child(s, 'test'), then = child(s, 'then');
        if (test && then) branches.push({ cond: convertExpr(kids(test)[0], ctx), body: block(then, ctx) });
        for (const c of kids(s)) {
          if (local(c) === 'elseif') {
            const t2 = child(c, 'test'), th2 = child(c, 'then');
            if (t2 && th2) branches.push({ cond: convertExpr(kids(t2)[0], ctx), body: block(th2, ctx) });
          } else if (local(c) === 'else') otherwise = block(c, ctx);
        }
        out.push({ k: 'if', branches, otherwise });
        break;
      }
      case 'ifThen': {
        // Mathcad 15: consecutive "value if cond" lines, optionally followed by "otherwise"
        const branches: { cond: Node; body: Stmt[] }[] = [];
        let j = i;
        while (j < items.length && local(items[j]) === 'ifThen') {
          const [c, v] = kids(items[j]);
          branches.push({ cond: convertExpr(c, ctx), body: block(v, ctx) });
          j++;
        }
        let otherwise: Stmt[] | undefined;
        if (j < items.length && local(items[j]) === 'otherwise') { otherwise = block(kids(items[j])[0], ctx); j++; }
        if (otherwise) out.push({ k: 'if', branches, otherwise });
        else for (const b of branches) out.push({ k: 'if', branches: [b] });
        i = j - 1;
        break;
      }
      case 'otherwise': out.push(...block(kids(s)[0], ctx)); break;
      case 'for': {
        const [v, iter, body] = kids(s);
        out.push({ k: 'for', v: idName(v), iter: convertExpr(iter, ctx), body: block(body, ctx) });
        break;
      }
      case 'while': {
        const [c, body] = kids(s);
        const cond = local(c) === 'test' ? kids(c)[0] : c;
        out.push({ k: 'while', cond: convertExpr(cond, ctx), body: block(body, ctx) });
        break;
      }
      case 'return': out.push({ k: 'return', value: convertExpr(kids(s)[0], ctx) }); break;
      case 'break': out.push({ k: 'break' }); break;
      case 'continue': out.push({ k: 'continue' }); break;
      case 'tryCatch': case 'onError': {
        const [a, b] = kids(s);
        out.push({ k: 'try', body: block(a, ctx), onError: b ? block(b, ctx) : [] });
        break;
      }
      default: out.push({ k: 'expr', value: convertExpr(s, ctx) });
    }
  }
  return out;
}

function block(e: Element | undefined, ctx: ConvertCtx): Stmt[] {
  if (!e) return [];
  if (local(e) === 'program') return convertProgram(e, ctx);
  if (['then', 'else', 'try', 'catch', 'tryBlock', 'catchBlock'].includes(local(e))) {
    const c = kids(e);
    if (c.length === 1 && local(c[0]) === 'program') return convertProgram(c[0], ctx);
    return convertProgram(e, ctx);
  }
  return [{ k: 'expr', value: convertExpr(e, ctx) }];
}

/* -------------------------------- statements -------------------------------- */

function convertTarget(e: Element, ctx: ConvertCtx): DefTarget {
  switch (local(e)) {
    case 'id': return { name: idName(e) };
    case 'function': {
      const [f, bv] = kids(e);
      return { name: idName(f), params: bv ? kids(bv).map(idName) : [] };
    }
    case 'apply': {
      const [op, a, i] = kids(e);
      if (local(op) === 'indexer' && local(a) === 'id') return { name: idName(a), index: args(i, ctx) };
      break;
    }
    case 'matrix': {
      const items = kids(e).filter(c => local(c) !== 'display');
      const multi = items.map(c => convertExpr(c, ctx));
      if (multi.every(n => n.k === 'id' || (n.k === 'index' && n.a.k === 'id'))) {
        const f = multi[0];
        return { name: f.k === 'id' ? f.name : (f as { a: { name: string } }).a.name, multi };
      }
      break;
    }
  }
  throw new ConvertError('Nicht unterstützte linke Seite einer Definition');
}

function unitOverride(e: Element, ctx: ConvertCtx): Node | undefined {
  const u = child(e, 'unitOverride');
  const c = u ? kids(u)[0] : undefined;
  if (!c || local(c) === 'placeholder') return undefined;
  return convertExpr(c, ctx);
}

export interface ConvertedMath { stmt: MathStmt; symbolic?: Node; resultEl?: Element }

/** Convert the content of a <math> element. */
export function convertMathElement(math: Element, ctx: ConvertCtx): ConvertedMath {
  let top = kids(math).find(c => !['resultFormat', 'formattingOverride', 'rendering', 'provenance'].includes(local(c)));
  if (top && local(top) === 'provenance') top = kids(top).find(c => ['define', 'eval', 'globalDefine', 'apply', 'id', 'symEval'].includes(local(c)));
  const prov = child(math, 'provenance');
  if (!top && prov) top = kids(prov).find(c => ['define', 'eval', 'globalDefine', 'apply', 'id', 'symEval'].includes(local(c)));
  if (!top) return { stmt: { kind: 'empty' } };
  switch (local(top)) {
    case 'define': case 'globalDefine': {
      const [lhs, rhs] = kids(top);
      const target = convertTarget(lhs, ctx);
      const global = local(top) === 'globalDefine';
      if (rhs && local(rhs) === 'eval') {
        const exprEl = kids(rhs)[0];
        return {
          stmt: { kind: 'define', target, global, expr: convertExpr(exprEl, ctx), show: { unit: unitOverride(rhs, ctx) } },
          resultEl: child(rhs, 'result'),
        };
      }
      if (rhs && /Control$/.test(local(rhs))) {
        const v = controlValue(rhs, target, ctx);
        if (v) return { stmt: { kind: 'define', target, global, expr: v } };
        throw new ConvertError(`Eingabe-Steuerelement „${local(rhs)}“ wird nicht unterstützt`);
      }
      if (rhs && local(rhs) === 'symEval') {
        const sr = child(rhs, 'symResult');
        const srExpr = sr ? kids(sr)[0] : undefined;
        if (srExpr) return { stmt: { kind: 'define', target, global, expr: convertExpr(srExpr, ctx) } };
        return { stmt: { kind: 'define', target, global, expr: convertExpr(kids(rhs)[0], ctx) } };
      }
      return { stmt: { kind: 'define', target, global, expr: convertExpr(rhs, ctx) } };
    }
    case 'eval': {
      const exprEl = kids(top)[0];
      return { stmt: { kind: 'eval', expr: convertExpr(exprEl, ctx), unit: unitOverride(top, ctx) }, resultEl: child(top, 'result') };
    }
    case 'symEval': {
      const exprEl = kids(top)[0];
      const sr = child(top, 'symResult');
      const srExpr = sr ? kids(sr)[0] : undefined;
      let symbolic: Node | undefined;
      try { symbolic = srExpr ? convertExpr(srExpr, ctx) : undefined; } catch { symbolic = undefined; }
      return { stmt: { kind: 'expr', expr: convertExpr(exprEl, ctx) }, symbolic };
    }
    default:
      return { stmt: { kind: 'expr', expr: convertExpr(top, ctx) } };
  }
}

/** Current value of a Prime input control (combo box, list box, slider, …). */
function controlValue(e: Element, target: DefTarget, ctx: ConvertCtx): Node | null {
  if (local(e) === 'ComboBoxControl') {
    const rows = parseInt(e.getAttribute('rows') ?? '1', 10);
    const cols = parseInt(e.getAttribute('cols') ?? '1', 10);
    const sel = parseInt(e.getAttribute('SelectedRow') ?? '0', 10);
    const valsEl = child(e, 'ComboBoxValues');
    const scaleEl = child(e, 'ComboBoxScaleFactors');
    if (!valsEl) return null;
    const vals = kids(valsEl);
    const scales = scaleEl ? kids(scaleEl) : [];
    const names = child(e, 'ComboBoxRowNames');
    const label = names ? kids(names)[sel]?.textContent : undefined;
    if (rows < 1 || sel >= rows) return null;
    const out: Node[] = [];
    for (let j = 0; j < cols; j++) {
      const el = vals[sel * cols + j];
      if (!el) return null;
      let n = convertExpr(el, ctx);
      const sc = scales[j];
      if (sc && local(sc) !== 'placeholder') n = { k: 'bin', op: '*', a: n, b: convertExpr(sc, ctx), implicit: true };
      out.push(n);
    }
    ctx.warnings.push(`Auswahlliste für ${target.multi ? 'mehrere Variablen' : target.name} als feste Werte übernommen${label ? ` (Auswahl „${label}“)` : ''}`);
    return out.length === 1 ? out[0] : { k: 'matrix', rows: out.map(x => [x]) };
  }
  const rl = e.getAttribute('RL');
  if (rl) {
    try {
      const txt = atob(rl);
      const nums = [...txt.matchAll(/\(number ([-0-9.eE+]+)/g)].map(m => parseFloat(m[1]));
      const strs = [...txt.matchAll(/\(string "((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
      ctx.warnings.push(`Steuerelement für ${target.name} als fester Wert übernommen`);
      if (nums.length === 1 && !strs.length) return { k: 'num', v: nums[0] };
      if (strs.length === 1 && !nums.length) return { k: 'str', v: strs[0] };
      if (nums.length > 1) return { k: 'matrix', rows: nums.map(v => [{ k: 'num', v } as Node]) };
    } catch { /* ignore */ }
  }
  return null;
}

/** Collect all names defined in a document (definitions, parameters, locals). */
export function collectDefinedNames(root: Element): Set<string> {
  const out = new Set<string>();
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    const ln = e.localName;
    if (ln === 'define' || ln === 'globalDefine' || ln === 'localDefine') {
      const lhs = e.children[0];
      if (!lhs) continue;
      if (lhs.localName === 'id') out.add(idName(lhs));
      else if (lhs.localName === 'function') {
        const [f, bv] = Array.from(lhs.children);
        if (f) out.add(idName(f));
        if (bv) for (const p of Array.from(bv.children)) if (p.localName === 'id') out.add(idName(p));
      } else if (lhs.localName === 'apply') {
        const a = lhs.children[1];
        if (a?.localName === 'id') out.add(idName(a));
      } else if (lhs.localName === 'matrix') {
        for (const c of Array.from(lhs.children)) {
          if (c.localName === 'id') out.add(idName(c));
          else if (c.localName === 'apply' && c.children[1]?.localName === 'id') out.add(idName(c.children[1]));
        }
      }
    } else if (ln === 'boundVars' && e.parentElement?.localName === 'lambda') {
      for (const p of Array.from(e.children)) if (p.localName === 'id') out.add(idName(p));
    } else if (ln === 'for') {
      const v = e.children[0];
      if (v?.localName === 'id') out.add(idName(v));
    }
  }
  return out;
}

export { ConvertError };
