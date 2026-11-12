/** Polar, surface and contour plots (the X-Y plot lives in PlotRegionView). */
import { useEffect, useMemo, useRef, useState } from 'react';
import { safeColor, type PlotRegion } from '../../engine/model';
import type { PlotData } from '../../engine/worksheet';
import { store } from '../store';
import { DEFAULT_VIEW, PLOT_COLORS, SEQ_STEPS, SHORT_LABEL, contourSegments, fmtTick, linearTicks, polarRadius, seqFill, surfaceGeometry, zRange, type View } from './plot3d';

export interface PlotProps { region: PlotRegion; data?: PlotData; onEdit: () => void; selected?: boolean }

interface Hover { x: number; y: number; text: string }

/** Mouse position inside the SVG in its own (unzoomed) coordinates. */
function svgPoint(e: { clientX: number; clientY: number }, svg: SVGSVGElement) {
  const rect = svg.getBoundingClientRect();
  const z = store.get().zoom;
  return { x: (e.clientX - rect.left) / z, y: (e.clientY - rect.top) / z };
}

function Legend({ data, x, y, maxW }: { data: PlotData; x: number; y: number; maxW: number }) {
  if (data.traces.length < 2) return null;
  return (
    <g transform={`translate(${x} ${y})`}>
      {data.traces.map((t, i) => (
        <g key={i} transform={`translate(0 ${i * 16})`}>
          <rect x={-4} y={-9} width={Math.min(maxW, 14 + t.label.length * 6.4)} height={15} fill="var(--page)" opacity={0.85} />
          <line x1={0} x2={12} y1={-2} y2={-2} stroke={safeColor(t.color) ?? PLOT_COLORS[i % PLOT_COLORS.length]} strokeWidth={2.5} />
          <text x={16} y={2}>{t.label}</text>
        </g>
      ))}
    </g>
  );
}

/* ---------------------------------- polar ---------------------------------- */

export function PolarPlot({ region, data }: PlotProps) {
  const W = region.w ?? 440, H = region.h ?? 270;
  const top = region.title ? 28 : 10;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const cx = W / 2, cy = top + (H - top - 8) / 2;
  const R = Math.max(20, Math.min(W / 2 - 44, (H - top - 8) / 2 - 18));

  const geo = useMemo(() => {
    if (!data) return null;
    const rad = polarRadius(data.traces.flatMap(t => t.y), data.yLim);
    if (!rad) return null;
    const { r0, r1, ticks } = rad;
    /** Screen position of (angle, radius); a negative radius points the opposite way (as in Mathcad). */
    const pos = (phi: number, r: number): [number, number] | null => {
      if (!Number.isFinite(phi) || !Number.isFinite(r)) return null;
      let rho = r, a = phi;
      if (r0 === 0 && r < 0) { rho = -r; a += Math.PI; }
      const k = (rho - r0) / (r1 - r0);
      if (k < 0) return null;
      const kk = Math.min(k, 3);
      return [cx + R * kk * Math.cos(a), cy - R * kk * Math.sin(a)];
    };
    const paths = data.traces.map(t => {
      const segs: string[] = [];
      let cur = '';
      for (let i = 0; i < t.x.length; i++) {
        const p = pos(t.x[i], t.y[i]);
        if (!p) { if (cur) segs.push(cur); cur = ''; continue; }
        cur += (cur ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2);
      }
      if (cur) segs.push(cur);
      return segs.join(' ');
    });
    return { r0, r1, ticks, pos, paths };
  }, [data, W, H, region.title]);

  if (!geo || !data) return <div className="plot-empty" style={{ width: W, height: H }}>Keine darstellbaren Werte</div>;

  const onMove = (e: React.MouseEvent) => {
    if (!svgRef.current) return;
    const m = svgPoint(e, svgRef.current);
    let best: (Hover & { d: number }) | null = null;
    data.traces.forEach(t => {
      for (let i = 0; i < t.x.length; i++) {
        const p = geo.pos(t.x[i], t.y[i]);
        if (!p) continue;
        const d = Math.hypot(p[0] - m.x, p[1] - m.y);
        if (!best || d < best.d) best = { d, x: p[0], y: p[1], text: `${data.traces.length > 1 ? `${t.label}: ` : ''}Winkel = ${fmtTick(t.x[i] * 180 / Math.PI)}°, r = ${fmtTick(t.y[i])}` };
      }
    });
    const b = best as (Hover & { d: number }) | null;
    setHover(b && b.d < 40 ? { x: b.x, y: b.y, text: b.text } : null);
  };
  const spokes = Array.from({ length: 12 }, (_, i) => i * 30);
  const rk = (r: number) => R * (r - geo.r0) / (geo.r1 - geo.r0);
  return (
    <>
      <svg ref={svgRef} className="plot-svg polar" width={W} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs><clipPath id={`clip-${region.id}`}><circle cx={cx} cy={cy} r={R + 0.5} /></clipPath></defs>
        {region.title && <text className="title" x={W / 2} y={16} textAnchor="middle">{region.title}</text>}
        <g className="grid">
          {geo.ticks.map(t => <circle key={t} cx={cx} cy={cy} r={rk(t)} fill="none" />)}
          {spokes.map(a => <line key={a} x1={cx} y1={cy} x2={cx + R * Math.cos(a * Math.PI / 180)} y2={cy - R * Math.sin(a * Math.PI / 180)} />)}
        </g>
        <g className="axis">
          <circle cx={cx} cy={cy} r={R} fill="none" stroke="var(--border-strong)" />
          {spokes.map(a => {
            const c = Math.cos(a * Math.PI / 180), s = Math.sin(a * Math.PI / 180);
            return <text key={a} x={cx + (R + 9) * c} y={cy - (R + 9) * s + 4} textAnchor={c > 0.3 ? 'start' : c < -0.3 ? 'end' : 'middle'}>{a}°</text>;
          })}
          {geo.ticks.map(t => <text key={'r' + t} className="rtick" x={cx + rk(t) - 3} y={cy + 12} textAnchor="end">{fmtTick(t)}</text>)}
        </g>
        <g clipPath={`url(#clip-${region.id})`}>
          {data.traces.map((t, i) => {
            const color = safeColor(t.color) ?? PLOT_COLORS[i % PLOT_COLORS.length];
            const style = t.style ?? 'line';
            const every = Math.max(1, Math.floor(t.x.length / 200));
            return (
              <g key={i}>
                {style !== 'points' && <path d={geo.paths[i]} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />}
                {style !== 'line' && t.x.map((phi, k) => { const p = k % every === 0 ? geo.pos(phi, t.y[k]) : null; return p ? <circle key={k} cx={p[0]} cy={p[1]} r={2.6} fill={color} /> : null; })}
              </g>
            );
          })}
        </g>
        {data.traces.length === 1 && <text className="label" x={8} y={H - 6}>r = {data.yLabel}</text>}
        <Legend data={data} x={12} y={top + 10} maxW={W / 2} />
        {hover && <circle cx={hover.x} cy={hover.y} r={4.5} fill="none" stroke="var(--text)" strokeWidth={1.5} />}
      </svg>
      {hover && <div className="plot-tooltip" style={{ left: hover.x + 10, top: hover.y - 30 }}>{hover.text}</div>}
    </>
  );
}

/* -------------------------------- colour scale ------------------------------- */

function ColorScale({ x, y, h, z0, z1 }: { x: number; y: number; h: number; z0: number; z1: number }) {
  const step = h / SEQ_STEPS;
  return (
    <g className="colorscale">
      {Array.from({ length: SEQ_STEPS }, (_, i) => (
        <rect key={i} x={x} y={y + h - (i + 1) * step} width={10} height={step + 0.5} style={{ fill: `var(--seq-${i})` }} />
      ))}
      <rect x={x} y={y} width={10} height={h} fill="none" stroke="var(--border-strong)" />
      <g className="axis">
        {linearTicks(z0, z1, Math.max(2, Math.round(h / 40))).map(v => <text key={v} x={x + 14} y={y + h - (v - z0) / (z1 - z0) * h + 4}>{fmtTick(v)}</text>)}
      </g>
    </g>
  );
}

/** A long z expression does not fit at the axis: written as "z = …" above the plot. */
function LongZLabel({ data, x, y, maxW }: { data: PlotData; x: number; y: number; maxW: number }) {
  const label = data.zLabel ?? '';
  if (label.length <= SHORT_LABEL) return null;
  const max = Math.max(8, Math.floor(maxW / 6.2) - 4);
  return <text className="label" x={x} y={y}>z = {label.length > max ? label.slice(0, max - 1) + '…' : label}</text>;
}

/* --------------------------------- surface --------------------------------- */

export function SurfacePlot({ region, data, selected }: PlotProps) {
  const W = region.w ?? 440, H = region.h ?? 270;
  const top = (region.title ? 30 : 16) + ((data?.zLabel ?? '').length > SHORT_LABEL ? 14 : 0);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  /** View while the mouse rotates the plot; stored in the document when the button is released. */
  const [dragView, setDragView] = useState<View | null>(null);
  const view: View = dragView ?? { az: region.az ?? DEFAULT_VIEW.az, el: region.el ?? DEFAULT_VIEW.el };
  const s = data?.surface;
  const legendW = 58;
  const geo = useMemo(() => (s ? surfaceGeometry(s, view, { x: 44, y: top + 6, w: W - 44 - legendW - 26, h: H - top - 6 - 40 }, { x: data!.xLabel, y: data!.yLabel, z: data!.zLabel ?? 'z' }) : null),
    [s, view.az, view.el, W, H, top, data?.xLabel, data?.yLabel, data?.zLabel]);
  const dragging = useRef(false);
  useEffect(() => () => { dragging.current = false; }, []);

  if (!geo || !s) return <div className="plot-empty" style={{ width: W, height: H }}>Keine darstellbaren Werte</div>;

  /** Dragging inside the selected plot rotates the view (the first click selects, the frame moves the region). */
  const onMouseDown = (e: React.MouseEvent) => {
    if (!selected || e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) return;
    e.stopPropagation(); e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, ...view };
    let last: View = view;
    dragging.current = true;
    setHover(null);
    const move = (ev: MouseEvent) => {
      last = { az: start.az - (ev.clientX - start.x) * 0.5, el: Math.max(-89, Math.min(89, start.el + (ev.clientY - start.y) * 0.5)) };
      setDragView(last);
    };
    const up = () => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      dragging.current = false;
      if (last !== view) {
        const az = ((Math.round(last.az) % 360) + 360) % 360, el = Math.round(last.el);
        store.checkpoint();
        store.updateRegion(region.id, { az, el }, false);
      }
      setDragView(null);
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };
  const onMove = (e: React.MouseEvent) => {
    if (dragging.current || !svgRef.current) return;
    const q = (e.target as Element).getAttribute?.('data-q');
    if (q === null || q === undefined) { setHover(null); return; }
    const quad = geo.quads[Number(q)];
    if (!quad) return;
    const m = svgPoint(e, svgRef.current);
    const xm = (s.xs[quad.i] + s.xs[quad.i + 1]) / 2, ym = (s.ys[quad.j] + s.ys[quad.j + 1]) / 2;
    setHover({ x: m.x, y: m.y, text: `x = ${fmtTick(xm)}, y = ${fmtTick(ym)}, z = ${fmtTick(quad.z)}` });
  };
  return (
    <>
      <svg ref={svgRef} className={`plot-svg surface${selected ? ' rotatable' : ''}`} width={W} height={H} onMouseDown={onMouseDown} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {region.title && <text className="title" x={W / 2} y={16} textAnchor="middle">{region.title}</text>}
        <g className="grid">{geo.grid.map((l, i) => <line key={i} x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]} />)}</g>
        <g className="frame">{geo.frame.map((l, i) => <line key={i} x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]} />)}</g>
        <g className="mesh">
          {geo.quads.map((q, i) => <polygon key={i} data-q={i} points={q.pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')} style={{ fill: seqFill(q.t) }} />)}
        </g>
        <g className="axis">
          {geo.ticks.map((t, i) => <text key={i} x={t.x} y={t.y} textAnchor={t.anchor}>{t.text}</text>)}
        </g>
        {geo.labels.map((l, i) => <text key={i} className="label" x={l.x} y={l.y} textAnchor={l.anchor}>{l.text}</text>)}
        <LongZLabel data={data!} x={8} y={top - 2} maxW={W - 16} />
        <ColorScale x={W - legendW} y={top + 14} h={H - top - 14 - 44} z0={geo.z0} z1={geo.z1} />
      </svg>
      {hover && <div className="plot-tooltip" style={{ left: hover.x + 12, top: hover.y - 32 }}>{hover.text}</div>}
    </>
  );
}

/* --------------------------------- contour --------------------------------- */

export function ContourPlot({ region, data }: PlotProps) {
  const W = region.w ?? 440, H = region.h ?? 270;
  const legendW = 58;
  const longZ = (data?.zLabel ?? '').length > SHORT_LABEL;
  const pad = { l: 58, r: legendW + 18, t: (region.title ? 28 : 12) + (longZ ? 14 : 0), b: 42 };
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const s = data?.surface;
  const geo = useMemo(() => {
    const zr = s ? zRange(s) : null;
    if (!s || !zr || s.xs.length < 2 || s.ys.length < 2) return null;
    const [z0, z1] = zr;
    const x0 = s.xs[0], x1 = s.xs[s.xs.length - 1], y0 = s.ys[0], y1 = s.ys[s.ys.length - 1];
    const sx = (v: number) => pad.l + (v - x0) / (x1 - x0) * (W - pad.l - pad.r);
    const sy = (v: number) => H - pad.b - (v - y0) / (y1 - y0) * (H - pad.t - pad.b);
    const cells: { x: number; y: number; w: number; h: number; t: number }[] = [];
    for (let j = 0; j < s.ys.length - 1; j++) for (let i = 0; i < s.xs.length - 1; i++) {
      const zs = [s.z[j][i], s.z[j][i + 1], s.z[j + 1][i + 1], s.z[j + 1][i]];
      if (!zs.every(Number.isFinite)) continue;
      const z = Math.max(z0, Math.min(z1, (zs[0] + zs[1] + zs[2] + zs[3]) / 4));
      cells.push({ x: sx(s.xs[i]), y: sy(s.ys[j + 1]), w: sx(s.xs[i + 1]) - sx(s.xs[i]), h: sy(s.ys[j]) - sy(s.ys[j + 1]), t: (z - z0) / (z1 - z0) });
    }
    const levels = linearTicks(z0, z1, 9).filter(v => v > z0 && v < z1);
    const lines = levels.map(level => contourSegments(s, level).map(g => `M${sx(g[0]).toFixed(1)} ${sy(g[1]).toFixed(1)}L${sx(g[2]).toFixed(1)} ${sy(g[3]).toFixed(1)}`).join(''));
    const xt = linearTicks(x0, x1, Math.max(3, Math.round((W - pad.l - pad.r) / 80)));
    const yt = linearTicks(y0, y1, Math.max(3, Math.round((H - pad.t - pad.b) / 45)));
    return { z0, z1, x0, x1, y0, y1, sx, sy, cells, lines, xt, yt };
  }, [s, W, H, region.title, longZ]);

  if (!geo || !s || !data) return <div className="plot-empty" style={{ width: W, height: H }}>Keine darstellbaren Werte</div>;

  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
  const onMove = (e: React.MouseEvent) => {
    if (!svgRef.current) return;
    const m = svgPoint(e, svgRef.current);
    if (m.x < pad.l || m.x > pad.l + plotW || m.y < pad.t || m.y > pad.t + plotH) { setHover(null); return; }
    const fx = (m.x - pad.l) / plotW * (s.xs.length - 1), fy = (H - pad.b - m.y) / plotH * (s.ys.length - 1);
    const i = Math.round(fx), j = Math.round(fy);
    const z = s.z[j]?.[i];
    if (z === undefined || !Number.isFinite(z)) { setHover(null); return; }
    setHover({ x: geo.sx(s.xs[i]), y: geo.sy(s.ys[j]), text: `x = ${fmtTick(s.xs[i])}, y = ${fmtTick(s.ys[j])}, z = ${fmtTick(z)}` });
  };
  return (
    <>
      <svg ref={svgRef} className="plot-svg contour" width={W} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {region.title && <text className="title" x={W / 2} y={16} textAnchor="middle">{region.title}</text>}
        <g className="cells" shapeRendering="crispEdges">
          {geo.cells.map((c, i) => <rect key={i} x={c.x} y={c.y} width={c.w + 0.6} height={c.h + 0.6} style={{ fill: seqFill(c.t) }} />)}
        </g>
        <g className="iso">{geo.lines.map((d, i) => (d ? <path key={i} d={d} fill="none" /> : null))}</g>
        <g className="axis">
          <rect x={pad.l} y={pad.t} width={plotW} height={plotH} fill="none" stroke="var(--border-strong)" />
          {geo.xt.map(v => <text key={'tx' + v} x={geo.sx(v)} y={H - pad.b + 15} textAnchor="middle">{fmtTick(v)}</text>)}
          {geo.yt.map(v => <text key={'ty' + v} x={pad.l - 6} y={geo.sy(v) + 4} textAnchor="end">{fmtTick(v)}</text>)}
        </g>
        <text className="label" x={pad.l + plotW / 2} y={H - 8} textAnchor="middle">{data.xLabel}</text>
        <text className="label" transform={`translate(13 ${pad.t + plotH / 2}) rotate(-90)`} textAnchor="middle">{data.yLabel}</text>
        <text className="label" x={W - legendW + 5} y={pad.t + 8} textAnchor="middle">{(data.zLabel ?? 'z').length > SHORT_LABEL ? 'z' : data.zLabel ?? 'z'}</text>
        <ColorScale x={W - legendW} y={pad.t + 20} h={plotH - 20} z0={geo.z0} z1={geo.z1} />
        <LongZLabel data={data} x={pad.l} y={pad.t - 5} maxW={plotW} />
        {hover && <circle cx={hover.x} cy={hover.y} r={4.5} fill="none" stroke="var(--text)" strokeWidth={1.5} />}
      </svg>
      {hover && <div className="plot-tooltip" style={{ left: hover.x + 10, top: hover.y - 30 }}>{hover.text}</div>}
    </>
  );
}
