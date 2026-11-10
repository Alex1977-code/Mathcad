/**
 * Export to Mathcad Prime (.mcdx). The formulas are written in Prime's math XML (schemas.mathsoft.com/
 * math50) in exactly the forms Prime itself writes (taken from real Prime files): definitions,
 * evaluations with display units, functions, programs, solve blocks (Given … Find become a Prime solve
 * block with guess values, constraints and solver), matrices, ranges, sums, integrals, derivatives.
 * Text regions become XAML flow documents, pictures PNG parts. Plots cannot be written in Prime's chart
 * format; they are replaced by a note (listed in the warnings). Prime recalculates the document on open.
 */
import JSZip from 'jszip';
import { walk, type DefTarget, type MathStmt, type Node, type Stmt } from '../engine/ast';
import { parseExpression, parseMathRegion } from '../engine/parser';
import { sortRegions, safeImageSrc, type MathRegion, type Region, type Worksheet } from '../engine/model';
import { isBuiltinFunction } from '../engine/builtins';
import { lookupUnit } from '../engine/units';
import { APP_XML, CALCULATION_XML, PRESENTATION_XML } from './mcdxTemplate';

const NS_WS = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ve="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:ws="http://schemas.mathsoft.com/worksheet50" xmlns:ml="http://schemas.mathsoft.com/math50" xmlns:u="http://schemas.mathsoft.com/units10" xmlns:p="http://schemas.mathsoft.com/provenance10" xmlns="http://schemas.mathsoft.com/worksheet50"';
const XAML_NS = 'http://schemas.microsoft.com/winfx/2006/xaml/presentation';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (v: number) => (Number.isFinite(v) ? String(v).replace('e+', 'E+').replace('e-', 'E-') : v > 0 ? '1E+307' : '-1E+307');

class ExportError extends Error {}
type DomNode = globalThis.Node;

/** Names Prime writes as keywords. */
const KEYWORDS: Record<string, string> = { Find: 'find', find: 'find', Minerr: 'minerr', minerr: 'minerr', Maximize: 'maximize', Minimize: 'minimize' };
const CONSTANTS = new Set(['π', 'e', '∞', 'g']);

interface Ctx { defined: Set<string>; warnings: string[]; /** Parameters, bound and local variables in scope. */ local: Set<string>[] }

const isLocal = (ctx: Ctx, n: string) => ctx.local.some(s => s.has(n));
function scoped<T>(ctx: Ctx, names: string[], fn: () => T): T { ctx.local.push(new Set(names)); try { return fn(); } finally { ctx.local.pop(); } }

/* ------------------------------- identifiers -------------------------------- */

function idXml(name: string, ctx: Ctx, role: 'var' | 'fn' | 'auto' = 'auto'): string {
  let label: string;
  let n = name;
  if (n.startsWith("'")) { n = n.slice(1); label = lookupUnit(n, true) !== null ? 'UNIT' : 'CONSTANT'; }
  else if (isLocal(ctx, n)) label = 'VARIABLE';
  else if (role === 'fn') label = ctx.defined.has(n) ? 'VARIABLE' : 'FUNCTION';
  else if (role === 'var' || ctx.defined.has(n)) label = 'VARIABLE';
  else if (CONSTANTS.has(n)) label = 'CONSTANT';
  else if (lookupUnit(n) !== null) label = 'UNIT';
  else if (isBuiltinFunction(n)) label = 'FUNCTION';
  else label = 'VARIABLE';
  // literal subscript: F_max → F with subscript max (Prime stores it as a XAML span)
  const u = n.indexOf('_');
  if (u > 0 && u < n.length - 1 && label !== 'UNIT') {
    const base = n.slice(0, u), sub = n.slice(u + 1);
    return `<ml:id labels="${label}" xml:space="preserve"><Span xmlns="${XAML_NS}" xmlns:pw="clr-namespace:Ptc.Wpf;assembly=Ptc.Core">${esc(base)}<pw:Subscript>${esc(sub)}</pw:Subscript></Span></ml:id>`;
  }
  return `<ml:id labels="${label}" xml:space="preserve">${esc(n)}</ml:id>`;
}

/* -------------------------------- expressions ------------------------------- */

const BIN: Record<string, string> = {
  '+': 'plus', '-': 'minus', '*': 'mult', '/': 'div', '^': 'pow', '==': 'equal', '!=': 'notEqual', '<': 'lessThan', '>': 'greaterThan',
  '<=': 'lessOrEqual', '>=': 'greaterOrEqual', and: 'and', or: 'or', xor: 'xor', cross: 'crossProduct',
};
const UN: Record<string, string> = { neg: 'neg', not: 'not', fact: 'factorial', pct: 'percent', transpose: 'transpose', abs: 'absval', sqrt: 'sqrt', vec: 'vectorize' };

const apply = (op: string, ...args: string[]) => `<ml:apply><ml:${op} />${args.join('')}</ml:apply>`;
const seq = (xs: string[]) => (xs.length === 1 ? xs[0] : `<ml:sequence>${xs.join('')}</ml:sequence>`);
const isUnitId = (n: Node, ctx: Ctx) => n.k === 'id' && (n.name.startsWith("'") || (!ctx.defined.has(n.name) && lookupUnit(n.name) !== null));

function X(n: Node, ctx: Ctx): string {
  switch (n.k) {
    case 'num': return `<ml:real>${fmt(n.v)}</ml:real>`;
    case 'imag': return `<ml:imag symbol="i">${fmt(n.v)}</ml:imag>`;
    case 'str': return `<ml:str xml:space="preserve">${esc(n.v)}</ml:str>`;
    case 'id': return idXml(n.name, ctx);
    case 'placeholder': return '<ml:placeholder />';
    case 'paren': return `<ml:parens>${X(n.a, ctx)}</ml:parens>`;
    case 'bin': {
      // 5 m, 2.5 kN: a number with a unit is a scaled value in Prime
      if (n.op === '*' && n.implicit && isUnitId(n.b, ctx)) return apply('scale', X(n.a, ctx), X(n.b, ctx));
      return apply(BIN[n.op], X(n.a, ctx), X(n.b, ctx));
    }
    case 'un': return apply(UN[n.op], X(n.a, ctx));
    case 'nroot': return apply('nthRoot', X(n.n, ctx), X(n.a, ctx));
    case 'call': {
      if (n.name === 'row' && n.args.length === 2) return apply('matrow', X(n.args[0], ctx), X(n.args[1], ctx));
      const kw = KEYWORDS[n.name];
      const fn = kw ? `<ml:id labels="KEYWORD" algorithm="" xml:space="preserve">${kw}</ml:id>` : idXml(n.name, ctx, 'fn');
      return `<ml:apply>${fn}${seq(n.args.map(a => X(a, ctx)))}</ml:apply>`;
    }
    case 'index': return apply('indexer', X(n.a, ctx), seq(n.idx.map(a => X(a, ctx))));
    case 'col': return apply('matcol', X(n.a, ctx), X(n.j, ctx));
    case 'matrix': {
      const rows = n.rows.length, cols = Math.max(...n.rows.map(r => r.length));
      const els: string[] = [];
      for (let j = 0; j < cols; j++) for (let i = 0; i < rows; i++) els.push(n.rows[i][j] ? X(n.rows[i][j], ctx) : '<ml:placeholder />');   // column by column
      return `<ml:matrix rows="${rows}" cols="${cols}">${els.join('')}</ml:matrix>`;
    }
    case 'range': return n.second
      ? `<ml:range><ml:sequence>${X(n.start, ctx)}${X(n.second, ctx)}</ml:sequence>${X(n.end, ctx)}</ml:range>`
      : `<ml:range>${X(n.start, ctx)}${X(n.end, ctx)}</ml:range>`;
    case 'iter': {
      const op = n.op === 'sum' ? 'summation' : 'product';
      const bv = n.v ? idXml(n.v, ctx, 'var') : '<ml:placeholder />';
      const lam = `<ml:lambda><ml:boundVars>${bv}</ml:boundVars>${scoped(ctx, n.v ? [n.v] : [], () => X(n.body, ctx))}</ml:lambda>`;
      if (n.v && n.lo && n.hi) return `<ml:apply><ml:${op} />${lam}<ml:lowerBound>${X(n.lo, ctx)}</ml:lowerBound><ml:upperBound>${X(n.hi, ctx)}</ml:upperBound></ml:apply>`;
      if (!n.v) return `<ml:apply><ml:${op} />${lam}<ml:upperBound><ml:placeholder /></ml:upperBound></ml:apply>`;
      return `<ml:apply><ml:${op} />${lam}</ml:apply>`;
    }
    case 'int': {
      if (!n.lo || !n.hi) { ctx.warnings.push('Unbestimmtes Integral: in Mathcad nur symbolisch'); }
      const lam = `<ml:lambda><ml:boundVars>${idXml(n.v, ctx, 'var')}</ml:boundVars>${scoped(ctx, [n.v], () => X(n.body, ctx))}</ml:lambda>`;
      return `<ml:apply><ml:integral />${lam}${n.lo ? `<ml:lowerBound>${X(n.lo, ctx)}</ml:lowerBound>` : ''}${n.hi ? `<ml:upperBound>${X(n.hi, ctx)}</ml:upperBound>` : ''}</ml:apply>`;
    }
    case 'deriv': {
      const lam = `<ml:lambda><ml:boundVars>${idXml(n.v, ctx, 'var')}</ml:boundVars>${scoped(ctx, [n.v], () => X(n.body, ctx))}</ml:lambda>`;
      return `<ml:apply><ml:derivative />${lam}${n.order && n.order !== 1 ? `<ml:degree><ml:real>${n.order}</ml:real></ml:degree>` : ''}</ml:apply>`;
    }
    case 'program': return program(n.body, ctx);
  }
}

/* --------------------------------- programs --------------------------------- */

/** Local definitions (←) and loop variables are variables for the rest of the program. */
const localNames = (body: Stmt[]): string[] => {
  const out: string[] = [];
  const visit = (ss: Stmt[]) => ss.forEach(st => {
    if (st.k === 'assign') { const t = st.target; if (t.k === 'id') out.push(t.name); else if (t.k === 'index' && t.a.k === 'id') out.push(t.a.name); else if (t.k === 'matrix') t.rows.flat().forEach(c => c.k === 'id' && out.push(c.name)); }
    if (st.k === 'for') { out.push(st.v); visit(st.body); }
    if (st.k === 'while') visit(st.body);
    if (st.k === 'if') { st.branches.forEach(b => visit(b.body)); if (st.otherwise) visit(st.otherwise); }
    if (st.k === 'try') { visit(st.body); visit(st.onError); }
  });
  visit(body);
  return out;
};
const program = (body: Stmt[], ctx: Ctx) => scoped(ctx, localNames(body), () => `<ml:program>${body.map(s => stmt(s, ctx)).join('')}</ml:program>`);

function stmt(s: Stmt, ctx: Ctx): string {
  switch (s.k) {
    case 'assign': return `<ml:localDefine>${X(s.target, ctx)}${X(s.value, ctx)}</ml:localDefine>`;
    case 'expr': return X(s.value, ctx);
    case 'return': return `<ml:return>${X(s.value, ctx)}</ml:return>`;
    case 'break': return '<ml:break />';
    case 'continue': return '<ml:continue />';
    case 'for': return `<ml:for>${idXml(s.v, ctx, 'var')}${X(s.iter, ctx)}${program(s.body, ctx)}</ml:for>`;
    case 'while': return `<ml:while><ml:test>${X(s.cond, ctx)}</ml:test>${program(s.body, ctx)}</ml:while>`;
    case 'try': return `<ml:tryCatch>${program(s.body, ctx)}${program(s.onError, ctx)}</ml:tryCatch>`;
    case 'if': {
      if (s.branches.some(b => b.also)) ctx.warnings.push('„also if“ als „else if“ geschrieben');
      const [first, ...rest] = s.branches;
      return `<ml:if><ml:test>${X(first.cond, ctx)}</ml:test><ml:then>${program(first.body, ctx)}</ml:then>`
        + rest.map(b => `<ml:elseif><ml:test>${X(b.cond, ctx)}</ml:test><ml:then>${program(b.body, ctx)}</ml:then></ml:elseif>`).join('')
        + (s.otherwise ? `<ml:else>${program(s.otherwise, ctx)}</ml:else>` : '') + '</ml:if>';
    }
  }
}

/* -------------------------------- statements -------------------------------- */

function target(t: DefTarget, ctx: Ctx): string {
  if (t.multi) {
    return `<ml:matrix rows="${t.multi.length}" cols="1">${t.multi.map(m => X(m, ctx)).join('')}</ml:matrix>`;
  }
  if (t.params) return `<ml:function>${idXml(t.name, ctx, 'var')}<ml:boundVars>${t.params.map(p => idXml(p, ctx, 'var')).join('')}</ml:boundVars></ml:function>`;
  if (t.index) return apply('indexer', idXml(t.name, ctx, 'var'), seq(t.index.map(i => X(i, ctx))));
  return idXml(t.name, ctx, 'var');
}

const evalXml = (expr: string, unit: Node | undefined, ctx: Ctx) =>
  `<ml:eval>${expr}<ml:unitOverride>${unit ? X(unit, ctx) : '<ml:placeholder />'}</ml:unitOverride></ml:eval>`;

function mathXml(st: MathStmt, ctx: Ctx): string {
  switch (st.kind) {
    case 'define': {
      const body = scoped(ctx, st.target.params ?? [], () => X(st.expr, ctx));
      const rhs = st.show ? evalXml(body, st.show.unit, ctx) : body;
      return `<ml:${st.global ? 'globalDefine' : 'define'}>${target(st.target, ctx)}${rhs}</ml:${st.global ? 'globalDefine' : 'define'}>`;
    }
    case 'eval':
      if (st.sym) { ctx.warnings.push('Symbolische Auswertung „→“ als numerische Auswertung geschrieben'); }
      return evalXml(X(st.expr, ctx), st.unit, ctx);
    case 'expr': return X(st.expr, ctx);
    case 'empty': throw new ExportError('leer');
  }
}

/* ----------------------------------- text ----------------------------------- */

/** Our text HTML → XAML section (paragraphs with bold/italic/underline/colour/size). */
function htmlToXaml(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const paras: string[] = [];
  let cur = '';
  let pAttrs = '';
  const flush = () => { if (cur || pAttrs) paras.push(`<Paragraph${pAttrs}>${cur}</Paragraph>`); cur = ''; pAttrs = ''; };
  const inline = (n: DomNode): string => {
    if (n.nodeType === 3) return (n.textContent ?? '') ? `<Run>${esc((n.textContent ?? '').replace(/\s+/g, ' '))}</Run>` : '';
    if (n.nodeType !== 1) return '';
    const el = n as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const kids = () => Array.from(el.childNodes).map(inline).join('');
    if (tag === 'br') return '<LineBreak />';
    const style = el.getAttribute('style') ?? '';
    const color = /(?:^|;)\s*color:\s*([^;]+)/i.exec(style)?.[1]?.trim();
    const size = /font-size:\s*([\d.]+)px/i.exec(style)?.[1];
    let inner = kids();
    if (color || size) inner = `<Span${color && /^#[0-9a-f]{6}$/i.test(color) ? ` Foreground="#FF${color.slice(1).toUpperCase()}"` : ''}${size ? ` FontSize="${size}"` : ''}>${inner}</Span>`;
    if (tag === 'b' || tag === 'strong') return `<Bold>${inner}</Bold>`;
    if (tag === 'i' || tag === 'em') return `<Italic>${inner}</Italic>`;
    if (tag === 'u') return `<Underline>${inner}</Underline>`;
    if (tag === 'sub') return `<Span Typography.Variants="Subscript">${inner}</Span>`;
    if (tag === 'sup') return `<Span Typography.Variants="Superscript">${inner}</Span>`;
    return inner;
  };
  const block = (n: DomNode) => {
    if (n.nodeType === 1) {
      const el = n as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'li', 'blockquote'].includes(tag)) {
        flush();
        if (/^h[1-4]$/.test(tag)) pAttrs = ` FontWeight="Bold" FontSize="${({ h1: 24, h2: 20, h3: 17, h4: 15 } as Record<string, number>)[tag]}"`;
        const al = /text-align:\s*(left|center|right|justify)/i.exec(el.getAttribute('style') ?? '')?.[1];
        if (al) pAttrs += ` TextAlignment="${al[0].toUpperCase() + al.slice(1)}"`;
        if (tag === 'li') cur += '<Run>• </Run>';
        el.childNodes.forEach(c => (c.nodeType === 1 && ['ul', 'ol', 'p', 'div', 'li'].includes((c as HTMLElement).tagName.toLowerCase()) ? block(c) : (cur += inline(c))));
        flush();
        return;
      }
      if (tag === 'ul' || tag === 'ol') { el.childNodes.forEach(block); return; }
    }
    cur += inline(n);
  };
  doc.body.firstChild!.childNodes.forEach(block);
  flush();
  if (!paras.length) paras.push('<Paragraph />');
  return `<Section xmlns="${XAML_NS}" xml:space="preserve" TextAlignment="Left" FontFamily="Tahoma" FontSize="14.666666666666668" Foreground="#FF000000">${paras.join('')}</Section>`;
}

async function xamlPackage(xaml: string): Promise<Uint8Array> {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xaml" ContentType="application/vnd.ms-wpf.xaml+xml" /><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" /></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.microsoft.com/wpf/2005/10/xaml/entry" Target="/Xaml/Document.xaml" Id="R0" /></Relationships>');
  z.file('Xaml/Document.xaml', xaml);
  return z.generateAsync({ type: 'uint8array' });
}

/* ----------------------------------- plots ---------------------------------- */

/** X-Y plot in Prime's chart XML (as Prime writes it: traces, axes with equations, units and domain). */
function plotXml(r: Region & { type: 'plot' }, ctx: Ctx, nextRef: () => number): string | null {
  const expr = (t: string | undefined): string | null => {
    if (!t || !t.trim()) return null;
    try { return X(parseExpression(t, true), ctx); } catch { return null; }
  };
  const traces = r.traces.map(t => ({ t, x: expr(t.x), y: expr(t.y) })).filter(q => q.x && q.y);
  if (!traces.length) return null;
  const xu = expr(r.xUnit) ?? '<ml:placeholder />', yu = expr(r.yUnit) ?? '<ml:placeholder />';
  const color = (c: string | undefined, i: number) => {
    const hex = /^#([0-9a-f]{6})$/i.exec(c ?? '')?.[1] ?? ['1F4FD8', 'D64545', '2E9E5B', 'D98C1F', '7A4FC9', '1A9AA8'][i % 6];
    return `#FF${hex.toUpperCase()}`;
  };
  const style = (s: string | undefined) => (s === 'points' ? ['points', 'circle'] : s === 'both' ? ['lines', 'circle'] : ['lines', 'none']);
  const tr = traces.map(({ t }, i) => {
    const [kind, sym] = style(t.style);
    return `<trace resultRef="${nextRef()}"><traceStyle color="${color(t.color, i)}" symbol="${sym}" line-weight="1" line-style="Solid">${kind}</traceStyle></trace>`;
  }).join('');
  const domain = (log: boolean | undefined, lo?: string, hi?: string) => {
    const a = expr(lo), b = expr(hi);
    return `<xyDomain scale-type="${log ? 'log' : 'linear'}" auto-scale="${a && b ? 'false' : 'true'}"><startValue>${a ?? '<ml:placeholder />'}</startValue><endValue>${b ?? '<ml:placeholder />'}</endValue></xyDomain>`;
  };
  const axis = (tag: 'xAxis' | 'yAxis', eqs: string[], unit: string, log: boolean | undefined, lo?: string, hi?: string) =>
    `<${tag} rank="1" legend-position="${tag === 'xAxis' ? 'PlotBoundaryBottom' : 'PlotBoundaryRight'}"><axisLine position="origin" /><axisGrid><gridFrequency>11</gridFrequency><gridLabels display="true" /><gridLines /><tickMarks display="true" /></axisGrid><axisLabel /><markers />`
    + `<plotEquations>${eqs.map(e => `<plotEquation><math>${e}</math><math>${unit}</math></plotEquation>`).join('')}</plotEquations>${domain(log, lo, hi)}</${tag}>`;
  const w = (r.w ?? 440) - 90, h = (r.h ?? 270) - 60;
  return `<plot origin-positioning="true"><xyPlot><title />${r.title ? '' : ''}<legend /><traces>${tr}</traces><graph-size width="${w}" height="${h}" /><axes>`
    + axis('xAxis', traces.map(q => q.x!), xu, r.logX, r.xmin, r.xmax) + axis('yAxis', traces.map(q => q.y!), yu, r.logY, r.ymin, r.ymax)
    + '</axes></xyPlot></plot>';
}

/* -------------------------------- document --------------------------------- */

export interface McdxResult { blob: Blob; warnings: string[] }

const isGiven = (r: Region) => r.type === 'math' && /^\s*given\s*$/i.test(r.src);
/** Unknowns of a Find/Minerr call in a formula, or null. */
const findCall = (st: MathStmt | null): string[] | null => {
  if (!st || st.kind === 'empty') return null;
  let names: string[] | null = null;
  walk(st.expr, n => {
    if (n.k === 'call' && (KEYWORDS[n.name] === 'find' || KEYWORDS[n.name] === 'minerr')) names = n.args.filter(a => a.k === 'id').map(a => (a as { name: string }).name);
  });
  return names;
};

export async function buildMcdx(ws: Worksheet): Promise<McdxResult> {
  const warnings: string[] = [];
  const ctx: Ctx = { defined: new Set(), warnings, local: [] };
  const order = sortRegions(ws.regions);
  const parsed = new Map<string, MathStmt | null>();
  for (const r of order) {
    if (r.type !== 'math' || isGiven(r)) continue;
    let st: MathStmt | null = null;
    try { st = parseMathRegion(r.src); } catch { st = null; }
    parsed.set(r.id, st);
    if (st?.kind === 'define') ctx.defined.add(st.target.name);
  }

  const rels: string[] = [];
  const parts: { path: string; data: Uint8Array | string }[] = [];
  let regionId = 0, resultId = 0, relId = 0, textN = 0, imgN = 0;
  const results: string[] = [];
  const rid = () => `R${(++relId).toString(16).padStart(8, '0')}fw`;
  const geom = (r: Region, ox = 0, oy = 0, extra = '') => {
    const w = r.w ?? 200, h = r.h ?? 26;
    return `region-id="${regionId++}" actualWidth="${w}" actualHeight="${h}" top="${(r.y - oy).toFixed(3)}" left="${(r.x - ox).toFixed(3)}"${extra}`;
  };
  const mathRegion = (r: MathRegion, ox = 0, oy = 0, category?: string): string | null => {
    const st = parsed.get(r.id);
    if (!st || st.kind === 'empty') {
      if (r.src.trim()) warnings.push(`Formel nicht übertragbar (als Text übernommen): ${r.src.split('\n')[0]}`);
      return null;
    }
    let xml: string;
    try { xml = mathXml(st, ctx); } catch (e) { warnings.push(`Formel nicht übertragbar: ${r.src.split('\n')[0]} (${(e as Error).message})`); return null; }
    const ref = resultId++;
    results.push(`<resultData result-id="${ref}" calculation-status="Pending"><ml:result /></resultData>`);
    const disabled = r.disabled ? ' disabled="true"' : '';
    return `<region ${geom(r, ox, oy, category ? ` solve-block-category="${category}"` : '')}${disabled}><math resultRef="${ref}">${xml}</math></region>`;
  };
  const textRegion = async (r: Region, html: string, ox = 0, oy = 0): Promise<string> => {
    const id = rid();
    const name = `FlowDocument${++textN}.XamlPackage`;
    parts.push({ path: `mathcad/xaml/${name}`, data: await xamlPackage(htmlToXaml(html)) });
    rels.push(`<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/flowDocument" Target="/mathcad/xaml/${name}" Id="${id}" />`);
    return `<region ${geom({ ...r, w: r.w ?? 300 }, ox, oy)} width="${r.w ?? 300}"><text item-idref="${id}"><FlowDocument FontFamily="Tahoma" FontSize="14.666666666666668" xmlns="${XAML_NS}" /></text></region>`;
  };

  // solve blocks first: Given + constraints up to the formula with Find/Minerr; the guess values are the
  // regions marked as such on import, otherwise the last definitions of the unknowns before Given
  const blocks = new Map<string, { members: { r: MathRegion; cat: string }[] }>();
  const used = new Set<string>();
  order.forEach((r, i) => {
    if (!isGiven(r)) return;
    const members: { r: MathRegion; cat: string }[] = [];
    let unknowns: string[] | null = null;
    for (let j = i + 1; j < order.length; j++) {
      const q = order[j];
      if (q.type !== 'math' || isGiven(q)) break;
      unknowns = findCall(parsed.get(q.id) ?? null);
      members.push({ r: q, cat: unknowns ? 'solver' : 'constraint' });
      if (unknowns) break;
    }
    if (!unknowns) { warnings.push('„Given“ ohne Find/Minerr – als einzelne Formeln übernommen'); return; }
    const guesses: MathRegion[] = [];
    for (let k = i - 1; k >= 0 && order[k].type === 'math' && (order[k] as MathRegion).guess; k--) guesses.unshift(order[k] as MathRegion);
    if (!guesses.length) {
      for (const u of unknowns) {
        for (let k = i - 1; k >= 0; k--) {
          const g = order[k];
          const st = g.type === 'math' ? parsed.get(g.id) : null;
          if (st?.kind === 'define' && st.target.name === u && !st.target.params) { if (!used.has(g.id)) guesses.push(g as MathRegion); break; }
        }
      }
    }
    const all = [...guesses.map(g => ({ r: g, cat: 'guess-value' })), ...members];
    for (const m of all) used.add(m.r.id);
    blocks.set(r.id, { members: all });
  });

  const out: string[] = [];
  for (let i = 0; i < order.length; i++) {
    const r = order[i];
    if (used.has(r.id)) continue;
    const block = blocks.get(r.id);
    if (block) {
      const all = block.members;
      const x0 = Math.min(...all.map(m => m.r.x), r.x) - 19.2, y0 = Math.min(...all.map(m => m.r.y), r.y) - 19.2;
      const inner = all.map(m => mathRegion(m.r, x0, y0, m.cat)).filter(Boolean).join('');
      const w = Math.max(...all.map(m => m.r.x + (m.r.w ?? 200))) - x0 + 19.2;
      const h = Math.max(...all.map(m => m.r.y + (m.r.h ?? 30))) - y0 + 19.2;
      out.push(`<region region-id="${regionId++}" height="${h}" width="${w}" actualWidth="${w}" actualHeight="${h}" top="${y0.toFixed(3)}" left="${x0.toFixed(3)}"><solveblock><regions>${inner}</regions></solveblock></region>`);
      continue;
    }
    if (isGiven(r)) continue;
    switch (r.type) {
      case 'math': {
        const m = mathRegion(r);
        out.push(m ?? await textRegion(r, esc(r.src).replace(/\n/g, '<br>')));
        break;
      }
      case 'text': out.push(await textRegion(r, r.html)); break;
      case 'image': {
        const src = safeImageSrc(r.src);
        // Prime identifies the picture format by its content (its own files keep BMPs in ".png" parts)
        const mm = src ? /^data:image\/[a-z]+;base64,([\s\S]*)$/i.exec(src) : null;
        if (!mm) { warnings.push('Bild nicht übernommen (unbekanntes Format)'); break; }
        const id = rid(), name = `Image${++imgN}.png`;
        const bin = atob(mm[1].replace(/\s+/g, '')); const bytes = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
        parts.push({ path: `mathcad/media/${name}`, data: bytes });
        rels.push(`<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="/mathcad/media/${name}" Id="${id}" />`);
        const w = r.w ?? 300, h = r.h ?? 200;
        out.push(`<region ${geom({ ...r, w, h })}><picture><png item-idref="${id}" display-width="${w}" display-height="${h}" /></picture></region>`);
        break;
      }
      case 'plot': {
        const xml = plotXml(r, ctx, () => { const ref = resultId++; results.push(`<resultData result-id="${ref}" calculation-status="Pending"><ml:result /></resultData>`); return ref; });
        if (xml) { out.push(`<region ${geom({ ...r, w: r.w ?? 440, h: r.h ?? 270 })} width="${r.w ?? 440}" height="${r.h ?? 270}">${xml}</region>`); break; }
        const traces = r.traces.map(t => `${t.y} über ${t.x}`).join('; ');
        warnings.push(`Diagramm als Hinweistext übernommen (${traces || 'leer'}) – in Mathcad neu einfügen`);
        out.push(await textRegion(r, `<i>[Diagramm aus FormelWerk: ${esc(traces)}]</i>`));
        break;
      }
      case 'pagebreak': out.push(`<region region-id="${regionId++}" height="2" actualWidth="793.7" actualHeight="2" top="${r.y.toFixed(3)}" left="0"><pageBreak /></region>`); break;
    }
  }

  const worksheetXml = `<?xml version="1.0" encoding="utf-8"?><worksheet msg-id="NoMessage" ${NS_WS}><regions>${out.join('')}</regions></worksheet>`;
  const resultXml = `<?xml version="1.0" encoding="utf-8"?><resultsList xmlns:ml="http://schemas.mathsoft.com/math50" xmlns:u="http://schemas.mathsoft.com/units10" xmlns="http://schemas.mathsoft.com/result10">${results.join('')}</resultsList>`;
  const calc = CALCULATION_XML.replace(/array-origin="-?\d+"/, `array-origin="${ws.settings.origin ?? 0}"`);
  const t = (s: string) => esc(s);
  const core = `<?xml version="1.0" encoding="utf-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${t(ws.title ?? '')}</dc:title><dc:creator>${t(ws.settings.page?.author ?? '')}</dc:creator><cp:lastModifiedBy>FormelWerk</cp:lastModifiedBy><cp:revision>1</cp:revision></cp:coreProperties>`;

  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.mathprocessingml.mathcad.main+xml" /><Default Extension="XamlPackage" ContentType="application/zip" /><Default Extension="png" ContentType="image/png" /><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" /><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml" /><Override PartName="/docProps/app.xml" ContentType="application/mathcad.extended-properties+xml" /><Override PartName="/mathcad/settings/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.mathprocessingml.mathcad.settings.presentation+xml" /><Override PartName="/mathcad/settings/calculation.xml" ContentType="application/vnd.openxmlformats-officedocument.mathprocessingml.mathcad.settings.calculation+xml" /><Override PartName="/mathcad/result.xml" ContentType="application/vnd.openxmlformats-officedocument.mathprocessingml.mathcad.result+xml" /><Override PartName="/mathcad/integration.xml" ContentType="application/vnd.openxmlformats-officedocument.mathprocessingml.mathcad.integration+xml" /></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/mathcad/worksheet.xml" Id="R0000000001" /><Relationship Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="/docProps/core.xml" Id="R0000000002" /></Relationships>');
  z.file('docProps/core.xml', core);
  z.file('docProps/app.xml', APP_XML);
  z.file('mathcad/worksheet.xml', worksheetXml);
  z.file('mathcad/_rels/worksheet.xml.rels', `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  z.file('mathcad/result.xml', resultXml);
  z.file('mathcad/integration.xml', '<?xml version="1.0" encoding="utf-8"?><regions xmlns="http://schemas.ptc.com/integration10" />');
  z.file('mathcad/settings/presentation.xml', PRESENTATION_XML);
  z.file('mathcad/settings/calculation.xml', calc);
  for (const p of parts) z.file(p.path, p.data);
  const blob = await z.generateAsync({ type: 'blob', mimeType: 'application/vnd.mathcad.mcdx' });
  return { blob, warnings: [...new Set(warnings)] };
}
