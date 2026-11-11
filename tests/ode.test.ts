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

  it('Randwertprobleme: Bedingungen am Anfangs- und Endpunkt (Schießverfahren)', () => {
    // y'' = −y, y(0) = 0, y(π/2) = 2  →  y = 2·sin t
    expect(last(['Given', "y''(t) == -y(t)", 'y(0) == 0', 'y(π/2) == 2', 'y := Odesolve(t, π/2)', 'y(0.7) ='])).toBeCloseTo(2 * Math.sin(0.7), 6);
    // beam: w'''' = q/EI, simply supported: w(0) = w''(0) = 0, w(L) = w''(L) = 0  →  w(L/2) = 5·q·L⁴/(384·EI)
    expect(last(['q := 3', 'EI := 2', 'L := 4', 'Given', "w''''(x) == q/EI", 'w(0) == 0', "w''(0) == 0", 'w(L) == 0', "w''(L) == 0", 'w := Odesolve(x, L)', 'w(L/2) ='])).toBeCloseTo(5 * 3 * 4 ** 4 / (384 * 2), 6);
    // nonlinear (Bratu): y'' + e^y = 0, y(0) = y(1) = 0  →  y(0.5) = 0.140539…
    expect(last(['Given', "y''(t) + exp(y(t)) == 0", 'y(0) == 0', 'y(1) == 0', 'y := Odesolve(t, 1)', 'y(0.5) ='])).toBeCloseTo(0.1405392, 5);
    // derivative condition at the end:  y'' = 2, y(0) = 1, y'(3) = 0  →  y = t² − 6t + 1
    expect(last(['Given', "y''(t) == 2", 'y(0) == 1', "y'(3) == 0", 'y := Odesolve(t, 3)', 'y(2) ='])).toBeCloseTo(4 - 12 + 1, 7);
    const err = (lines: string[]) => run(lines).pop()!.error?.message ?? '';
    expect(err(['Given', "y''(t) == -y(t)", 'y(0) == 0', 'y(1) == 2', 'y := Odesolve(t, 5)'])).toMatch(/Endpunkt 5 einer der beiden Punkte/);
  });

  it('Einheiten: Lösung und Argument tragen Einheiten, Gleichungen werden auf Dimension geprüft', () => {
    const txt = (lines: string[]) => { const r = run(lines).pop()!; return r.error ? 'ERROR: ' + r.error.message : r.resultText; };
    // v' = −g, v(0 s) = 10 m/s
    expect(txt(['Given', "v'(t) == -g", 'v(0 s) == 10 m/s', 'v := Odesolve(t, 2 s)', 'v(1 s) = m/s'])).toBe('0.193');
    // x'' = −g, x(0) = 0 m, x'(0) = 5 m/s
    expect(txt(['Given', "x''(t) == -g", 'x(0 s) == 0 m', "x'(0 s) == 5 m/s", 'x := Odesolve(t, 1 s)', 'x(0.5 s) = cm'])).toBe('127.417');
    // RC discharge with units of the time constant
    expect(txt(['R := 2 kΩ', 'C := 5 μF', 'Given', "u'(t) == -u(t)/(R*C)", 'u(0 s) == 12 V', 'u := Odesolve(t, 50 ms)', 'u(10 ms) = V'])).toBe('4.415');
    expect(txt(['Given', "y'(t) == 1 m", 'y(0 s) == 1 m', 'y := Odesolve(t, 2 s)'])).toMatch(/^ERROR: .*Einheit/);
  });

  it('Ableitungsoperator d/dt statt Strich', () => {
    expect(last(['Given', 'deriv(y(t), t) == -y(t)', 'y(0) == 1', 'y := Odesolve(t, 3)', 'y(1) ='])).toBeCloseTo(Math.exp(-1), 8);
    expect(last(['Given', 'deriv(y(t), t, 2) == -4*y(t)', 'y(0) == 0', "y'(0) == 2", 'y := Odesolve(t, 3)', 'y(1) ='])).toBeCloseTo(Math.sin(2), 7);
  });
});