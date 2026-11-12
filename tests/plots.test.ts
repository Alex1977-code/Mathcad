// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { emptyWorksheet, normalizeWorksheet, type PlotRegion, type Region, type Worksheet } from '../src/engine/model';
import { computeWorksheet, type PlotData } from '../src/engine/worksheet';
import { contourSegments, polarRadius, surfaceGeometry, zRange, DEFAULT_VIEW } from '../src/ui/regions/plot3d';
import { emptyPlot, isAngleName, plottableFunction } from '../src/ui/smart';
import { plotKindPatch } from '../src/ui/SidePanel';
import { buildMcdx } from '../src/export/mcdx';

function plotOf(regions: Region[], id = 'p'): PlotData {
  const ws: Worksheet = emptyWorksheet();
  ws.regions = regions;
  const res = computeWorksheet(ws);
  return res.results[id].plot!;
}
const plot = (p: Partial<PlotRegion>): PlotRegion => ({ id: 'p', type: 'plot', x: 48, y: 200, w: 440, h: 300, traces: [], ...p });

describe('Polardiagramm', () => {
  it('tastet den Winkel ohne Angabe über eine volle Umdrehung ab', () => {
    const d = plotOf([plot({ kind: 'polar', traces: [{ x: 'φ', y: '1 + cos(φ)' }] })]);
    expect(d.kind).toBe('polar');
    expect(d.error).toBeUndefined();
    const t = d.traces[0];
    expect(t.x[0]).toBe(0);
    expect(t.x[t.x.length - 1]).toBeCloseTo(2 * Math.PI, 12);
    expect(t.y[0]).toBeCloseTo(2, 12);
    expect(Math.min(...t.y)).toBeCloseTo(0, 4);
  });
  it('nimmt Grenzen als Ausdrücke, Bereichsvariablen und Vektoren', () => {
    const d = plotOf([plot({ kind: 'polar', traces: [{ x: 't', y: 't' }], xmin: '0', xmax: '4*π' })]);
    expect(d.traces[0].x[d.traces[0].x.length - 1]).toBeCloseTo(4 * Math.PI, 12);
    const r = plotOf([
      { id: 'a', type: 'math', x: 48, y: 20, src: 'k := 0..4' },
      { id: 'b', type: 'math', x: 48, y: 60, src: 'w[k] := k*π/4' },
      plot({ kind: 'polar', traces: [{ x: 'w[k]', y: 'k + 1', style: 'points' }] }),
    ]);
    expect(r.error).toBeUndefined();
    expect(r.traces[0].y).toEqual([1, 2, 3, 4, 5]);
    expect(r.traces[0].x[4]).toBeCloseTo(Math.PI, 12);
  });
  it('rechnet den Radius in die gewünschte Einheit um', () => {
    const d = plotOf([
      { id: 'a', type: 'math', x: 48, y: 20, src: 'R(φ) := 2 m * (1 + sin(φ))' },
      plot({ kind: 'polar', traces: [{ x: 'φ', y: 'R(φ)' }], yUnit: 'cm' }),
    ]);
    expect(d.error).toBeUndefined();
    expect(Math.max(...d.traces[0].y)).toBeCloseTo(400, 6);
    expect(d.yLabel).toContain('[cm]');
  });
  it('wählt eine runde Radiusachse', () => {
    expect(polarRadius([0.2, 1.7, -1.9], [null, null])).toEqual({ r0: 0, r1: 2, ticks: [0.5, 1, 1.5, 2] });
    const lim = polarRadius([3], [1, 5])!;
    expect([lim.r0, lim.r1]).toEqual([1, 5]);
    expect(polarRadius([NaN], [null, null])).toBeNull();
  });
});

describe('3D-Fläche und Höhenlinien', () => {
  it('berechnet z über dem Gitter der beiden Variablen', () => {
    const d = plotOf([plot({ kind: 'surface', traces: [{ x: 'x', y: 'x^2 + 10*y' }], yVar: 'y', xmin: '0', xmax: '2', ymin: '-1', ymax: '1', grid: 4 })]);
    expect(d.kind).toBe('surface');
    expect(d.error).toBeUndefined();
    const s = d.surface!;
    expect(s.xs).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(s.ys).toEqual([-1, -0.5, 0, 0.5, 1]);
    // z[j][i] gehört zu ys[j] und xs[i]
    expect(s.z[0][4]).toBeCloseTo(4 - 10, 12);
    expect(s.z[4][1]).toBeCloseTo(0.25 + 10, 12);
    expect(d.xLabel).toBe('x');
    expect(d.yLabel).toBe('y');
  });
  it('nimmt den Namen einer Funktion f(x, y) und eigene Variablennamen', () => {
    const d = plotOf([
      { id: 'a', type: 'math', x: 48, y: 20, src: 'f(a, b) := a*b' },
      { id: 'b', type: 'math', x: 48, y: 60, src: 'x := 7' },
      plot({ kind: 'contour', traces: [{ x: 'x', y: 'f' }], xmin: '0', xmax: '2', ymin: '0', ymax: '3', grid: 4 }),
    ]);
    expect(d.error).toBeUndefined();
    // x ist im Blatt definiert und wird im Diagramm trotzdem abgetastet
    expect(d.surface!.z[4][4]).toBeCloseTo(6, 12);
    const e = plotOf([plot({ kind: 'surface', traces: [{ x: 'u', y: 'u - v' }], yVar: 'v', xmin: '0', xmax: '1', ymin: '0', ymax: '1', grid: 4 })]);
    expect(e.surface!.z[0][4]).toBeCloseTo(1, 12);
    expect(e.xLabel).toBe('u');
    // Höhenlinien rechnen ohne Angabe feiner als die Fläche
    expect(plotOf([plot({ kind: 'contour', traces: [{ x: 'x', y: 'x*y' }] })]).surface!.xs.length).toBe(61);
    expect(plotOf([plot({ kind: 'surface', traces: [{ x: 'x', y: 'x*y' }] })]).surface!.xs.length).toBe(31);
  });
  it('zeichnet eine Matrix (Zeilen entlang x, Spalten entlang y)', () => {
    const d = plotOf([
      { id: 'a', type: 'math', x: 48, y: 20, src: 'M := [1, 2, 3; 4, 5, 6]' },
      plot({ kind: 'surface', traces: [{ x: 'x', y: 'M' }] }),
    ]);
    expect(d.error).toBeUndefined();
    expect(d.surface!.xs).toEqual([0, 1]);
    expect(d.surface!.ys).toEqual([0, 1, 2]);
    expect(d.surface!.z).toEqual([[1, 4], [2, 5], [3, 6]]);
  });
  it('rechnet mit Einheiten auf allen drei Achsen', () => {
    const d = plotOf([
      { id: 'a', type: 'math', x: 48, y: 20, src: 'A(b, h) := b*h' },
      plot({ kind: 'surface', traces: [{ x: 'b', y: 'A(b, h)' }], yVar: 'h', xUnit: 'cm', yUnit: 'cm', zUnit: 'm^2', xmin: '0', xmax: '100', ymin: '0 m', ymax: '2 m', grid: 4 }),
    ]);
    expect(d.error).toBeUndefined();
    expect(d.surface!.ys[4]).toBeCloseTo(200, 9);
    expect(d.surface!.z[4][4]).toBeCloseTo(2, 9);
    expect(d.zLabel).toBe('A(b, h) [m^2]');
    expect(d.xLabel).toBe('b [cm]');
    // ohne z-Einheit: SI-Wert mit Angabe der Einheit
    const e = plotOf([plot({ kind: 'surface', traces: [{ x: 'b', y: 'b*h*1 kN' }], yVar: 'h', grid: 4 })]);
    expect(e.zLabel).toMatch(/\[.*\]/);
    const bad = plotOf([plot({ kind: 'surface', traces: [{ x: 'b', y: 'b*h*1 kN' }], yVar: 'h', zUnit: 'm', grid: 4 })]);
    expect(bad.error).toMatch(/Achseneinheit/);
  });
  it('meldet Fehler und lässt undefinierte Stellen leer', () => {
    const d = plotOf([plot({ kind: 'surface', traces: [{ x: 'x', y: 'sqrt(x)*unbekannt(y)' }] })]);
    expect(d.error).toBeTruthy();
    expect(d.surface).toBeUndefined();
    const same = plotOf([plot({ kind: 'surface', traces: [{ x: 'x', y: 'x' }], yVar: 'x' })]);
    expect(same.error).toMatch(/verschiedene Namen/);
    const empty = plotOf([plot({ kind: 'surface', traces: [{ x: 'x', y: '' }] })]);
    expect(empty.surface).toBeUndefined();
    expect(empty.error).toBeUndefined();
  });
  it('ordnet die Flächenstücke von hinten nach vorn und beschriftet die Achsen', () => {
    const d = plotOf([plot({ kind: 'surface', traces: [{ x: 'x', y: 'x*y' }], grid: 6 })]);
    const g = surfaceGeometry(d.surface!, DEFAULT_VIEW, { x: 40, y: 20, w: 300, h: 220 }, { x: 'x', y: 'y', z: 'x*y' })!;
    expect(g.quads.length).toBe(36);
    for (let i = 1; i < g.quads.length; i++) expect(g.quads[i - 1].depth).toBeGreaterThanOrEqual(g.quads[i].depth);
    // alles liegt im vorgesehenen Rechteck
    for (const q of g.quads) for (const [x, y] of q.pts) { expect(x).toBeGreaterThanOrEqual(39.9); expect(x).toBeLessThanOrEqual(340.1); expect(y).toBeGreaterThanOrEqual(19.9); expect(y).toBeLessThanOrEqual(240.1); }
    expect([g.z0, g.z1]).toEqual([-25, 25]);
    expect(g.labels.map(l => l.text)).toEqual(['x', 'y', 'x*y']);
    expect(g.ticks.some(t => t.text === '-4')).toBe(true);
    // andere Blickrichtung: andere Reihenfolge, gleiche Anzahl
    const g2 = surfaceGeometry(d.surface!, { az: 200, el: -30 }, { x: 40, y: 20, w: 300, h: 220 }, { x: 'x', y: 'y', z: 'z' })!;
    expect(g2.quads.length).toBe(36);
    expect(g2.quads[0].i === g.quads[0].i && g2.quads[0].j === g.quads[0].j).toBe(false);
  });
  it('findet Höhenlinien (Marching Squares)', () => {
    const s = { xs: [0, 1, 2], ys: [0, 1, 2], z: [[0, 1, 2], [0, 1, 2], [0, 1, 2]], zLim: [null, null] as [null, null] };
    // z = x: die Linie z = 0.5 ist die Senkrechte x = 0.5
    const seg = contourSegments(s, 0.5);
    expect(seg.length).toBe(2);
    for (const g of seg) { expect(g[0]).toBeCloseTo(0.5, 12); expect(g[2]).toBeCloseTo(0.5, 12); }
    expect(contourSegments(s, 5)).toEqual([]);
    expect(zRange(s)).toEqual([0, 2]);
    expect(zRange({ ...s, zLim: [null, 1] })).toEqual([0, 1]);
    // Kreis x² + y² = 1: alle Punkte der Linie liegen nahe am Kreis
    const xs = Array.from({ length: 41 }, (_, i) => -2 + i * 0.1);
    const circle = { xs, ys: xs, z: xs.map(y => xs.map(x => x * x + y * y)), zLim: [null, null] as [null, null] };
    const c = contourSegments(circle, 1);
    expect(c.length).toBeGreaterThan(20);
    for (const g of c) expect(Math.hypot(g[0], g[1])).toBeCloseTo(1, 1);
  });
});

describe('Diagrammarten: Bedienung, Speichern, Export', () => {
  it('speichert und lädt die Angaben der neuen Arten', () => {
    const ws = emptyWorksheet();
    ws.regions = [plot({ kind: 'surface', traces: [{ x: 'x', y: 'x*y' }], yVar: 'y', zmin: '-1', zmax: '1', zUnit: 'm', grid: 500, az: 120, el: 200 }), { ...plot({ kind: 'polar' }), id: 'q' }, { ...plot({}), id: 'r', kind: 'unsinn' as never }];
    const back = normalizeWorksheet(JSON.parse(JSON.stringify(ws)));
    const [a, b, c] = back.regions as PlotRegion[];
    expect(a.kind).toBe('surface');
    expect([a.yVar, a.zmin, a.zmax, a.zUnit, a.az]).toEqual(['y', '-1', '1', 'm', 120]);
    expect(a.grid).toBe(120);
    expect(a.el).toBe(90);
    expect(b.kind).toBe('polar');
    expect(c.kind).toBeUndefined();
  });
  it('bietet Funktionen passend an', () => {
    expect(plottableFunction('f(x) := x^2')).toEqual({ name: 'f', param: 'x' });
    expect(plottableFunction('g(x, y) := x*y')).toEqual({ name: 'g', param: 'x', param2: 'y' });
    expect(plottableFunction('h(a, b, c) := a')).toBeNull();
    expect(isAngleName('φ')).toBe(true);
    expect(isAngleName('x')).toBe(false);
    expect(emptyPlot('polar', 0, 0)).toMatchObject({ kind: 'polar', xmin: '0', xmax: '2*π', traces: [{ x: 'φ', y: '' }] });
    expect(emptyPlot('contour', 0, 0)).toMatchObject({ kind: 'contour', yVar: 'y', ymin: '-5', ymax: '5' });
    expect(emptyPlot('xy', 0, 0).kind).toBeUndefined();
  });
  it('passt beim Wechsel der Art die unveränderten Vorgaben an', () => {
    const xy = emptyPlot('xy', 0, 0);
    expect(plotKindPatch(xy, 'polar')).toMatchObject({ kind: 'polar', xmin: '0', xmax: '2*π', traces: [{ x: 'φ', y: '' }] });
    expect(plotKindPatch(xy, 'surface')).toMatchObject({ kind: 'surface', xmin: '-5', xmax: '5', ymin: '-5', ymax: '5' });
    // eigene Grenzen und Ausdrücke bleiben
    const own: PlotRegion = { ...xy, xmin: '0', xmax: '3', traces: [{ x: 'x', y: 'sin(x)' }] };
    const p = plotKindPatch(own, 'polar');
    expect(p.xmin).toBeUndefined();
    expect(p.traces).toBeUndefined();
    expect(plotKindPatch(emptyPlot('polar', 0, 0), 'xy')).toMatchObject({ kind: undefined, xmin: '-10', xmax: '10', traces: [{ x: 'x', y: '' }] });
    expect(plotKindPatch(emptyPlot('surface', 0, 0), 'contour')).toEqual({ kind: 'contour' });
  });
  it('übernimmt Polar- und 3D-Diagramme im Mathcad-Export als Bild oder Hinweis', async () => {
    const ws = emptyWorksheet();
    ws.regions = [plot({ kind: 'polar', traces: [{ x: 'φ', y: 'sin(2*φ)' }] }), { ...plot({ kind: 'surface', traces: [{ x: 'x', y: 'x*y' }] }), id: 's', y: 600 }];
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const withPng = await buildMcdx(ws, { plotPng: async r => (r.id === 's' ? { data: png, w: 440, h: 300 } : null) });
    expect(withPng.warnings.some(w => /3D-Diagramm als Bild/.test(w))).toBe(true);
    expect(withPng.warnings.some(w => /Polardiagramm als Hinweistext/.test(w))).toBe(true);
    const zip = await JSZip.loadAsync(await withPng.blob.arrayBuffer());
    const xml = await zip.file('mathcad/worksheet.xml')!.async('string');
    expect(xml).toContain('<picture>');
    expect(xml).not.toContain('<xyPlot>');
    expect(Object.keys(zip.files).some(n => /mathcad\/media\/Image1\.png$/.test(n))).toBe(true);
  });
});
