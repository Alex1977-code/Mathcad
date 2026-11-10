/** Document model (serializable). */

export interface ExpScalar { re: number; im?: number; dims: number[] }
export type Expected =
  | { kind: 'scalar'; v: ExpScalar }
  | { kind: 'matrix'; rows: number; cols: number; v: (ExpScalar | null)[] }
  | { kind: 'string'; v: string };

export interface RegionBase {
  id: string;
  x: number;
  y: number;
  /** Optional fixed width (text/plot). */
  w?: number;
  h?: number;
  /** Offset of the evaluation anchor below y (Mathcad 15 orders regions by their baseline). */
  oy?: number;
}

export interface MathRegion extends RegionBase {
  type: 'math';
  src: string;
  /** Do not evaluate (Mathcad "disable evaluation"). */
  disabled?: boolean;
  /** Guess value of a solve block (re-evaluated whenever Find runs, e.g. with function arguments). */
  guess?: boolean;
  /** Data from an imported Mathcad file. */
  imported?: {
    /** Result Mathcad stored in the file (used to verify our calculation). */
    expected?: Expected;
    /** Symbolic result shown by Mathcad (FormelWerk calculates numerically only). */
    symbolic?: string;
    /** Reason why the region could not be converted. */
    original?: string;
  };
}

export interface TextRegion extends RegionBase {
  type: 'text';
  /** Sanitized HTML (b, i, u, sub, sup, br, p, span with styles). */
  html: string;
}

export interface PlotTrace { x: string; y: string; color?: string; style?: 'line' | 'points' | 'both'; label?: string }

export interface PlotRegion extends RegionBase {
  type: 'plot';
  traces: PlotTrace[];
  xmin?: string; xmax?: string; ymin?: string; ymax?: string;
  xUnit?: string; yUnit?: string;
  logX?: boolean; logY?: boolean;
  title?: string;
}

export interface ImageRegion extends RegionBase {
  type: 'image';
  src: string;
  alt?: string;
}

export interface PageBreakRegion extends RegionBase { type: 'pagebreak' }

export type Region = MathRegion | TextRegion | PlotRegion | ImageRegion | PageBreakRegion;

export interface WorksheetSettings {
  decimals: number;
  expThreshold: number;
  origin: number;
  /** Base font size of formulas in px. */
  fontSize?: number;
  /** Show results with a decimal comma (input always uses the point). */
  decimalComma?: boolean;
  /** Project data and page header/footer for print and export. */
  page?: PageInfo;
}

export interface PageInfo {
  project?: string;
  author?: string;
  /** Left, centre, right; placeholders see pageinfo.ts. */
  header?: [string, string, string];
  footer?: [string, string, string];
}

export interface Worksheet {
  format: 'formelwerk';
  version: 1;
  title: string;
  regions: Region[];
  settings: WorksheetSettings;
  /** Information about the imported source file. */
  source?: { kind: 'xmcd' | 'mcdx'; name: string; warnings: string[] };
}

export const DEFAULT_SETTINGS: WorksheetSettings = { decimals: 3, expThreshold: 7, origin: 0, fontSize: 15 };

let counter = 0;
export function newId(prefix = 'r'): string {
  counter++;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function emptyWorksheet(title = 'Unbenannt'): Worksheet {
  return { format: 'formelwerk', version: 1, title, regions: [], settings: { ...DEFAULT_SETTINGS } };
}

/** Mathcad evaluation order: top to bottom, then left to right. */
export function sortRegions<T extends RegionBase>(regions: T[]): T[] {
  const fin = (v: number) => (Number.isFinite(v) ? v : 0);
  const key = (r: RegionBase) => fin(r.y + (r.oy ?? 0));
  // sort by height, then group regions on (almost) the same line and order each line from left to right;
  // grouping against the first region of a line keeps the order independent of the input order
  const byY = regions.slice().sort((a, b) => key(a) - key(b) || fin(a.x) - fin(b.x));
  const out: T[] = [];
  for (let i = 0; i < byY.length;) {
    let j = i + 1;
    while (j < byY.length && key(byY[j]) - key(byY[i]) < 0.5) j++;
    out.push(...byY.slice(i, j).sort((a, b) => fin(a.x) - fin(b.x) || key(a) - key(b)));
    i = j;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Validation of documents from files or the browser storage           */
/* ------------------------------------------------------------------ */

const str = (v: unknown, max = 1e6): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v: unknown, lo: number, hi: number, def: number): number =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : def);
const optNum = (v: unknown, lo: number, hi: number): number | undefined =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : undefined);
/** Only plain colours (no url(), no expressions). */
export function safeColor(v: unknown): string | undefined {
  return typeof v === 'string' && /^(#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i.test(v.trim()) ? v.trim() : undefined;
}
/** Only embedded images (no requests to other servers). */
export function safeImageSrc(v: unknown): string | undefined {
  return typeof v === 'string' && /^data:image\/(png|jpeg|gif|bmp|webp);base64,[a-z0-9+/=\s]+$/i.test(v) ? v : undefined;
}

/**
 * Bring a document from an untrusted source (file, autosave) into a valid shape: wrong types are
 * dropped or replaced, coordinates are limited. Throws only if it is not a FormelWerk document at all.
 */
export function normalizeWorksheet(raw: unknown): Worksheet {
  if (!raw || typeof raw !== 'object') throw new Error('Keine FormelWerk-Datei.');
  const o = raw as Record<string, unknown>;
  if (o.format !== 'formelwerk' || !Array.isArray(o.regions)) throw new Error('Keine FormelWerk-Datei.');
  const s = (o.settings && typeof o.settings === 'object' ? o.settings : {}) as Record<string, unknown>;
  const settings: WorksheetSettings = {
    decimals: Math.round(num(s.decimals, 0, 15, DEFAULT_SETTINGS.decimals)),
    expThreshold: Math.round(num(s.expThreshold, 1, 15, DEFAULT_SETTINGS.expThreshold)),
    origin: Math.round(num(s.origin, -1e6, 1e6, 0)),
    fontSize: num(s.fontSize, 8, 40, DEFAULT_SETTINGS.fontSize!),
    ...(s.decimalComma === true ? { decimalComma: true } : {}),
  };
  const pg = s.page && typeof s.page === 'object' ? s.page as Record<string, unknown> : null;
  if (pg) {
    const three = (v: unknown): [string, string, string] | undefined =>
      Array.isArray(v) ? [0, 1, 2].map(i => str(v[i], 300) ?? '') as [string, string, string] : undefined;
    const page: PageInfo = {};
    if (str(pg.project, 300)) page.project = str(pg.project, 300);
    if (str(pg.author, 300)) page.author = str(pg.author, 300);
    const h = three(pg.header), f = three(pg.footer);
    if (h) page.header = h;
    if (f) page.footer = f;
    settings.page = page;
  }
  const ids = new Set<string>();
  const regions: Region[] = [];
  for (const r0 of (o.regions as unknown[]).slice(0, 100000)) {
    if (!r0 || typeof r0 !== 'object') continue;
    const r = r0 as Record<string, unknown>;
    let id = str(r.id, 100) || newId();
    if (ids.has(id)) id = newId();
    ids.add(id);
    const base: RegionBase = { id, x: num(r.x, 0, 1e5, 0), y: num(r.y, 0, 1e6, 0) };
    const w = optNum(r.w, 10, 1e4), h = optNum(r.h, 10, 1e5), oy = optNum(r.oy, -1e4, 1e4);
    if (w !== undefined) base.w = w;
    if (h !== undefined) base.h = h;
    if (oy !== undefined) base.oy = oy;
    switch (r.type) {
      case 'math': {
        const m: MathRegion = { ...base, type: 'math', src: str(r.src, 2e5) ?? '' };
        if (r.disabled === true) m.disabled = true;
        if (r.guess === true) m.guess = true;
        if (r.imported && typeof r.imported === 'object') {
          const im = r.imported as Record<string, unknown>;
          const e = im.expected as Expected | undefined;
          const validExp = e && typeof e === 'object' && (e.kind === 'scalar' || e.kind === 'matrix' || e.kind === 'string') ? e : undefined;
          m.imported = { expected: validExp, symbolic: str(im.symbolic, 1e4), original: str(im.original, 1e3) };
        }
        regions.push(m);
        break;
      }
      case 'text': regions.push({ ...base, type: 'text', html: str(r.html, 2e5) ?? '' }); break;
      case 'plot': {
        const traces = (Array.isArray(r.traces) ? r.traces : []).filter(t => t && typeof t === 'object').slice(0, 50).map(t0 => {
          const t = t0 as Record<string, unknown>;
          const tr: PlotTrace = { x: str(t.x, 2000) ?? '', y: str(t.y, 2000) ?? '' };
          const c = safeColor(t.color);
          if (c) tr.color = c;
          if (t.style === 'line' || t.style === 'points' || t.style === 'both') tr.style = t.style;
          const l = str(t.label, 200);
          if (l) tr.label = l;
          return tr;
        });
        const p: PlotRegion = { ...base, type: 'plot', traces };
        for (const k of ['xmin', 'xmax', 'ymin', 'ymax', 'xUnit', 'yUnit', 'title'] as const) { const v = str(r[k], 2000); if (v !== undefined) p[k] = v; }
        if (r.logX === true) p.logX = true;
        if (r.logY === true) p.logY = true;
        regions.push(p);
        break;
      }
      case 'image': {
        const src = safeImageSrc(r.src);
        if (src) regions.push({ ...base, type: 'image', src, alt: str(r.alt, 500) });
        break;
      }
      case 'pagebreak': regions.push({ ...base, type: 'pagebreak' }); break;
      default: break;
    }
  }
  const ws: Worksheet = { format: 'formelwerk', version: 1, title: str(o.title, 300) || 'Unbenannt', regions, settings };
  if (o.source && typeof o.source === 'object') {
    const src = o.source as Record<string, unknown>;
    if (src.kind === 'xmcd' || src.kind === 'mcdx') {
      ws.source = { kind: src.kind, name: str(src.name, 300) ?? '', warnings: Array.isArray(src.warnings) ? src.warnings.filter(w => typeof w === 'string').slice(0, 500) as string[] : [] };
    }
  }
  return ws;
}
