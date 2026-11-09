/** Import of Mathcad Prime worksheets (.mcdx, Open Packaging Convention ZIP). */
import JSZip from 'jszip';
import { emptyWorksheet, newId, type PlotTrace, type Region, type Worksheet } from '../engine/model';
import { toText } from '../engine/serialize';
import { collectDefinedNames, convertExpr, kids, local, child, resetNameRegistry, type ConvertCtx } from './mathml';
import { alignStyle, bytesToBase64, coord, defaultXmlParser, pushMath, escapeHtml, imageMime, mathRegionFrom, type XmlParser } from './common';

const PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#db2777', '#4b5563'];

function argbToCss(c: string | null): string | null {
  if (!c) return null;
  const m = /^#([0-9a-f]{2})([0-9a-f]{6})$/i.exec(c);
  if (m) return '#' + m[2];
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  return null;
}

/** Convert a WPF FlowDocument (XAML) to simple HTML. */
export function xamlToHtml(root: Element, baseSize = 14.6666): string {
  const runStyle = (e: Element, body: string): string => {
    let s = body;
    if (/bold|semibold|black|heavy/i.test(e.getAttribute('FontWeight') ?? '')) s = `<b>${s}</b>`;
    if (/italic|oblique/i.test(e.getAttribute('FontStyle') ?? '')) s = `<i>${s}</i>`;
    if (/underline/i.test(e.getAttribute('TextDecorations') ?? '')) s = `<u>${s}</u>`;
    const ba = e.getAttribute('BaselineAlignment') ?? e.getAttribute('Typography.Variants') ?? '';
    if (/subscript/i.test(ba)) s = `<sub>${s}</sub>`;
    if (/superscript/i.test(ba)) s = `<sup>${s}</sup>`;
    const color = argbToCss(e.getAttribute('Foreground'));
    const styles: string[] = [];
    if (color && color.toLowerCase() !== '#000000') styles.push(`color:${color}`);
    const fs = parseFloat(e.getAttribute('FontSize') ?? '');
    if (fs && Math.abs(fs - baseSize) > 1) styles.push(`font-size:${Math.min(Math.max(fs / baseSize, 0.5), 4).toFixed(2)}em`);
    if (styles.length) s = `<span style="${styles.join(';')}">${s}</span>`;
    return s;
  };
  const conv = (n: ChildNode): string => {
    if (n.nodeType === 3) return escapeHtml(n.textContent ?? '');
    if (n.nodeType !== 1) return '';
    const e = n as Element;
    const inner = () => Array.from(e.childNodes).map(conv).join('');
    switch (e.localName) {
      case 'Section': case 'FlowDocument': return inner();
      case 'Paragraph': {
        const st = alignStyle(e.getAttribute('TextAlignment'));
        const body = runStyle(e, inner());
        return `<p${st}>${body || '<br>'}</p>`;
      }
      case 'Run': case 'Span': return runStyle(e, e.localName === 'Run' ? escapeHtml(e.getAttribute('Text') ?? '') + inner() : inner());
      case 'Bold': return `<b>${inner()}</b>`;
      case 'Italic': return `<i>${inner()}</i>`;
      case 'Underline': return `<u>${inner()}</u>`;
      case 'LineBreak': return '<br>';
      case 'Hyperlink': {
        const href = e.getAttribute('NavigateUri') ?? '';
        return /^https?:/i.test(href) ? `<a href="${escapeHtml(href)}">${inner()}</a>` : inner();
      }
      case 'List': {
        const marker = e.getAttribute('MarkerStyle') ?? '';
        const tag = /decimal|alpha|roman/i.test(marker) ? 'ol' : 'ul';
        return `<${tag}>${inner()}</${tag}>`;
      }
      case 'ListItem': {
        // one paragraph per item: unwrap it (also with attributes), several stay as they are
        const h = inner();
        const single = /^<p[^>]*>((?:(?!<p[\s>]).)*)<\/p>$/s.exec(h);
        return `<li>${single ? single[1] : h}</li>`;
      }
      case 'Table': return `<table>${inner()}</table>`;
      case 'TableRowGroup': return inner();
      case 'TableRow': return `<tr>${inner()}</tr>`;
      case 'TableCell': return `<td>${inner()}</td>`;
      case 'Table.Columns': case 'InlineUIContainer': case 'BlockUIContainer': return '';
      default: return inner();
    }
  };
  return conv(root).replace(/(<p><br><\/p>)+$/, '').trim();
}

export async function importMcdx(data: ArrayBuffer | Uint8Array, name: string, parseXml: XmlParser = defaultXmlParser): Promise<Worksheet> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(data); } catch { throw new Error('Datei ist kein gültiges Mathcad-Prime-Dokument (.mcdx)'); }
  const wsFile = zip.file('mathcad/worksheet.xml');
  if (!wsFile) throw new Error('mathcad/worksheet.xml fehlt – keine Mathcad-Prime-Datei');
  const strip = (s: string) => s.replace(/^﻿/, '');
  const doc = parseXml(strip(await wsFile.async('string')));
  const root = doc.documentElement;
  const ws = emptyWorksheet(name.replace(/\.mcdx$/i, ''));
  ws.settings.fontSize = 12.5;
  const warnings: string[] = [];
  resetNameRegistry();
  const ctx: ConvertCtx = { warnings, definedNames: collectDefinedNames(root), unknown: new Set() };

  // settings
  const calc = zip.file('mathcad/settings/calculation.xml');
  if (calc) {
    try {
      const cdoc = parseXml(strip(await calc.async('string')));
      const biv = cdoc.getElementsByTagName('builtInVariables')[0];
      if (biv) ws.settings.origin = parseInt(biv.getAttribute('array-origin') ?? '0', 10) || 0;
    } catch { warnings.push('Berechnungseinstellungen beschädigt – Standardwerte verwendet'); }
  }

  // results
  const results = new Map<string, Element>();
  const resFile = zip.file('mathcad/result.xml');
  if (resFile) {
    try {
      const rdoc = parseXml(strip(await resFile.async('string')));
      const all = rdoc.getElementsByTagName('*');
      for (let i = 0; i < all.length; i++) {
        const e = all[i];
        if (e.localName === 'resultData') {
          const r = kids(e).find(c => c.localName === 'result');
          if (r) results.set(e.getAttribute('result-id') ?? '', r);
        }
      }
    } catch { warnings.push('Gespeicherte Mathcad-Ergebnisse beschädigt – kein Ergebnisabgleich'); }
  }

  // relationships (text documents, images)
  const rels = new Map<string, string>();
  const relFile = zip.file('mathcad/_rels/worksheet.xml.rels');
  if (relFile) {
    try {
      const rdoc = parseXml(strip(await relFile.async('string')));
      for (const r of Array.from(rdoc.getElementsByTagName('*'))) {
        if (r.localName === 'Relationship') rels.set(r.getAttribute('Id') ?? '', (r.getAttribute('Target') ?? '').replace(/^\//, ''));
      }
    } catch { warnings.push('Verweise auf Texte/Bilder beschädigt – diese fehlen'); }
  }
  const loadText = async (textEl: Element): Promise<string> => {
    const inline = kids(textEl).find(c => c.localName === 'FlowDocument');
    if (inline && inline.children.length) return xamlToHtml(inline);
    const target = rels.get(textEl.getAttribute('item-idref') ?? '');
    const f = target ? zip.file(target) : null;
    if (!f) return '';
    try {
      const inner = await JSZip.loadAsync(await f.async('uint8array'));
      const xf = Object.values(inner.files).find(x => /\.xaml$/i.test(x.name));
      if (!xf) return '';
      const xdoc = parseXml(strip(await xf.async('string')));
      return xamlToHtml(xdoc.documentElement);
    } catch { return ''; }
  };
  const loadImage = async (id: string | null): Promise<string | null> => {
    const target = id ? rels.get(id) : undefined;
    const f = target ? zip.file(target) : null;
    if (!f) return null;
    const bytes = await f.async('uint8array');
    const mime = imageMime(bytes);
    return mime ? `data:${mime};base64,${bytesToBase64(bytes)}` : null;
  };

  const regions: Region[] = [];
  const handleRegion = async (reg: Element, ox: number, oy: number) => {
    const x = ox + coord(reg.getAttribute('left'));
    const y = oy + coord(reg.getAttribute('top'));
    const w = coord(reg.getAttribute('width') ?? reg.getAttribute('actualWidth'), 1e4);
    const h = coord(reg.getAttribute('height') ?? reg.getAttribute('actualHeight'), 1e5);
    const content = kids(reg)[0];
    if (!content) return;
    switch (local(content)) {
      case 'math': {
        const ref = content.getAttribute('resultRef');
        pushMath(regions, mathRegionFrom(content, x, y, ctx, ref ? results.get(ref) : null));
        break;
      }
      case 'text': {
        const html = await loadText(content);
        if (html) regions.push({ id: newId(), type: 'text', x, y, w: Math.max(w, 60), html });
        break;
      }
      case 'plot': regions.push(convertPlot(content, x, y, w, h, ctx)); break;
      case 'solveblock': {
        const inner = child(content, 'regions');
        const subs = inner ? kids(inner).filter(r => local(r) === 'region') : [];
        const firstConstraint = subs.find(r => r.getAttribute('solve-block-category') === 'constraint');
        for (const s of subs) {
          const before = regions.length;
          await handleRegion(s, x, y);
          if (s.getAttribute('solve-block-category') === 'guess-value') {
            for (const r of regions.slice(before)) if (r.type === 'math') r.guess = true;
          }
        }
        if (firstConstraint) {
          regions.push({ id: newId(), type: 'math', x: x - 6, y: y + parseFloat(firstConstraint.getAttribute('top') ?? '0'), src: 'Given' });
        }
        break;
      }
      case 'picture': {
        const img = kids(content)[0];
        const src = await loadImage(img?.getAttribute('item-idref') ?? content.getAttribute('item-idref'));
        if (src) regions.push({ id: newId(), type: 'image', x, y, w, h, src, alt: 'Bild' });
        else warnings.push('Ein Bild konnte nicht übernommen werden');
        break;
      }
      case 'pageBreak': regions.push({ id: newId(), type: 'pagebreak', x: 0, y }); break;
      case 'spec-table': {
        // data table: one column vector definition per column, placed side by side
        let k = 0;
        for (const m of kids(content)) {
          if (local(m) !== 'math') continue;
          const ref = m.getAttribute('resultRef');
          pushMath(regions, mathRegionFrom(m, x + k * 130, y, ctx, ref ? results.get(ref) : null));
          k++;
        }
        warnings.push(`Datentabelle mit ${k} Spalten als Vektordefinitionen übernommen`);
        break;
      }
      case 'Area': case 'area': {
        const inner = child(content, 'regions');
        if (inner) for (const s of kids(inner)) if (local(s) === 'region') await handleRegion(s, x, y);
        break;
      }
      default:
        warnings.push(`„${local(content)}“-Bereich wird nicht unterstützt und wurde ausgelassen`);
    }
  };
  const regionsEl = child(root, 'regions');
  for (const reg of regionsEl ? kids(regionsEl) : []) if (local(reg) === 'region') await handleRegion(reg, 0, 0);
  if (ctx.unknown.size) warnings.push(`Nicht unterstützte Mathcad-Elemente: ${[...ctx.unknown].join(', ')}`);
  ws.regions = regions;
  ws.source = { kind: 'mcdx', name, warnings };
  return ws;
}

function convertPlot(plot: Element, x: number, y: number, w: number, h: number, ctx: ConvertCtx): Region {
  const xy = plot.getElementsByTagName('*');
  let xAxis: Element | undefined, yAxis: Element | undefined;
  for (let i = 0; i < xy.length; i++) {
    if (xy[i].localName === 'xAxis' && !xAxis) xAxis = xy[i];
    if (xy[i].localName === 'yAxis' && !yAxis) yAxis = xy[i];
  }
  const eqs = (axis?: Element): { expr: string; unit?: string }[] => {
    const pe = axis ? child(axis, 'plotEquations') : undefined;
    if (!pe) return [];
    return kids(pe).filter(e => local(e) === 'plotEquation').map(e => {
      const [m1, m2] = kids(e).filter(c => local(c) === 'math');
      let expr = '', unit: string | undefined;
      try { const c = m1 && kids(m1)[0]; expr = c ? toText(convertExpr(c, ctx)) : ''; } catch (err) { ctx.warnings.push('Diagramm: ' + (err as Error).message); }
      try { const c = m2 && kids(m2)[0]; if (c && local(c) !== 'placeholder') unit = toText(convertExpr(c, ctx)); } catch { /* ignore */ }
      return { expr, unit };
    });
  };
  const xs = eqs(xAxis), ys = eqs(yAxis);
  const traceEls = Array.from(plot.getElementsByTagName('*')).filter(e => e.localName === 'traceStyle');
  const traces: PlotTrace[] = ys.map((yy, i) => {
    const st = traceEls[i];
    const color = argbToCss(st?.getAttribute('color') ?? null) ?? PALETTE[i % PALETTE.length];
    const sym = st?.getAttribute('symbol') ?? 'none';
    const kind = (st?.textContent ?? 'lines').trim();
    return {
      x: (xs[i] ?? xs[0])?.expr ?? '', y: yy.expr, color,
      style: (kind === 'points' || kind === 'none' ? 'points' : sym !== 'none' ? 'both' : 'line') as PlotTrace['style'],
    };
  }).filter(t => t.y);
  const lim = (axis: Element | undefined, which: 'start' | 'end'): string | undefined => {
    if (!axis) return undefined;
    const dom = child(axis, 'xyDomain');
    const v = dom ? child(dom, which === 'start' ? 'startValue' : 'endValue') : undefined;
    const c = v ? kids(v)[0] : undefined;
    if (c && local(c) !== 'placeholder') { try { return toText(convertExpr(c, ctx)); } catch { /* ignore */ } }
    const a = axis.getAttribute(which);
    return a ?? undefined;
  };
  return {
    id: newId(), type: 'plot', x, y, w: Math.max(w, 260), h: Math.max(h, 180), traces,
    xmin: lim(xAxis, 'start'), xmax: lim(xAxis, 'end'),
    xUnit: xs[0]?.unit, yUnit: ys[0]?.unit,
    logX: xAxis?.getElementsByTagName('*') && child(xAxis, 'xyDomain')?.getAttribute('scale-type') === 'log',
    logY: yAxis && child(yAxis, 'xyDomain')?.getAttribute('scale-type') === 'log',
  };
}
