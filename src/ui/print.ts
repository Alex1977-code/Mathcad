/**
 * Print / PDF: the sheet is laid out on A4 pages of PAGE_H px. Before printing, regions that would be cut
 * by a page boundary move to the next page (whole rows together, so the order never changes), manual page
 * breaks start a new page, every page gets a footer (title · date · "Seite n von N"), and the light colour
 * scheme is used. Everything is undone after printing.
 */
import { MARGIN, PAGE_H, PAGE_W, regionElements } from './layout';
import { store } from './store';
import { fillTemplate, headerFooter, pageVars } from '../engine/pageinfo';

const TOP = 40;      // top margin on following pages
const FOOT = 44;     // space reserved for the footer at the bottom of each page

interface Saved { el: HTMLElement; top: string; display: string }
let saved: Saved[] = [];
let footers: HTMLElement[] = [];
let prevTheme: string | undefined;
let pageEl: HTMLElement | null = null;
let pageHeight = '';
let wrapHeight = '';
let pageWidth = '';
let active = false;

export function preparePrint() {
  if (active) return;
  active = true;
  const root = document.documentElement;
  prevTheme = root.dataset.theme;
  root.dataset.theme = 'light';
  pageEl = document.querySelector('.page') as HTMLElement | null;
  if (!pageEl) return;
  const s = store.get();
  // reading order; regions overlapping vertically form one row and move together
  const items = s.ws.regions
    .map(r => ({ r, el: regionElements.get(r.id) }))
    .filter((x): x is { r: typeof x.r; el: HTMLElement } => !!x.el)
    .map(x => ({ ...x, top: x.el.offsetTop, h: x.el.offsetHeight }))
    .sort((a, b) => a.top - b.top || a.el.offsetLeft - b.el.offsetLeft);
  // wider than A4 (imported sheets): scale to the page width, page height in sheet px grows accordingly
  // slightly too wide: shrink to fit; far wider (side calculations next to the page, as Mathcad users do):
  // print the page width only, like Mathcad's "Print single page width"
  const right = Math.max(PAGE_W, ...items.map(q => q.el.offsetLeft + q.el.offsetWidth + 24));
  const scale = Math.max(PAGE_W / right, 0.8);
  const PH = PAGE_H / scale, T = TOP / scale, F = FOOT / scale;
  const rows: (typeof items)[] = [];
  for (const it of items) {
    const last = rows[rows.length - 1];
    if (last && it.r.type !== 'pagebreak' && last[0].r.type !== 'pagebreak' && it.top < Math.max(...last.map(q => q.top + q.h)) - 2) last.push(it);
    else rows.push([it]);
  }
  let shift = 0, minNext = 0, maxBottom = 0;
  for (const row of rows) {
    const top = Math.min(...row.map(q => q.top)) + shift;
    const h = Math.max(...row.map(q => q.top + q.h)) + shift - top;
    let nt = Math.max(top, minNext);
    const k = Math.floor(nt / PH);
    const inPage = nt - k * PH;
    // crosses the bottom margin of its page → next page (unless it is taller than a page anyway)
    if (inPage + h > PH - F && h < PH - T - F) nt = (k + 1) * PH + T;
    else if (k > 0 && inPage < T) nt = k * PH + T;
    shift += nt - top;
    if (row[0].r.type === 'pagebreak') { minNext = (Math.floor(nt / PH) + 1) * PH + T; continue; }
    for (const q of row) {
      saved.push({ el: q.el, top: q.el.style.top, display: q.el.style.display });
      q.el.style.top = `${q.top + shift}px`;
      // outside the printed width: left out (Chrome would otherwise shrink every page to fit it)
      if (q.el.offsetLeft >= PAGE_W / scale - 8) q.el.style.display = 'none';
    }
    maxBottom = Math.max(maxBottom, nt + h);
  }
  const pages = Math.max(1, Math.ceil((maxBottom + F) / PH));
  pageHeight = pageEl.style.height;
  pageEl.style.height = `${pages * PH}px`;
  pageEl.style.setProperty('--print-scale', String(scale));
  pageWidth = pageEl.style.width;
  pageEl.style.width = `${PAGE_W / scale}px`;
  // the zoom wrapper around the page sets the printed height; the footers live there (unscaled)
  const wrap = pageEl.parentElement;
  wrapHeight = wrap?.style.height ?? '';
  if (wrap) { wrap.style.height = `${pages * PAGE_H}px`; wrap.style.position = 'relative'; }
  // header and footer on every page (left, centre, right; placeholders filled per page)
  const vars = pageVars(s.ws, s.fileName);
  const hf = headerFooter(s.ws);
  for (let k = 0; k < pages; k++) {
    for (const [kind, parts] of [['footer', hf.footer], ['header', hf.header]] as const) {
      const texts = parts.map(t => fillTemplate(t, vars, k + 1, pages));
      if (texts.every(t => !t.trim())) continue;
      const f = document.createElement('div');
      f.className = `print-footer print-${kind}`;
      f.style.cssText = `top:${kind === 'footer' ? (k + 1) * PAGE_H - 30 : k * PAGE_H + 14}px;left:${MARGIN}px;width:${PAGE_W - 2 * MARGIN}px`;
      for (const t of texts) { const sp = document.createElement('span'); sp.textContent = t; f.appendChild(sp); }
      (wrap ?? pageEl).appendChild(f);
      footers.push(f);
    }
  }
}

export function finishPrint() {
  if (!active) return;
  active = false;
  for (const s of saved) { s.el.style.top = s.top; s.el.style.display = s.display; }
  saved = [];
  footers.forEach(f => f.remove());
  footers = [];
  if (pageEl) {
    pageEl.style.height = pageHeight;
    pageEl.style.width = pageWidth;
    pageEl.style.removeProperty('--print-scale');
    if (pageEl.parentElement) { pageEl.parentElement.style.height = wrapHeight; pageEl.parentElement.style.position = ''; }
  }
  const root = document.documentElement;
  if (prevTheme === undefined) delete root.dataset.theme; else root.dataset.theme = prevTheme;
}

export function installPrintHooks() {
  window.addEventListener('beforeprint', preparePrint);
  window.addEventListener('afterprint', finishPrint);
}
