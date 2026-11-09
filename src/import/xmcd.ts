/** Import of Mathcad 11–15 worksheets (.xmcd, XML). */
import { emptyWorksheet, newId, type Region, type Worksheet } from '../engine/model';
import { collectDefinedNames, kids, local, child, type ConvertCtx } from './mathml';
import { base64ToBytes, bytesToBase64, defaultXmlParser, escapeHtml, gunzip, imageMime, mathRegionFrom, type XmlParser } from './common';

/** Mathcad 11–15 coordinates are in points (1/72 in); we use CSS pixels (1/96 in). */
const SCALE = 96 / 72;

function textToHtml(textEl: Element): string {
  const conv = (n: ChildNode): string => {
    if (n.nodeType === 3) return escapeHtml(n.textContent ?? '');
    if (n.nodeType !== 1) return '';
    const e = n as Element;
    const inner = () => Array.from(e.childNodes).map(conv).join('');
    switch (e.localName) {
      case 'p': {
        const style = e.getAttribute('style') ?? '';
        const align = e.getAttribute('text-align');
        const st = align && align !== 'inherit' ? ` style="text-align:${align}"` : '';
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
      case 'sp': return '&nbsp;'.repeat(parseInt(e.getAttribute('count') ?? '1', 10) || 1);
      case 'f': {
        const color = e.getAttribute('color');
        const style = color && /^#?[0-9a-f]{6}$/i.test(color) ? ` style="color:${color.startsWith('#') ? color : '#' + color}"` : '';
        return style ? `<span${style}>${inner()}</span>` : inner();
      }
      case 'math': case 'inlineAttr': case 'blockAttr': return '';
      default: return inner();
    }
  };
  return Array.from(textEl.childNodes).map(conv).join('').trim();
}

export async function importXmcd(xml: string, name: string, parseXml: XmlParser = defaultXmlParser): Promise<Worksheet> {
  const doc = parseXml(xml);
  const root = doc.documentElement;
  if (root.localName !== 'worksheet') throw new Error('Keine Mathcad-Arbeitsblattdatei (.xmcd)');
  const ws = emptyWorksheet(name.replace(/\.xmcd$/i, ''));
  ws.settings.fontSize = 12;
  const warnings: string[] = [];
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
    const x = parseFloat(reg.getAttribute('left') ?? '0') * SCALE;
    const y = parseFloat(reg.getAttribute('top') ?? '0') * SCALE;
    const w = parseFloat(reg.getAttribute('width') ?? '0') * SCALE;
    const h = parseFloat(reg.getAttribute('height') ?? '0') * SCALE;
    const content = kids(reg).find(c => local(c) !== 'rendering');
    if (!content) continue;
    switch (local(content)) {
      case 'math': {
        const m = mathRegionFrom(content, x, y, ctx);
        const ay = parseFloat(reg.getAttribute('align-y') ?? '');
        if (!Number.isNaN(ay)) m.oy = ay * SCALE - y;
        regions.push(m);
        break;
      }
      case 'text': {
        const html = textToHtml(content);
        if (html) regions.push({ id: newId(), type: 'text', x, y, w: Math.max(w, 60), html });
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
