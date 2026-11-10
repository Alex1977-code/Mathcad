/**
 * Find and replace over the worksheet: formula sources and the text of text regions, in reading order.
 * Replacing in text regions changes only the text, never the formatting.
 */
import { sortRegions, type Region, type Worksheet } from '../engine/model';

export interface FindOptions { caseSensitive?: boolean; wholeWord?: boolean }
export interface Match { regionId: string; kind: 'math' | 'text'; index: number; length: number; before: string; hit: string; after: string }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function searchRegex(query: string, o: FindOptions = {}): RegExp | null {
  if (!query) return null;
  const body = escapeRe(query);
  const src = o.wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
  return new RegExp(src, `gu${o.caseSensitive ? '' : 'i'}`);
}

/** Text content of the text nodes of an HTML fragment (concatenated, as searched). */
function textNodes(html: string): { doc: Document; nodes: Text[] } {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const nodes: Text[] = [];
  const walk = (n: Node) => { if (n.nodeType === 3) nodes.push(n as Text); else n.childNodes.forEach(walk); };
  walk(doc.body.firstChild!);
  return { doc, nodes };
}

function regionText(r: Region): string | null {
  if (r.type === 'math') return r.src;
  if (r.type === 'text') return textNodes(r.html).nodes.map(n => n.data).join('');
  return null;
}

export function findMatches(ws: Worksheet, query: string, o: FindOptions = {}): Match[] {
  const re = searchRegex(query, o);
  if (!re) return [];
  const out: Match[] = [];
  for (const r of sortRegions(ws.regions)) {
    const t = regionText(r);
    if (t === null) continue;
    re.lastIndex = 0;
    for (let m = re.exec(t); m; m = re.exec(t)) {
      if (!m[0].length) { re.lastIndex++; continue; }
      out.push({
        regionId: r.id, kind: r.type as 'math' | 'text', index: m.index, length: m[0].length,
        before: t.slice(Math.max(0, m.index - 24), m.index).replace(/\s+/g, ' '), hit: m[0], after: t.slice(m.index + m[0].length, m.index + m[0].length + 24).replace(/\s+/g, ' '),
      });
      if (out.length > 5000) return out;
    }
  }
  return out;
}

/** Replace matches in one region: all of them, or only the one starting at `only`. */
export function replaceInRegion(r: Region, query: string, repl: string, o: FindOptions = {}, only?: number): { region: Region; count: number } {
  const re = searchRegex(query, o);
  if (!re) return { region: r, count: 0 };
  let count = 0;
  const swap = (text: string, offset: number) => text.replace(re, (m, ...rest) => {
    const idx = rest[rest.length - 2] as number;
    if (only !== undefined && idx + offset !== only) return m;
    count++;
    return repl;
  });
  if (r.type === 'math') return { region: { ...r, src: swap(r.src, 0) }, count };
  if (r.type === 'text') {
    // matches are found in the whole text (as the search shows them); a match is replaced where it lies
    // inside one text node – the formatting around it stays untouched
    const { doc, nodes } = textNodes(r.html);
    const full = nodes.map(n => n.data).join('');
    const ranges: [number, number][] = [];
    re.lastIndex = 0;
    for (let m = re.exec(full); m; m = re.exec(full)) {
      if (!m[0].length) { re.lastIndex++; continue; }
      if (only === undefined || m.index === only) ranges.push([m.index, m.index + m[0].length]);
    }
    let offset = 0;
    for (const n of nodes) {
      const len = n.data.length;
      const inside = ranges.filter(([a, b]) => a >= offset && b <= offset + len).reverse();
      let t = n.data;
      for (const [a, b] of inside) { t = t.slice(0, a - offset) + repl + t.slice(b - offset); count++; }
      n.data = t;
      offset += len;
    }
    return { region: { ...r, html: (doc.body.firstChild as HTMLElement).innerHTML }, count };
  }
  return { region: r, count: 0 };
}

export function replaceAll(ws: Worksheet, query: string, repl: string, o: FindOptions = {}): { ws: Worksheet; count: number } {
  let count = 0;
  const regions = ws.regions.map(r => { const x = replaceInRegion(r, query, repl, o); count += x.count; return x.region; });
  return { ws: count ? { ...ws, regions } : ws, count };
}
