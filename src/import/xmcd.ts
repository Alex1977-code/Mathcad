/** Import of Mathcad 11–15 worksheets (.xmcd, XML). */
import { emptyWorksheet, newId, type Region, type Worksheet } from '../engine/model';
import { collectDefinedNames, convertMathElement, kids, local, child, prepareNames, resetNameRegistry, type ConvertCtx } from './mathml';
import { stmtToText } from '../engine/serialize';
import { alignStyle, base64ToBytes, bytesToBase64, coord, defaultXmlParser, pushMath, escapeHtml, gunzip, imageMime, mathRegionFrom, type XmlParser } from './common';

/** Mathcad 11–15 coordinates are in points (1/72 in); we use CSS pixels (1/96 in). */
const SCALE = 96 / 72;

/**
 * @param embedded receives formula regions embedded in the text (Mathcad 15 calculates them like any
 *   other formula); they are imported as separate formula regions at their own position.
 */
function textToHtml(textEl: Element, ctx?: ConvertCtx, embedded?: Element[]): string {
  const conv = (n: ChildNode): string => {
    if (n.nodeType === 3) return escapeHtml(n.textContent ?? '');
    if (n.nodeType !== 1) return '';
    const e = n as Element;
    const inner = () => Array.from(e.childNodes).map(conv).join('');
    switch (e.localName) {
      case 'p': {
        const style = e.getAttribute('style') ?? '';
        const st = alignStyle(e.getAttribute('text-align'));
        const body = inner();
        if (/heading\s*1|title/i.test(style)) return `<h2${st}>${body}</h2>`;
        if (/heading/i.test(style)) return `<h3${st}>${body}</h3>`;
        return `<p${st}>${body || '<br>'}</p>`;
      }
      case 'b': return `<b>${inner()}</b>`;
      case 'i': return `<i>${inner()}</i>`;
      case 'u': return `<u>${inner()}</u>`;
      case 'sub': return `<sub>${inner()}</sub>`;
      case 'sup': return `<sup>${inner()}</sup>`;
      case 'br': return '<br>';
      case 'tab': return '&emsp;';
      case 'sp': return '&nbsp;'.repeat(Math.min(Math.max(parseInt(e.getAttribute('count') ?? '1', 10) || 1, 1), 200));
      case 'f': {
        const color = e.getAttribute('color');
        const style = color && /^#?[0-9a-f]{6}$/i.test(color) ? ` style="color:${color.startsWith('#') ? color : '#' + color}"` : '';
        return style ? `<span${style}>${inner()}</span>` : inner();
      }
      case 'a': case 'hyperlink': case 'link': {
        // only web links (the sanitizer removes everything else as well)
        const href = e.getAttribute('href') ?? e.getAttribute('url') ?? e.getAttribute('target') ?? '';
        return /^https?:\/\//i.test(href) ? `<a href="${escapeHtml(href)}">${inner()}</a>` : inner();
      }
      case 'math': {
        // formula inside a text: shown as its text form (not calculated)
        if (!ctx) return '';
        try {
          const t = stmtToText(convertMathElement(e, ctx).stmt).trim();
          if (t) { ctx.warnings.push(`Formel im Text „${t.slice(0, 40)}“ als Text übernommen (wird nicht berechnet)`); return `<code>${escapeHtml(t)}</code>`; }
        } catch { /* ignore */ }
        return '';
      }
      case 'region': {
        if (embedded && kids(e).some(c => local(c) === 'math')) { embedded.push(e); return '&emsp;&emsp;'; }
        return inner();
      }
      case 'inlineAttr': case 'blockAttr': return '';
      default: return inner();
    }
  };
  // paragraphs with a list style become lists
  const parts: string[] = [];
  let list: { tag: string; items: string[] } | null = null;
  const flush = () => { if (list) parts.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`); list = null; };
  for (const n of Array.from(textEl.childNodes)) {
    const e = n.nodeType === 1 ? (n as Element) : null;
    const ls = e && e.localName === 'p' ? (e.getAttribute('list-style-type') ?? 'inherit') : 'inherit';
    if (e && !['inherit', 'none', ''].includes(ls)) {
      const tag = /decimal|alpha|roman|number/i.test(ls) ? 'ol' : 'ul';
      if (!list || list.tag !== tag) { flush(); list = { tag, items: [] }; }
      list.items.push(`<li>${Array.from(e.childNodes).map(conv).join('')}</li>`);
      continue;
    }
    if (n.nodeType === 3 && !(n.textContent ?? '').trim() && list) continue;
    flush();
    parts.push(conv(n));
  }
  flush();
  return parts.join('').trim();
}

export async function importXmcd(xml: string, name: string, parseXml: XmlParser = defaultXmlParser): Promise<Worksheet> {
  const doc = parseXml(xml);
  const root = doc.documentElement;
  if (root.localName !== 'worksheet') throw new Error('Keine Mathcad-Arbeitsblattdatei (.xmcd)');
  const ws = emptyWorksheet(name.replace(/\.xmcd$/i, ''));
  ws.settings.fontSize = 12;
  const warnings: string[] = [];
  resetNameRegistry();
  warnings.push(...prepareNames(root));
  const ctx: ConvertCtx = { warnings, definedNames: collectDefinedNames(root), unknown: new Set() };

  // settings
  const biv = root.getElementsByTagName('builtInVariables')[0];
  if (biv) ws.settings.origin = parseInt(biv.getAttribute('array-origin') ?? '0', 10) || 0;
  const gen = root.getElementsByTagName('general')[0];
  if (gen) {
    const p = parseInt(gen.getAttribute('precision') ?? '3', 10);
    if (p >= 0 && p <= 15) ws.settings.decimals = p;
  }

  // binary items (images)
  const items = new Map<string, Element>();
  const bc = child(root, 'binaryContent');
  if (bc) for (const it of kids(bc)) items.set(it.getAttribute('item-id') ?? '', it);
  const loadImage = async (id: string | null): Promise<string | null> => {
    if (!id) return null;
    const it = items.get(id);
    if (!it) return null;
    try {
      let bytes = base64ToBytes(it.textContent ?? '');
      if (it.getAttribute('content-encoding') === 'gzip') bytes = await gunzip(bytes);
      const mime = imageMime(bytes);
      return mime ? `data:${mime};base64,${bytesToBase64(bytes)}` : null;
    } catch { return null; }
  };

  const regionsEl = child(root, 'regions');
  const regions: Region[] = [];
  let plotsAsImages = 0;
  for (const reg of regionsEl ? kids(regionsEl) : []) {
    if (local(reg) !== 'region') continue;
    const x = coord(reg.getAttribute('left')) * SCALE;
    const y = coord(reg.getAttribute('top')) * SCALE;
    const w = coord(reg.getAttribute('width'), 1e4) * SCALE;
    const h = coord(reg.getAttribute('height'), 1e5) * SCALE;
    const content = kids(reg).find(c => local(c) !== 'rendering');
    if (!content) continue;
    switch (local(content)) {
      case 'math': {
        const m = mathRegionFrom(content, x, y, ctx);
        const ay = parseFloat(reg.getAttribute('align-y') ?? '');
        if (Number.isFinite(ay) && Math.abs(ay) < 1e6) m.oy = ay * SCALE - y;
        pushMath(regions, m);
        break;
      }
      case 'text': {
        const embedded: Element[] = [];
        const html = textToHtml(content, ctx, embedded);
        if (html) regions.push({ id: newId(), type: 'text', x, y, w: Math.max(w, 60), html });
        for (const er of embedded) {
          const ex = coord(er.getAttribute('left')) * SCALE, ey = coord(er.getAttribute('top')) * SCALE;
          const m = mathRegionFrom(kids(er).find(c => local(c) === 'math')!, ex, ey, ctx);
          const ay = parseFloat(er.getAttribute('align-y') ?? '');
          if (Number.isFinite(ay) && Math.abs(ay) < 1e6) m.oy = ay * SCALE - ey;
          pushMath(regions, m);
          warnings.push(`Formel im Text bei (${Math.round(ex)}, ${Math.round(ey)}) als eigene Formel übernommen: ${m.src.split('\n')[0].slice(0, 50)}`);
        }
        break;
      }
      case 'plot': {
        const src = await loadImage(child(reg, 'rendering')?.getAttribute('item-idref') ?? null);
        plotsAsImages++;
        if (src) regions.push({ id: newId(), type: 'image', x, y, w, h, src, alt: 'Mathcad-Diagramm (als Bild übernommen)' });
        break;
      }
      case 'picture': {
        const img = kids(content)[0];
        const src = await loadImage(img?.getAttribute('item-idref') ?? null)
          ?? await loadImage(child(reg, 'rendering')?.getAttribute('item-idref') ?? null);
        if (src) regions.push({ id: newId(), type: 'image', x, y, w, h, src, alt: 'Bild' });
        else warnings.push('Ein Bild konnte nicht übernommen werden');
        break;
      }
      case 'pageBreak':
        regions.push({ id: newId(), type: 'pagebreak', x: 0, y });
        break;
      default: {
        const src = await loadImage(child(reg, 'rendering')?.getAttribute('item-idref') ?? null);
        if (src) {
          regions.push({ id: newId(), type: 'image', x, y, w, h, src, alt: local(content) });
          warnings.push(`„${local(content)}“-Bereich als Bild übernommen`);
        } else warnings.push(`„${local(content)}“-Bereich wird nicht unterstützt und wurde ausgelassen`);
      }
    }
  }
  if (plotsAsImages) warnings.push(`${plotsAsImages} Diagramm(e) als Bild übernommen (Mathcad 15 speichert Diagramme binär). Neue Diagramme lassen sich mit „Diagramm“ einfügen.`);
  if (ctx.unknown.size) warnings.push(`Nicht unterstützte Mathcad-Elemente: ${[...ctx.unknown].join(', ')}`);
  ws.regions = regions;
  ws.source = { kind: 'xmcd', name, warnings };
  return ws;
}
