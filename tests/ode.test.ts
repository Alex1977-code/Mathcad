import { describe, it, expect } from 'vitest';
import { computeWorksheet, type RegionResult } from '../src/engine/worksheet';
import { emptyWorksheet } from '../src/engine/model';

function run(lines: string[]): RegionResult[] {
  const ws = emptyWorksheet();
  ws.regions = lines.map((src, i) => ({ id: `r${i}`, type: 'math' as const, x: 0, y: i * 20, src }));
  const res = computeWorksheet(ws, { keepValues: true });
  return lines.map((_, i) => res.results[`r${i}`]);
}
const val = (r: RegionResult): number => { if (r.error) throw new Error(r.error.message); return r.value as number; };
const last = (lines: string[]) => val(run(lines).pop()!);

describe('Differentialgleichungen', () => {
  it('Odesolve: Zerfall, Schwingung, Anfangspunkt ≠ 0', () => {
    expect(last(['Given', "y'(t) == -y(t)", 'y(0) == 1', 'y := Odesolve(t, 5)', 'y(2) ='])).toBeCloseTo(Math.exp(-2), 8);
    expect(last(['ω := 3', 'Given', "x''(t) + ω^2*x(t) == 0", 'x(0) == 1', "x'(0) == 0", 'x := Odesolve(t, 10)', 'x(2.5) ='])).toBeCloseTo(Math.cos(7.5), 7);
    // y' = t·y, y(1) = 2  →  y = 2·exp((t²−1)/2)
    expect(last(['Given', "y'(t) == t*y(t)", 'y(1) == 2', 'y := Odesolve(t, 3)', 'y(2.2) ='])).toBeCloseTo(2 * Math.exp((2.2 ** 2 - 1) / 2), 6);
    // the highest derivative may appear with a coefficient (linear)
    expect(last(['Given', "2*y'(t) + y(t) == 0", 'y(0) == 4', 'y := Odesolve(t, 4)', 'y(4) ='])).toBeCloseTo(4 * Math.exp(-2), 8);
  });

  it('Odesolve für Systeme: [x; y] := Odesolve([x; y], t, b)', () => {
    // x' = y, y' = −x  →  x = sin t, y = cos t
    const r = run(['Given', "x'(t) == y(t)", "y'(t) == -x(t)", 'x(0) == 0', 'y(0) == 1', '[x; y] := Odesolve([x; y], t, 6)', 'x(1.3) =', 'y(1.3) =']);
    expect(val(r[6])).toBeCloseTo(Math.sin(1.3), 7);
    expect(val(r[7])).toBeCloseTo(Math.cos(1.3), 7);
  });

  it('nichtlineare Gleichung und Verwendung der Lösung in Formeln', () => {
    // logistic: y' = y(1−y), y(0)=0.1 → y = 1/(1 + 9 e^(−t))
    expect(last(['Given', "y'(t) == y(t)*(1 - y(t))", 'y(0) == 0.1', 'y := Odesolve(t, 8)', 'y(3)*10 ='])).toBeCloseTo(10 / (1 + 9 * Math.exp(-3)), 6);
  });

  it('rkfixed (klassisches Runge-Kutta) und Rkadapt', () => {
    const r = run(['D(x, y) := [y[1]; -y[0]]', 'S := rkfixed([0; 1], 0, 3, 300, D)', 'S[300, 1] =', 'rows(S) =', 'A := Rkadapt([0; 1], 0, 3, 30, D)', 'A[30, 1] =', 'f(x, y) := -2*y', 'E := rkfixed(1, 0, 1, 10, f)', 'E[10, 1] =']);
    expect(val(r[2])).toBeCloseTo(Math.sin(3), 9);
    expect(val(r[3])).toBe(301);
    expect(val(r[5])).toBeCloseTo(Math.sin(3), 8);
    // RK4 with h = 0.1 on y' = −2y: one step factor 1 − 0.2 + 0.02 − 0.001333… + 0.0000666…
    const g = 1 - 0.2 + 0.02 - 0.2 ** 3 / 6 + 0.2 ** 4 / 24;
    expect(val(r[8])).toBeCloseTo(g ** 10, 12);
  });

  it('verständliche Fehlermeldungen', () => {
    const err = (lines: string[]) => run(lines).pop()!.error?.message ?? '';
    expect(err(['Given', "y'(t) == -y(t)", 'y := Odesolve(t, 5)'])).toMatch(/Anfangsbedingungen fehlen/);
    expect(err(['Given', "y'(t) == -y(t)", 'y(0) == 1', 'y := Odesolve(t, 5)', 'y(7) ='])).toMatch(/nur zwischen 0 und 5/);
    expect(err(['Given', "y''(t) == -y(t)", 'y(0) == 1', 'y := Odesolve(t, 5)'])).toMatch(/Anfangswert y'\(0\) fehlt/);
  });
});
