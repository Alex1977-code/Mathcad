import { useMemo, useRef, useState } from 'react';
import { safeColor, type PlotRegion } from '../../engine/model';
import type { PlotData } from '../../engine/worksheet';
import { formatReal } from '../../engine/format';
import { IconEdit } from '../icons';
import { store } from '../store';

export const PLOT_COLORS = ['#3b5bdb', '#e03131', '#2f9e44', '#9c36b5', '#f08c00', '#0c8599', '#d6336c', '#495057'];

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

function logTicks(min: number, max: number): number[] {
  const out: number[] = [];
  if (!(min > 0 && max > 0 && isFinite(min) && isFinite(max))) return out;
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) out.push(Math.pow(10, e));
  return out.filter(v => v >= min * 0.999 && v <= max * 1.001);
}

const fmtTick = (v: number) => formatReal(v, { decimals: 4, expThreshold: 6, maxMatrix: 1 }).text;

interface Props { region: PlotRegion; data?: PlotData; onEdit: () => void }

export function PlotRegionView({ region, data, onEdit }: Props) {
  const W = region.w ?? 440, H = region.h ?? 270;
  const pad = { l: 58, r: 16, t: region.title ? 28 : 12, b: 42 };
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const geo = useMemo(() => {
    if (!data || !data.traces.length) return null;
    const finite = (a: number[], log: boolean) => a.filter(v => isFinite(v) && (!log || v > 0));
    const xs = data.traces.flatMap(t => finite(t.x, !!region.logX));
    const ys = data.traces.flatMap(t => finite(t.y, !!region.logY));
    if (!xs.length || !ys.length) return null;
    // limits that do not fit a logarithmic axis (≤ 0) are ignored
    const lim = (v: number | null, log: boolean) => (v === null || !isFinite(v) || (log && v <= 0) ? null : v);
    let x0 = lim(data.xLim[0], !!region.logX) ?? Math.min(...xs), x1 = lim(data.xLim[1], !!region.logX) ?? Math.max(...xs);
    let y0 = lim(data.yLim[0], !!region.logY) ?? Math.min(...ys), y1 = lim(data.yLim[1], !!region.logY) ?? Math.max(...ys);
    // "from" greater than "to": swap
    if (x0 > x1) [x0, x1] = [x1, x0];
    if (y0 > y1) [y0, y1] = [y1, y0];
    if (x0 === x1) { if (region.logX) { x0 /= 10; x1 *= 10; } else { x0 -= 1; x1 += 1; } }
    if (y0 === y1) { if (region.logY) { y0 /= 10; y1 *= 10; } else { const d = Math.abs(y0) * 0.1 || 1; y0 -= d; y1 += d; } }
    if (!region.logY && data.yLim[0] === null && data.yLim[1] === null) {
      const py = (y1 - y0) * 0.06; y0 -= py; y1 += py;
      const t = linearTicks(y0, y1, Math.max(3, Math.round((H - pad.t - pad.b) / 45)));
      if (t.length > 1) { const st = t[1] - t[0]; y0 = Math.min(y0, Math.floor(y0 / st) * st); y1 = Math.max(y1, Math.ceil(y1 / st) * st); }
    }
    const lx = (v: number) => (region.logX ? Math.log10(v) : v);
    const ly = (v: number) => (region.logY ? Math.log10(v) : v);
    const sx = (v: number) => pad.l + (lx(v) - lx(x0)) / (lx(x1) - lx(x0)) * (W - pad.l - pad.r);
    const sy = (v: number) => H - pad.b - (ly(v) - ly(y0)) / (ly(y1) - ly(y0)) * (H - pad.t - pad.b);
    const xt = region.logX ? logTicks(x0, x1) : linearTicks(x0, x1, Math.max(3, Math.round((W - pad.l - pad.r) / 80)));
    const yt = region.logY ? logTicks(y0, y1) : linearTicks(y0, y1, Math.max(3, Math.round((H - pad.t - pad.b) / 45)));
    const paths = data.traces.map(t => {
      const segs: string[] = [];
      let cur = '';
      for (let i = 0; i < t.x.length; i++) {
        const ok = isFinite(t.x[i]) && isFinite(t.y[i]) && (!region.logX || t.x[i] > 0) && (!region.logY || t.y[i] > 0);
        if (!ok) { if (cur) segs.push(cur); cur = ''; continue; }
        const px = sx(t.x[i]), py = Math.max(-1e4, Math.min(1e4, sy(t.y[i])));
        cur += (cur ? 'L' : 'M') + px.toFixed(2) + ' ' + py.toFixed(2);
      }
      if (cur) segs.push(cur);
      return segs.join(' ');
    });
    return { x0, x1, y0, y1, sx, sy, xt, yt, paths };
  }, [data, W, H, region.logX, region.logY, region.title]);

  const onMove = (e: React.MouseEvent) => {
    if (!geo || !data || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const z = store.get().zoom;
    const mx = (e.clientX - rect.left) / z, my = (e.clientY - rect.top) / z;
    let best: { d: number; text: string; x: number; y: number } | null = null;
    data.traces.forEach((t, ti) => {
      for (let i = 0; i < t.x.length; i++) {
        if (!isFinite(t.x[i]) || !isFinite(t.y[i])) continue;
        const px = geo.sx(t.x[i]), py = geo.sy(t.y[i]);
        const d = Math.hypot(px - mx, py - my);
        if (!best || d < best.d) best = { d, x: px, y: py, text: `${data.traces.length > 1 ? `${t.label}: ` : ''}x = ${fmtTick(t.x[i])}, y = ${fmtTick(t.y[i])}` };
      }
      void ti;
    });
    const b = best as { d: number; text: string; x: number; y: number } | null;
    setHover(b && b.d < 40 ? { x: b.x, y: b.y, text: b.text } : null);
  };

  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn icon plot-edit-btn" title="Diagramm bearbeiten" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onEdit(); }}><IconEdit /></button>
      {!geo ? (
        <div className="plot-empty" style={{ width: W, height: H }}>
          {region.traces.some(t => t.y.trim()) ? (data ? 'Keine darstellbaren Werte' : 'Wird berechnet …') : 'Diagramm: Ausdrücke über ✎ festlegen'}
        </div>
      ) : (
        <svg ref={svgRef} className="plot-svg" width={W} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <defs><clipPath id={`clip-${region.id}`}><rect x={pad.l} y={pad.t} width={plotW} height={plotH} /></clipPath></defs>
          {region.title && <text className="title" x={W / 2} y={16} textAnchor="middle">{region.title}</text>}
          <g className="grid">
            {geo.xt.map(v => <line key={'gx' + v} x1={geo.sx(v)} x2={geo.sx(v)} y1={pad.t} y2={H - pad.b} />)}
            {geo.yt.map(v => <line key={'gy' + v} y1={geo.sy(v)} y2={geo.sy(v)} x1={pad.l} x2={W - pad.r} />)}
          </g>
          {!region.logY && geo.y0 < 0 && geo.y1 > 0 && <line className="zero" x1={pad.l} x2={W - pad.r} y1={geo.sy(0)} y2={geo.sy(0)} />}
          {!region.logX && geo.x0 < 0 && geo.x1 > 0 && <line className="zero" y1={pad.t} y2={H - pad.b} x1={geo.sx(0)} x2={geo.sx(0)} />}
          <g className="axis">
            <rect x={pad.l} y={pad.t} width={plotW} height={plotH} fill="none" stroke="var(--border-strong)" />
            {geo.xt.map(v => <text key={'tx' + v} x={geo.sx(v)} y={H - pad.b + 15} textAnchor="middle">{fmtTick(v)}</text>)}
            {geo.yt.map(v => <text key={'ty' + v} x={pad.l - 6} y={geo.sy(v) + 4} textAnchor="end">{fmtTick(v)}</text>)}
          </g>
          <g clipPath={`url(#clip-${region.id})`}>
            {data!.traces.map((t, i) => {
              const color = safeColor(t.color) ?? PLOT_COLORS[i % PLOT_COLORS.length];
              const style = t.style ?? 'line';
              return (
                <g key={i}>
                  {style !== 'points' && <path d={geo.paths[i]} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />}
                  {style !== 'line' && t.x.map((x, k) => (isFinite(x) && isFinite(t.y[k]) && k % Math.max(1, Math.floor(t.x.length / 200)) === 0
                    ? <circle key={k} cx={geo.sx(x)} cy={geo.sy(t.y[k])} r={2.6} fill={color} /> : null))}
                </g>
              );
            })}
          </g>
          <text className="label" x={pad.l + plotW / 2} y={H - 8} textAnchor="middle">{data!.xLabel}</text>
          <text className="label" transform={`translate(13 ${pad.t + plotH / 2}) rotate(-90)`} textAnchor="middle">{data!.yLabel}</text>
          {data!.traces.length > 1 && (
            <g transform={`translate(${pad.l + 8} ${pad.t + 8})`}>
              {data!.traces.map((t, i) => (
                <g key={i} transform={`translate(0 ${i * 16})`}>
                  <rect x={-4} y={-9} width={Math.min(plotW - 10, 14 + t.label.length * 6.4)} height={15} fill="var(--page)" opacity={0.85} />
                  <line x1={0} x2={12} y1={-2} y2={-2} stroke={safeColor(t.color) ?? PLOT_COLORS[i % PLOT_COLORS.length]} strokeWidth={2.5} />
                  <text x={16} y={2}>{t.label}</text>
                </g>
              ))}
            </g>
          )}
          {hover && <circle cx={hover.x} cy={hover.y} r={4.5} fill="none" stroke="var(--text)" strokeWidth={1.5} />}
        </svg>
      )}
      {hover && <div className="plot-tooltip" style={{ left: hover.x + 10, top: hover.y - 30 }}>{hover.text}</div>}
      {data?.error && <div className="plot-error">⚠ {data.error}</div>}
    </div>
  );
}
