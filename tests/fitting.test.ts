import { describe, it, expect } from 'vitest';
import { computeWorksheet, type RegionResult } from '../src/engine/worksheet';
import { emptyWorksheet } from '../src/engine/model';
import { matrixRows } from '../src/engine/values';
import type { Matrix } from 'mathjs';

function run(lines: string[]): RegionResult[] {
  const ws = emptyWorksheet();
  ws.regions = lines.map((src, i) => ({ id: `r${i}`, type: 'math' as const, x: 0, y: i * 20, src }));
  const res = computeWorksheet(ws, { keepValues: true });
  return lines.map((_, i) => res.results[`r${i}`]);
}
const vals = (r: RegionResult): number[] => { if (r.error) throw new Error(r.error.message); return matrixRows(r.value as Matrix).flat() as number[]; };
const lastVec = (lines: string[]) => vals(run(lines).pop()!);
const xs = (f: (x: number) => number, n = 12, a = 0.5, h = 0.5) => { const x = Array.from({ length: n }, (_, i) => a + h * i); return { x: `[${x.join('; ')}]`, y: `[${x.map(v => +f(v).toPrecision(15)).join('; ')}]` }; };

describe('Kurvenanpassung', () => {
  it('regress + interp: Polynom exakt wiedergefunden', () => {
    const d = xs(x => 2 - 3 * x + 0.5 * x ** 2);
    const r = run([`vx := ${d.x}`, `vy := ${d.y}`, 'vs := regress(vx, vy, 2)', 'vs =', 'interp(vs, vx, vy, 1.75) =']);
    const vs = vals(r[3]);
    expect(vs.slice(0, 3)).toEqual([3, 3, 2]);
    expect(vs[3]).toBeCloseTo(2, 10); expect(vs[4]).toBeCloseTo(-3, 10); expect(vs[5]).toBeCloseTo(0.5, 10);
    expect(r[4].value as number).toBeCloseTo(2 - 3 * 1.75 + 0.5 * 1.75 ** 2, 10);
  });

  it('linfit mit eigenen Ansatzfunktionen', () => {
    const d = xs(x => 1.5 + 2 * Math.sin(x) - 0.25 * x ** 2);
    const c = lastVec([`vx := ${d.x}`, `vy := ${d.y}`, 'F(x) := [1; sin(x); x^2]', 'linfit(vx, vy, F) =']);
    expect(c[0]).toBeCloseTo(1.5, 9); expect(c[1]).toBeCloseTo(2, 9); expect(c[2]).toBeCloseTo(-0.25, 9);
  });

  it('genfit: Prime-Form F(x, a, b), Vektorform F(x, u) und Mathcad-15-Form mit Ableitungen', () => {
    const d = xs(x => 3 * Math.exp(-0.7 * x));
    const p1 = lastVec([`vx := ${d.x}`, `vy := ${d.y}`, 'F(x, a, b) := a*exp(-b*x)', 'genfit(vx, vy, [1; 1], F) =']);
    expect(p1[0]).toBeCloseTo(3, 7); expect(p1[1]).toBeCloseTo(0.7, 7);
    const p2 = lastVec([`vx := ${d.x}`, `vy := ${d.y}`, 'F(x, u) := u[0]*exp(-u[1]*x)', 'genfit(vx, vy, [1; 1], F) =']);
    expect(p2[0]).toBeCloseTo(3, 7);
    const p3 = lastVec([`vx := ${d.x}`, `vy := ${d.y}`, 'F(x, u) := [u[0]*exp(-u[1]*x); exp(-u[1]*x); -x*u[0]*exp(-u[1]*x)]', 'genfit(vx, vy, [1; 1], F) =']);
    expect(p3[1]).toBeCloseTo(0.7, 7);
  });

  it('expfit, lnfit, logfit, pwrfit, lgsfit, sinfit', () => {
    const check = (call: string, f: (x: number) => number, want: number[], digits = 6, n = 15) => {
      const d = xs(f, n);
      const p = lastVec([`vx := ${d.x}`, `vy := ${d.y}`, `${call} =`]);
      want.forEach((w, i) => expect(p[i], `${call}[${i}]`).toBeCloseTo(w, digits));
    };
    check('expfit(vx, vy)', x => 2 * Math.exp(0.3 * x) + 1, [2, 0.3, 1]);
    check('lnfit(vx, vy)', x => 4 * Math.log(x) - 1, [4, -1], 9);
    check('logfit(vx, vy, [1; 1; 0])', x => 2 * Math.log(x + 1.5) + 3, [2, 1.5, 3]);
    check('pwrfit(vx, vy, [1; 1; 0])', x => 1.5 * x ** 1.7 - 2, [1.5, 1.7, -2]);
    check('lgsfit(vx, vy, [5; 5; 1])', x => 10 / (1 + 20 * Math.exp(-1.2 * x)), [10, 20, 1.2], 5, 20);
    check('sinfit(vx, vy, [1; 0; 0])', x => 2.5 * Math.sin(x + 0.8) - 0.5, [2.5, 0.8, -0.5]);
  });

  it('Fehler bei zu wenigen Daten oder abhängigen Ansatzfunktionen', () => {
    const err = (lines: string[]) => run(lines).pop()!.error?.message ?? '';
    expect(err(['regress([1; 2], [1; 4], 3) ='])).toMatch(/zu wenige Daten/);
    expect(err(['F(x) := [x; 2*x]', 'linfit([1; 2; 3], [1; 2; 3], F) ='])).toMatch(/linear abhängig/);
  });
});
