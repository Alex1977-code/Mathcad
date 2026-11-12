/**
 * Geometry of the polar, surface and contour plots: tick positions, projection of a surface onto the
 * screen (drawn back to front), iso-lines by marching squares. No DOM – everything here is testable.
 */
import type { SurfaceData } from '../../engine/worksheet';
import { formatReal } from '../../engine/format';

export const PLOT_COLORS = ['#3b5bdb', '#e03131', '#2f9e44', '#9c36b5', '#f08c00', '#0c8599', '#d6336c', '#495057'];

/** Steps of the colour scale for heights (one hue; the colours themselves are CSS variables --seq-0 … --seq-12). */
export const SEQ_STEPS = 13;
export const seqIndex = (t: number) => Math.max(0, Math.min(SEQ_STEPS - 1, Math.floor(t * SEQ_STEPS)));
export const seqFill = (t: number) => `var(--seq-${seqIndex(t)})`;

function niceStep(range: number, target: number) {
  const raw = range / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const nice = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
  return nice * mag;
}

export function linearTicks(min: number, max: number, target = 6): number[] {
  if (!isFinite(min) || !isFinite(max)) return [];
  if (min === max) { min -= 1; max += 1; }
  const step = niceStep(max - min, target);
  const out: number[] = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

export const fmtTick = (v: number) => formatReal(v, { decimals: 4, expThreshold: 6, maxMatrix: 1 }).text;

/* ---------------------------------- polar ---------------------------------- */

/** Radial axis of a polar plot: from 0 (or the given lower limit) to a round upper value. */
export function polarRadius(rs: number[], lim: [number | null, number | null]): { r0: number; r1: number; ticks: number[] } | null {
  const finite = rs.filter(Number.isFinite).map(Math.abs);
  if (!finite.length && lim[1] === null) return null;
  const r0 = lim[0] !== null && Number.isFinite(lim[0]) ? lim[0] : 0;
  let r1 = lim[1] !== null && Number.isFinite(lim[1]) ? lim[1] : Math.max(...finite);
  if (!(r1 > r0)) r1 = r0 + (Math.abs(r0) || 1);
  let ticks = linearTicks(r0, r1, 4).filter(t => t > r0);
  if (lim[1] === null && ticks.length) {
    // round up to the next tick so that the curve does not touch the rim
    const step = ticks.length > 1 ? ticks[1] - ticks[0] : ticks[0] - r0;
    if (ticks[ticks.length - 1] < r1 - step * 1e-9) ticks.push(ticks[ticks.length - 1] + step);
    r1 = ticks[ticks.length - 1];
  }
  ticks = ticks.filter(t => t <= r1 * (1 + 1e-9));
  return { r0, r1, ticks };
}

/* --------------------------------- surface --------------------------------- */

/** Smallest and largest finite z value, widened to the given limits. */
export function zRange(s: SurfaceData): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (const row of s.z) for (const v of row) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (s.zLim[0] !== null) lo = s.zLim[0];
  if (s.zLim[1] !== null) hi = s.zLim[1];
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) { const d = Math.abs(lo) * 0.1 || 1; lo -= d; hi += d; }
  return [lo, hi];
}

export interface View { az: number; el: number }
export const DEFAULT_VIEW: View = { az: 35, el: 28 };

/** Longest z label written at the axis (longer ones are shown as "z = …" above the plot). */
export const SHORT_LABEL = 8;

/** Height of the box relative to its width and depth. */
const Z_ASPECT = 0.62;

/**
 * Projection of box coordinates (u, v along x and y in −0.5 … 0.5, w along z in −0.5 … 0.5) onto the screen:
 * [right, up, depth] – a larger depth is farther away from the viewer.
 */
export function projector(view: View): (u: number, v: number, w: number) => [number, number, number] {
  const a = view.az * Math.PI / 180, e = view.el * Math.PI / 180;
  const ca = Math.cos(a), sa = Math.sin(a), ce = Math.cos(e), se = Math.sin(e);
  return (u, v, w) => {
    const x = u * ca - v * sa, y = u * sa + v * ca, z = w * Z_ASPECT;
    return [x, y * se + z * ce, y * ce - z * se];
  };
}

export interface Quad { pts: [number, number][]; depth: number; t: number; i: number; j: number; z: number }
export interface Tick { x: number; y: number; text: string; anchor: 'start' | 'middle' | 'end' }
export interface SurfaceGeo {
  quads: Quad[];
  /** Lines of the box: floor and the two walls behind the surface. */
  grid: [number, number, number, number][];
  frame: [number, number, number, number][];
  ticks: Tick[];
  labels: { x: number; y: number; text: string; anchor: 'start' | 'middle' | 'end' }[];
  z0: number; z1: number;
}

/** Everything needed to draw a surface into the rectangle (x0, y0, w, h). */
export function surfaceGeometry(s: SurfaceData, view: View, rect: { x: number; y: number; w: number; h: number }, names: { x: string; y: string; z: string }): SurfaceGeo | null {
  const zr = zRange(s);
  const nx = s.xs.length, ny = s.ys.length;
  if (!zr || nx < 2 || ny < 2) return null;
  const [z0, z1] = zr;
  const p = projector(view);
  // scale: the eight corners of the box fit into the rectangle
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const u of [-0.5, 0.5]) for (const v of [-0.5, 0.5]) for (const w of [-0.5, 0.5]) {
    const [x, y] = p(u, v, w);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const scale = Math.min(rect.w / (maxX - minX), rect.h / (maxY - minY));
  const cx = rect.x + rect.w / 2 - (minX + maxX) / 2 * scale, cy = rect.y + rect.h / 2 + (minY + maxY) / 2 * scale;
  const S = (u: number, v: number, w: number): [number, number, number] => { const [x, y, d] = p(u, v, w); return [cx + x * scale, cy - y * scale, d]; };
  const ux = (i: number) => (s.xs[i] - s.xs[0]) / (s.xs[nx - 1] - s.xs[0]) - 0.5;
  const vy = (j: number) => (s.ys[j] - s.ys[0]) / (s.ys[ny - 1] - s.ys[0]) - 0.5;
  const wz = (z: number) => (Math.max(z0, Math.min(z1, z)) - z0) / (z1 - z0) - 0.5;

  const pts: ([number, number, number] | null)[][] = s.z.map((row, j) => row.map((z, i) => (Number.isFinite(z) ? S(ux(i), vy(j), wz(z)) : null)));
  const quads: Quad[] = [];
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = pts[j][i], b = pts[j][i + 1], c = pts[j + 1][i + 1], d = pts[j + 1][i];
    if (!a || !b || !c || !d) continue;
    const z = (s.z[j][i] + s.z[j][i + 1] + s.z[j + 1][i + 1] + s.z[j + 1][i]) / 4;
    quads.push({ pts: [[a[0], a[1]], [b[0], b[1]], [c[0], c[1]], [d[0], d[1]]], depth: (a[2] + b[2] + c[2] + d[2]) / 4, t: (Math.max(z0, Math.min(z1, z)) - z0) / (z1 - z0), i, j, z });
  }
  quads.sort((q1, q2) => q2.depth - q1.depth);

  // the walls behind the surface and the floor (the ceiling when seen from below)
  const backU = p(0.5, 0, 0)[2] >= p(-0.5, 0, 0)[2] ? 0.5 : -0.5;
  const backV = p(0, 0.5, 0)[2] >= p(0, -0.5, 0)[2] ? 0.5 : -0.5;
  const floorW = view.el >= 0 ? -0.5 : 0.5;
  const line = (a: [number, number, number], b: [number, number, number]): [number, number, number, number] => [a[0], a[1], b[0], b[1]];
  const grid: [number, number, number, number][] = [], frame: [number, number, number, number][] = [];
  const xt = linearTicks(s.xs[0], s.xs[nx - 1], 5), yt = linearTicks(s.ys[0], s.ys[ny - 1], 5), zt = linearTicks(z0, z1, 5);
  const tu = (x: number) => (x - s.xs[0]) / (s.xs[nx - 1] - s.xs[0]) - 0.5;
  const tv = (y: number) => (y - s.ys[0]) / (s.ys[ny - 1] - s.ys[0]) - 0.5;
  const tw = (z: number) => (z - z0) / (z1 - z0) - 0.5;
  for (const x of xt) { grid.push(line(S(tu(x), -0.5, floorW), S(tu(x), 0.5, floorW))); grid.push(line(S(tu(x), backV, -0.5), S(tu(x), backV, 0.5))); }
  for (const y of yt) { grid.push(line(S(-0.5, tv(y), floorW), S(0.5, tv(y), floorW))); grid.push(line(S(backU, tv(y), -0.5), S(backU, tv(y), 0.5))); }
  for (const z of zt) { grid.push(line(S(-0.5, backV, tw(z)), S(0.5, backV, tw(z)))); grid.push(line(S(backU, -0.5, tw(z)), S(backU, 0.5, tw(z)))); }
  for (const w of [-0.5, 0.5]) { frame.push(line(S(-0.5, backV, w), S(0.5, backV, w))); frame.push(line(S(backU, -0.5, w), S(backU, 0.5, w))); }
  for (const [u, v] of [[backU, backV], [-backU, backV], [backU, -backV]] as const) frame.push(line(S(u, v, -0.5), S(u, v, 0.5)));
  frame.push(line(S(-0.5, -backV, floorW), S(0.5, -backV, floorW)));
  frame.push(line(S(-backU, -0.5, floorW), S(-backU, 0.5, floorW)));

  // tick labels on the two front edges of the floor and on the vertical edge farthest to the left
  const centre = S(0, 0, floorW);
  const anchorOf = (x: number): Tick['anchor'] => (x < centre[0] - 12 ? 'end' : x > centre[0] + 12 ? 'start' : 'middle');
  const ticks: Tick[] = [];
  const outwardX = (u: number, dist: number) => { const pt = S(u, -backV, floorW); const q = S(u, -backV * 1.2, floorW); const len = Math.hypot(q[0] - pt[0], q[1] - pt[1]) || 1; return [pt[0] + (q[0] - pt[0]) / len * dist, pt[1] + (q[1] - pt[1]) / len * dist + 4] as [number, number]; };
  const outwardY = (v: number, dist: number) => { const pt = S(-backU, v, floorW); const q = S(-backU * 1.2, v, floorW); const len = Math.hypot(q[0] - pt[0], q[1] - pt[1]) || 1; return [pt[0] + (q[0] - pt[0]) / len * dist, pt[1] + (q[1] - pt[1]) / len * dist + 4] as [number, number]; };
  for (const x of xt) { const [tx, ty] = outwardX(tu(x), 13); ticks.push({ x: tx, y: ty, text: fmtTick(x), anchor: anchorOf(tx) }); }
  for (const y of yt) { const [tx, ty] = outwardY(tv(y), 13); ticks.push({ x: tx, y: ty, text: fmtTick(y), anchor: anchorOf(tx) }); }
  const zEdges = [[-backU, backV], [backU, -backV]] as const;
  const zEdge = S(zEdges[0][0], zEdges[0][1], 0)[0] <= S(zEdges[1][0], zEdges[1][1], 0)[0] ? zEdges[0] : zEdges[1];
  for (const z of zt) {
    // a tick right at the floor would collide with the labels of the floor edge that ends there
    if (Math.abs(tw(z) - floorW) < 0.06) continue;
    const pt = S(zEdge[0], zEdge[1], tw(z));
    ticks.push({ x: pt[0] - 6, y: pt[1] + 4, text: fmtTick(z), anchor: 'end' });
  }
  const lx = outwardX(0, 32), ly = outwardY(0, 32);
  const zTop = S(zEdge[0], zEdge[1], 0.5);
  const labels = [
    { x: lx[0], y: lx[1], text: names.x, anchor: anchorOf(lx[0]) },
    { x: ly[0], y: ly[1], text: names.y, anchor: anchorOf(ly[0]) },
    { x: zTop[0] - 4, y: zTop[1] - 9, text: names.z.length > SHORT_LABEL ? 'z' : names.z, anchor: 'middle' as const },
  ];
  return { quads, grid, frame, ticks, labels, z0, z1 };
}

/* --------------------------------- contour --------------------------------- */

/** Iso-line of a level through the grid (marching squares): segments in data coordinates. */
export function contourSegments(s: SurfaceData, level: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  const nx = s.xs.length, ny = s.ys.length;
  const cut = (xa: number, ya: number, za: number, xb: number, yb: number, zb: number): [number, number] => {
    const t = (level - za) / (zb - za);
    return [xa + (xb - xa) * t, ya + (yb - ya) * t];
  };
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const z00 = s.z[j][i], z10 = s.z[j][i + 1], z11 = s.z[j + 1][i + 1], z01 = s.z[j + 1][i];
    if (!Number.isFinite(z00) || !Number.isFinite(z10) || !Number.isFinite(z11) || !Number.isFinite(z01)) continue;
    const x0 = s.xs[i], x1 = s.xs[i + 1], y0 = s.ys[j], y1 = s.ys[j + 1];
    const code = (z00 > level ? 1 : 0) | (z10 > level ? 2 : 0) | (z11 > level ? 4 : 0) | (z01 > level ? 8 : 0);
    if (code === 0 || code === 15) continue;
    const bottom = () => cut(x0, y0, z00, x1, y0, z10), right = () => cut(x1, y0, z10, x1, y1, z11);
    const top = () => cut(x0, y1, z01, x1, y1, z11), left = () => cut(x0, y0, z00, x0, y1, z01);
    const seg = (a: [number, number], b: [number, number]) => out.push([a[0], a[1], b[0], b[1]]);
    switch (code) {
      case 1: case 14: seg(left(), bottom()); break;
      case 2: case 13: seg(bottom(), right()); break;
      case 3: case 12: seg(left(), right()); break;
      case 4: case 11: seg(right(), top()); break;
      case 6: case 9: seg(bottom(), top()); break;
      case 7: case 8: seg(left(), top()); break;
      case 5: case 10: {
        // saddle: decided by the value in the middle of the cell
        const mid = (z00 + z10 + z11 + z01) / 4 > level;
        if ((code === 5) === mid) { seg(left(), top()); seg(bottom(), right()); } else { seg(left(), bottom()); seg(right(), top()); }
        break;
      }
    }
  }
  return out;
}
