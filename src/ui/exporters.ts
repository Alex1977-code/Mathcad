/**
 * Browser side of the exports: Word document, pictures of plots and regions (PNG), always in the light
 * colour scheme regardless of the current theme.
 */
import type { MathRegion, PlotRegion, Worksheet } from '../engine/model';
import type { ComputeResult } from '../engine/worksheet';
import { regionElements } from './layout';
import { composeLatex } from './regions/MathRegionView';

/** Run fn with the light theme active (exports never come out dark). */
export async function withLightTheme<T>(fn: () => Promise<T>): Promise<T> {
  const root = document.documentElement;
  const prev = root.dataset.theme;
  if (prev === 'light') return fn();
  root.dataset.theme = 'light';
  await new Promise(r => requestAnimationFrame(() => r(null)));
  try { return await fn(); } finally { if (prev === undefined) delete root.dataset.theme; else root.dataset.theme = prev; }
}

const SVG_PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'fill-opacity', 'stroke-opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline', 'visibility', 'display'];

/** SVG element → PNG (styles inlined, scale for sharp output). */
export async function svgToPng(svg: SVGSVGElement, scale = 2): Promise<{ data: Uint8Array; w: number; h: number; blob: Blob } | null> {
  const w = svg.width.baseVal.value || svg.getBoundingClientRect().width, h = svg.height.baseVal.value || svg.getBoundingClientRect().height;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = [svg, ...Array.from(svg.querySelectorAll('*'))] as Element[];
  const dst = [clone, ...Array.from(clone.querySelectorAll('*'))] as Element[];
  src.forEach((el, i) => {
    const cs = getComputedStyle(el);
    const style = SVG_PROPS.map(p => `${p}:${cs.getPropertyValue(p)}`).join(';');
    dst[i].setAttribute('style', style);
    // attributes with CSS variables cannot be resolved outside the page
    for (const a of ['fill', 'stroke']) if (/var\(/.test(dst[i].getAttribute(a) ?? '')) dst[i].removeAttribute(a);
  });
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(w)); clone.setAttribute('height', String(h));
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%'); bg.setAttribute('fill', '#ffffff');
  clone.insertBefore(bg, clone.firstChild);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
  return rasterize(url, w, h, scale);
}

async function rasterize(url: string, w: number, h: number, scale: number) {
  const load = async () => {
    const im = new Image();
    await new Promise<void>((res, rej) => { im.onload = () => res(); im.onerror = () => rej(new Error('Bild konnte nicht erzeugt werden')); im.src = url; });
    try { await im.decode(); } catch { /* drawn anyway */ }
    return im;
  };
  // fonts embedded in the picture (e.g. KaTeX's large brackets) are only loaded on first use: load twice
  await load();
  await new Promise(r => setTimeout(r, 200));
  const img = await load();
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * scale); canvas.height = Math.ceil(h * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
  if (!blob) return null;
  return { data: new Uint8Array(await blob.arrayBuffer()), w: Math.round(w), h: Math.round(h), blob };
}

/** All style rules of the page (fonts embedded as data URLs), light variants only. */
let cssCache: string | null = null;
export async function collectCss(): Promise<string> {
  if (cssCache) return cssCache;
  const fontCache = new Map<string, string>();
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRule[];
    try { rules = Array.from(sheet.cssRules); } catch { continue; }
    for (const r of rules) {
      if (r instanceof CSSMediaRule && /prefers-color-scheme/.test(r.conditionText)) continue;
      if (/\[data-theme="?dark"?\]/.test(r.cssText)) continue;
      if (r instanceof CSSFontFaceRule) {
        // small fonts are already inlined by the bundler
        if (/url\(["']?data:/.test(r.cssText)) { parts.push(r.cssText); continue; }
        const m = /url\(["']?([^"')]+\.woff2)["']?\)/.exec(r.cssText);
        if (!m) continue;
        const url = new URL(m[1], sheet.href ?? location.href).href;
        let data = fontCache.get(url);
        if (data === undefined) {
          try { data = `data:font/woff2;base64,${bytesToB64(new Uint8Array(await (await fetch(url)).arrayBuffer()))}`; } catch { data = ''; }
          fontCache.set(url, data);
        }
        if (data) parts.push(r.cssText.replace(/src:[^;]+;/, `src: url(${data}) format("woff2");`));
        continue;
      }
      parts.push(r.cssText);
    }
  }
  cssCache = parts.join('\n');
  return cssCache;
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Picture of rendered regions (formulas with KaTeX, text, plots) as PNG. */
export async function regionsToPng(ids: string[], scale = 2): Promise<{ data: Uint8Array; w: number; h: number; blob: Blob } | null> {
  return withLightTheme(async () => {
    const els = ids.map(id => regionElements.get(id)).filter(Boolean) as HTMLElement[];
    if (!els.length) return null;
    const x0 = Math.min(...els.map(e => e.offsetLeft)), y0 = Math.min(...els.map(e => e.offsetTop));
    const x1 = Math.max(...els.map(e => e.offsetLeft + e.offsetWidth)), y1 = Math.max(...els.map(e => e.offsetTop + e.offsetHeight));
    const pad = 8, w = x1 - x0 + 2 * pad, h = y1 - y0 + 2 * pad;
    const css = await collectCss();
    // plots: replaced by their picture (SVG inside foreignObject renders unreliably)
    const inner: string[] = [];
    for (const e of els) {
      const c = e.cloneNode(true) as HTMLElement;
      c.classList.remove('selected', 'editing', 'pending');
      c.querySelectorAll('.grip,.check-badge,.plot-edit-btn,.error-chip,.resize-handle').forEach(n => n.remove());
      const svg = e.querySelector('svg.plot-svg') as SVGSVGElement | null;
      if (svg) {
        const png = await svgToPng(svg, scale);
        const holder = c.querySelector('svg.plot-svg');
        if (png && holder) {
          const img = document.createElement('img');
          img.src = 'data:image/png;base64,' + bytesToB64(png.data);
          img.width = png.w; img.height = png.h;
          holder.replaceWith(img);
        }
      }
      c.style.left = `${e.offsetLeft - x0 + pad}px`; c.style.top = `${e.offsetTop - y0 + pad}px`;
      inner.push(c.outerHTML);
    }
    const page = document.querySelector('.page') as HTMLElement | null;
    const font = page ? getComputedStyle(page).fontSize : '15px';
    // the custom properties (colours, fonts) live on :root, which the picture does not have
    const rootCs = getComputedStyle(document.documentElement);
    const vars = Array.from(rootCs).filter(n => n.startsWith('--')).map(n => `${n}:${rootCs.getPropertyValue(n)}`).join(';').replace(/"/g, "'");
    const family = page ? getComputedStyle(page).fontFamily.replace(/"/g, "'") : 'sans-serif';
    const xhtml = `<div xmlns="http://www.w3.org/1999/xhtml" class="page no-grid" style="${vars};position:relative;width:${w}px;height:${h}px;font-size:${font};font-family:${family};color:#1d2330;background:#fff;transform:none;box-shadow:none;margin:0;background-image:none"><style>${css}
.region{border-color:transparent!important;background:transparent!important}</style>${inner.join('')}</div>`;
    const doc = new DOMParser().parseFromString(`<html><body>${xhtml}</body></html>`, 'text/html');
    const node = doc.body.firstElementChild!;
    const xml = new XMLSerializer().serializeToString(node);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="100%" height="100%">${xml}</foreignObject></svg>`;
    return rasterize('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), w, h, scale);
  });
}

/** Word document of the worksheet. */
export async function makeDocx(ws: Worksheet, result: ComputeResult | null): Promise<Blob> {
  const { buildDocx } = await import('../export/docx');
  const { store } = await import('./store');
  return withLightTheme(() => buildDocx(ws, {
    result,
    fileName: store.get().fileName,
    mathLatex: (r: MathRegion) => {
      const res = result?.results[r.id];
      // sliders arrive as definitions: no own formula result
      const stale = !res?.latex || (res.src !== undefined && res.src !== r.src);
      return composeLatex(r.src, stale ? { id: r.id } : res).latex;
    },
    plotPng: async (r: PlotRegion) => {
      const svg = regionElements.get(r.id)?.querySelector('svg.plot-svg') as SVGSVGElement | null;
      return svg ? svgToPng(svg, 2) : null;
    },
  }));
}
