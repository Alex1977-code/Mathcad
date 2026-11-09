import type { Region } from '../engine/model';

export const PAGE_W = 794;   // A4 at 96 dpi
export const PAGE_H = 1123;
export const MARGIN = 48;
export const SNAP = 6;

export const snap = (v: number) => Math.round(v / SNAP) * SNAP;

export interface Box { x: number; y: number; w: number; h: number }

/** Registry of rendered region elements (for measuring). */
export const regionElements = new Map<string, HTMLElement>();

export function measure(id: string, zoom: number): Box | null {
  const el = regionElements.get(id);
  if (!el) return null;
  const page = el.offsetParent as HTMLElement | null;
  if (!page) return null;
  return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
  void zoom;
}

/**
 * "Bereiche trennen": pushes overlapping regions down, like Mathcad's "Separate Regions".
 * All regions of one row move together and every row moves at least as far as the rows above it,
 * so the evaluation order (top to bottom, left to right) never changes.
 */
export function separateRegions(regions: Region[], boxOf: (r: Region) => Box | null, gap = 6): Region[] {
  const items = regions.filter(r => r.type !== 'pagebreak').map(r => ({ r, b: boxOf(r) ?? { x: r.x, y: r.y, w: r.w ?? 80, h: r.h ?? 24 } }));
  const key = (r: Region) => r.y + (r.oy ?? 0);
  items.sort((a, b) => (Math.abs(key(a.r) - key(b.r)) < 0.5 ? a.r.x - b.r.x : key(a.r) - key(b.r)));
  // group into rows (same evaluation-order y)
  const rows: typeof items[] = [];
  for (const it of items) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(key(last[0].r) - key(it.r)) < 0.5) last.push(it); else rows.push([it]);
  }
  const placed: Box[] = [];
  const shiftOf = new Map<string, number>();
  const xOf = new Map<string, number>();
  // within a row, regions keep their left-to-right order but must not overlap each other
  for (const row of rows) {
    let right = -Infinity;
    for (const it of row) {
      if (it.b.x < right + gap) { const nx = right + gap; xOf.set(it.r.id, it.r.x + (nx - it.b.x)); it.b = { ...it.b, x: nx }; }
      right = it.b.x + it.b.w;
    }
  }
  let offset = 0;
  for (const row of rows) {
    let shift = offset;
    for (let guard = 0; guard < 500; guard++) {
      let bump = 0;
      for (const { b } of row) {
        const y = b.y + shift;
        for (const p of placed) {
          if (b.x < p.x + p.w - 1 && b.x + b.w > p.x + 1 && y < p.y + p.h + gap - 0.5 && y + b.h > p.y) bump = Math.max(bump, p.y + p.h + gap - y);
        }
      }
      if (bump <= 0) break;
      shift += bump;
    }
    offset = shift;
    for (const { r, b } of row) { placed.push({ x: b.x, y: b.y + shift, w: b.w, h: b.h }); shiftOf.set(r.id, shift); }
  }
  return regions.map(r => {
    const sh = shiftOf.get(r.id);
    if (sh !== undefined) return { ...r, y: r.y + sh, x: xOf.get(r.id) ?? r.x } as Region;
    if (r.type === 'pagebreak') {
      // page breaks follow the content above them
      let sh2 = 0;
      for (const it of items) if (it.r.y <= r.y) sh2 = shiftOf.get(it.r.id) ?? sh2;
      return { ...r, y: r.y + sh2 } as Region;
    }
    return r;
  });
}

/** Count overlapping region pairs. */
export function countOverlaps(boxes: Box[]): number {
  let n = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.x < b.x + b.w - 1 && a.x + a.w > b.x + 1 && a.y < b.y + b.h - 1 && a.y + a.h > b.y + 1) n++;
  }
  return n;
}
