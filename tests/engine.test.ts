import { describe, it, expect } from 'vitest';
import { parseMathRegion, parseExpression } from '../src/engine/parser';
import { stmtToText } from '../src/engine/serialize';
import { computeWorksheet, type RegionResult } from '../src/engine/worksheet';
import { emptyWorksheet, sortRegions, type Worksheet } from '../src/engine/model';
import { formatReal } from '../src/engine/format';
import { stmtLatex } from '../src/engine/latex';
import katex from 'katex';
import { isUnit, isMatrix, type Val } from '../src/engine/values';
import type { Matrix, Unit } from 'mathjs';

function sheet(lines: string[]): Worksheet {
  const ws = emptyWorksheet();
  ws.regions = lines.map((src, i) => ({ id: `r${i}`, type: 'math' as const, x: 0, y: i * 20, src }));
  return ws;
}
function run(lines: string[]): RegionResult[] {
  const ws = sheet(lines);
  const res = computeWorksheet(ws, { keepValues: true });
  return lines.map((_, i) => res.results[`r${i}`]);
}
/** Result text of the last line. */
function last(lines: string[]): string {
  const r = run(lines);
  const l = r[r.length - 1];
  if (l.error) return 'ERROR: ' + l.error.message;
  return l.resultText ?? '';
}
function lastVal(lines: string[]): Val {
  const r = run(lines);
  const l = r[r.length - 1];
  if (l.error) throw new Error(l.error.message);
  return l.value!;
}
const si = (v: Val) => (isUnit(v) ? (v as Unit).value as number : v as number);

describe('parser', () => {
  it('parses definitions, evaluations and functions', () => {
    expect(parseMathRegion('x := 5').kind).toBe('define');
    expect(parseMathRegion('x =').kind).toBe('eval');
    const f = parseMathRegion('f(x, y) := x^2 + y');
    expect(f.kind === 'define' && f.target.params).toEqual(['x', 'y']);
    const g = parseMathRegion('a ≡ 3');
    expect(g.kind === 'define' && g.global).toBe(true);
    const e = parseMathRegion('F = kN');
    expect(e.kind === 'eval' && e.unit?.k).toBe('id');
  });
  it('round-trips through the serializer', () => {
    const cases = [
      'x := 5 m', 'y := -x^2 + 3*x - 1', 'f(t) := sin(ω t + φ)/2', 'A := [1, 2; 3, 4]',
      'z := (a + b)/(c - d)', 'v := A^T', 'r := nthroot(27, 3)', 's := sum(i^2, i, 1, 10)',
      'q := int(x^2, x, 0, 1)', 'k := |v|', 'i := 0, 0.5 .. 10', 'w := 2^-1', 'b := a ≤ 3 ∧ c ≠ 2',
      'σ_c.d := 0.6 f_cd', 'm := A[1, 0] + v[2]', 'c := A<<1>>', 'p := 10%', 'n := 5!', 'x := 2 - (3 - 4)',
      'y := a/(b/c)', 'z := 1.5e-3', 'c := 3 + 2i', 'u := vec(a*b)',
    ];
    for (const c of cases) {
      const s1 = parseMathRegion(c);
      const t = stmtToText(s1);
      const s2 = parseMathRegion(t);
      expect(JSON.stringify(stripRaw(s2)), c + ' → ' + t).toEqual(JSON.stringify(stripRaw(s1)));
    }
  });
  it('parses programs by indentation', () => {
    const p = parseMathRegion('f(n) :=\n  s ← 0\n  for i ∈ 1..n\n    s ← s + i\n  return s');
    expect(p.kind).toBe('define');
    if (p.kind === 'define') expect(p.expr.k).toBe('program');
  });
  it('reports parse errors with position', () => {
    expect(() => parseExpression('3 + * 4')).toThrow();
    expect(() => parseExpression('(1 + 2')).toThrow(/„\)“ erwartet/);
  });
  it('treats 2in as two inches and 2i as imaginary', () => {
    expect(parseExpression('2in').k).toBe('bin');
    expect(parseExpression('2i').k).toBe('imag');
  });
});

function stripRaw(x: unknown): unknown {
  return JSON.parse(JSON.stringify(x, (k, v) => (k === 'raw' || k === 'implicit' ? undefined : v)));
}

describe('evaluation basics', () => {
  it('arithmetic and precedence', () => {
    expect(last(['2 + 3*4 ='])).toBe('14');
    expect(last(['-2^2 ='])).toBe('-4');
    expect(last(['2^3^2 ='])).toBe('512');
    expect(last(['(1 + 2)/(3 + 4) ='])).toBe('0.429');
    expect(last(['10 - 2 - 3 ='])).toBe('5');
    expect(last(['5! ='])).toBe('120');
    expect(last(['√(16) + nthroot(-27, 3) ='])).toBe('1');
  });
  it('variables, functions and Mathcad definition-time binding', () => {
    expect(last(['a := 1', 'f(x) := x + a', 'a := 2', 'f(1) ='])).toBe('2');
    expect(last(['a := 2', 'f(x) := x + a', 'f(1) ='])).toBe('3');
    expect(last(['f(x) := x^2', 'g(x) := f(x) + 1', 'g(3) ='])).toBe('10');
  });
  it('global definitions are visible everywhere', () => {
    expect(last(['y := k*2', 'k ≡ 21', 'y ='])).toBe('42');
  });
  it('undefined variables give an error naming the culprit', () => {
    const r = run(['y := q + 1']);
    expect(r[0].error?.message).toMatch(/„q“ ist nicht definiert/);
    expect(r[0].error?.culprit).toBe('q');
  });
  it('recursion', () => {
    expect(last(['fact(n) := if(n ≤ 1, 1, n*fact(n - 1))', 'fact(10) ='])).toBe('3628800');
  });
  it('trig and constants', () => {
    expect(last(['sin(π/6) ='])).toBe('0.5');
    expect(last(['cos(60 deg) ='])).toBe('0.5');
    expect(last(['atan2(1, 1) = deg'])).toBe('45');
    expect(last(['e^1 ='])).toBe('2.718');
    expect(last(['ln(e^2) ='])).toBe('2');
    expect(last(['log(1000) ='])).toBe('3');
  });
  it('complex numbers', () => {
    expect(last(['(1 + 2i)*(3 - 1i) ='])).toBe('5 + 5i');
    expect(last(['√(-4) ='])).toBe('2i');
    expect(last(['e^(π*1i) + 1 ='])).toBe('0');
  });
  it('strings', () => {
    expect(last(['s := "abc"', 'concat(s, "def") ='])).toBe('"abcdef"');
    expect(last(['strlen("Hallo") ='])).toBe('5');
  });
});

describe('units', () => {
  it('derives SI units', () => {
    expect(last(['F := 5 kN', 'L := 2 m', 'F*L ='])).toBe('10000 J');
    expect(last(['F := 10 kN', 'A := 100 mm * 100 mm', 'F/A ='])).toBe('1000000 Pa');
    expect(last(['(10 kN)/(100 mm)^2 = MPa'])).toBe('1');
    expect(last(['v := 36 km/hr', 'v ='])).toBe('10 m/s');
    expect(last(['q := 5 kN/m', 'q ='])).toBe('5000 N/m');
    expect(last(['ρ := 7850 kg/m^3', 'ρ ='])).toBe('7850 kg/m³');
    expect(last(['g ='])).toBe('9.807 m/s²');
    expect(last(['λ := 50 W/(m*K)', 'λ ='])).toBe('50 W/(m·K)');
  });
  it('converts to display units', () => {
    expect(last(['x := 1500 mm', 'x = m'])).toBe('1.5');
    expect(last(['x := 1 in', 'x = mm'])).toBe('25.4');
    expect(last(['M := 12 kN*m', 'M = kN*m'])).toBe('12');
    expect(last(['σ := 235 MPa', 'σ = N/mm^2'])).toBe('235');
    expect(last(['T := 20 °C', 'T = K'])).toBe('293.15');
    expect(last(['T := 300 K', 'T = °C'])).toBe('26.85');
    expect(last(['p := 1 atm', 'p = kPa'])).toBe('101.325');
  });
  it('rejects incompatible units', () => {
    expect(last(['1 m + 1 s ='])).toMatch(/ERROR: Einheiten passen nicht/);
  });
  it('units cancel to plain numbers', () => {
    expect(last(['(6 m)/(2 m) ='])).toBe('3');
    expect(last(['ω := 3000 rpm', 'ω = 1/s'])).toBe('314.159');
  });
  it('user definitions shadow units (Mathcad behaviour)', () => {
    expect(last(['m := 3', 'm*2 ='])).toBe('6');
  });
  it('square roots of units', () => {
    expect(last(['A := 16 m^2', '√(A) ='])).toBe('4 m');
  });
  it('define with inline display', () => {
    const r = run(['b := 300 mm = cm']);
    expect(r[0].resultText).toBe('30');
  });
});

describe('vectors and matrices', () => {
  it('matrix algebra', () => {
    expect(last(['A := [1, 2; 3, 4]', 'A^-1 ='])).toBe('[-2, 1; 1.5, -0.5]');
    expect(last(['A := [1, 2; 3, 4]', '|A| ='])).toBe('-2');
    expect(last(['A := [1, 2; 3, 4]', 'A^T ='])).toBe('[1, 3; 2, 4]');
    expect(last(['A := [1, 2; 3, 4]', 'b := [5; 6]', 'A*b ='])).toBe('[17; 39]');
    expect(last(['A := [2, 1; 1, 3]', 'b := [3; 5]', 'lsolve(A, b) ='])).toBe('[0.8; 1.4]');
  });
  it('vectors: dot product, norm, cross, indexing with ORIGIN 0', () => {
    expect(last(['v := [1; 2; 3]', 'w := [4; 5; 6]', 'v*w ='])).toBe('32');
    expect(last(['v := [3; 4]', '|v| ='])).toBe('5');
    expect(last(['v := [1; 0; 0]', 'w := [0; 1; 0]', 'v × w ='])).toBe('[0; 0; 1]');
    expect(last(['v := [10; 20; 30]', 'v[2] ='])).toBe('30');
    expect(last(['A := [1, 2; 3, 4]', 'A[1, 0] ='])).toBe('3');
    expect(last(['A := [1, 2; 3, 4]', 'A<<1>> ='])).toBe('[2; 4]');
    expect(last(['v := [1; 2; 3]', 'length(v) + last(v) ='])).toBe('5');
  });
  it('element assignment grows vectors', () => {
    expect(last(['v[3] := 7', 'v ='])).toBe('[0; 0; 0; 7]');
  });
  it('vectorize', () => {
    expect(last(['a := [1; 2; 3]', 'b := [4; 5; 6]', 'vec(a*b) ='])).toBe('[4; 10; 18]');
  });
  it('matrices with units', () => {
    expect(last(['F := [1; 2] * kN', 'F ='])).toBe('[1000; 2000] N');
    expect(last(['F := [1; 2] * kN', 'F = kN'])).toBe('[1; 2]');
  });
  it('statistics and aggregation', () => {
    expect(last(['v := [1; 2; 3; 4]', 'mean(v) ='])).toBe('2.5');
    expect(last(['v := [1; 2; 3; 4]', 'Stdev(v) ='])).toBe('1.291');
    expect(last(['v := [1; 2; 3; 4]', 'stdev(v) ='])).toBe('1.118');
    expect(last(['max(3, [1; 9], 2) ='])).toBe('9');
    expect(last(['max(2 m, 50 cm) ='])).toBe('2 m');
    expect(last(['v := [3; 1; 2]', 'sort(v) ='])).toBe('[1; 2; 3]');
    expect(last(['sum([1; 2; 3]) ='])).toBe('6');
  });
});

describe('range variables', () => {
  it('evaluates expressions over ranges', () => {
    expect(last(['i := 0..3', 'i^2 ='])).toBe('[0; 1; 4; 9]');
    expect(last(['x := 0, 0.5 .. 2', 'x ='])).toBe('[0; 0.5; 1; 1.5; 2]');
  });
  it('builds vectors by indexed definition', () => {
    expect(last(['i := 0..4', 'v[i] := i*10', 'v ='])).toBe('[0; 10; 20; 30; 40]');
  });
  it('range sums', () => {
    expect(last(['sum(i^2, i, 1, 10) ='])).toBe('385');
    expect(last(['i := 1..4', 'sum(i, i) ='])).toBe('10');
    expect(last(['prod(k, k, 1, 5) ='])).toBe('120');
  });
});

describe('calculus and solving', () => {
  it('integrals', () => {
    expect(last(['int(x^2, x, 0, 3) ='])).toBe('9');
    expect(last(['int(sin(x), x, 0, π) ='])).toBe('2');
    expect(last(['int(e^(-x^2), x, -∞, ∞) ='])).toBe('1.772');
    expect(last(['int(5 N, x, 0 m, 2 m) ='])).toBe('10 J');
  });
  it('derivatives', () => {
    expect(last(['x := 2', 'deriv(x^3, x) ='])).toBe('12');
    expect(last(['x := 1', 'deriv(sin(x), x, 2) ='])).toBe('-0.841');
    expect(last(['t := 2 s', 'deriv(5 m/s^2 * t^2, t) ='])).toBe('20 m/s');
  });
  it('root finding', () => {
    expect(last(['x := 1', 'root(x^2 - 2, x) ='])).toBe('1.414');
    expect(last(['root(cos(x) - x, x, 0, 1) ='])).toBe('0.739');
    expect(last(['L := 1 m', 'root(L^2 - 4 m^2, L) ='])).toBe('2 m');
    expect(last(['polyroots([-6; 11; -6; 1]) ='])).toBe('[1; 2; 3]');
  });
  it('solve blocks (Given / Find)', () => {
    expect(last(['x := 1', 'y := 1', 'Given', 'x^2 + y^2 == 25', 'x - y == 1', 'Find(x, y) ='])).toBe('[4; 3]');
  });
});

describe('programs', () => {
  it('loops and conditionals', () => {
    expect(last(['f(n) :=\n  s ← 0\n  for i ∈ 1..n\n    s ← s + i\n  s', 'f(100) ='])).toBe('5050');
    expect(last(['sgn(x) :=\n  if x > 0\n    1\n  else if x < 0\n    -1\n  else\n    0', 'sgn(-5) + 10*sgn(3) ='])).toBe('9');
    expect(last(['g(n) :=\n  k ← 0\n  while n > 1\n    n ← n/2\n    k ← k + 1\n  return k', 'g(1024) ='])).toBe('10');
  });
  it('builds vectors inside programs without touching outer variables', () => {
    expect(last(['A := [9; 9]', 'ones(n) :=\n  for i ∈ 0..n - 1\n    A[i] ← 1\n  A', 'ones(3) ='])).toBe('[1; 1; 1]');
    expect(last(['A := [9; 9]', 'ones(n) :=\n  for i ∈ 0..n - 1\n    A[i] ← 1\n  A', 'B := ones(3)', 'A ='])).toBe('[9; 9]');
  });
  it('break and try', () => {
    expect(last(['f(x) :=\n  for i ∈ 0..100\n    if i^2 > x\n      return i\n  -1', 'f(50) ='])).toBe('8');
    expect(last(['h(x) :=\n  try\n    error("boom")\n  on error\n    x*2', 'h(4) ='])).toBe('8');
  });
});

describe('formatting', () => {
  it('formats numbers', () => {
    expect(formatReal(1234.5678).text).toBe('1234.568');
    expect(formatReal(0.000762).text).toBe('7.62·10^-4');
    expect(formatReal(0.0123456).text).toBe('0.0123');
    expect(formatReal(1.5e9).text).toBe('1.5·10^9');
    expect(formatReal(-0).text).toBe('0');
  });
  it('produces LaTeX that KaTeX can render', () => {
    const srcs = [
      'x := 5 m', 'σ_c.d := 0.6 f_cd', 'f(x) := x^2/(1 + x)', 'A := [1, 2; 3, 4]', 's := sum(i^2, i, 1, 10)',
      'q := int(x^2, x, 0, 1)', 'r := nthroot(x, 3) + √(y)', 'f(n) :=\n  s ← 0\n  for i ∈ 1..n\n    s ← s + i\n  s',
      'v := vec(a*b)', 'T := 20 °C', 'k := A^T + A<<1>>', 'b := a ≤ 3 ∧ c ≠ 2', 'p := 10%', 'z := "text"', 'φ := 30 deg',
    ];
    for (const s of srcs) {
      const st = parseMathRegion(s);
      const l = stmtLatex(st, { isUnit: n => ['m', '°C', 'deg'].includes(n) });
      expect(() => katex.renderToString(l, { throwOnError: true, trust: true, strict: false }), s + ' → ' + l).not.toThrow();
    }
  });
  it('renders computed results as valid LaTeX', () => {
    const r = run(['A := [1, 2; 3, 4] * kN', 'A =', 'x := 1.5e-7 m', 'x =', 'z := 3 - 4i', 'z =', 'λ := 50 W/(m*K)', 'λ =']);
    for (const x of r) if (x.resultLatex) expect(() => katex.renderToString(x.resultLatex!, { throwOnError: true, strict: false })).not.toThrow();
  });
});

describe('plots', () => {
  it('computes range-based and quick plots', () => {
    const ws = emptyWorksheet();
    ws.regions = [
      { id: 'a', type: 'math', x: 0, y: 0, src: 'i := 0..10' },
      { id: 'b', type: 'math', x: 0, y: 20, src: 'f(x) := x^2' },
      { id: 'p', type: 'plot', x: 0, y: 40, traces: [{ x: 'i', y: 'f(i)' }] },
      { id: 'q', type: 'plot', x: 0, y: 300, traces: [{ x: 't', y: 'sin(t)' }], xmin: '0', xmax: '2*π' },
    ];
    const r = computeWorksheet(ws);
    const p = r.results.p.plot!;
    expect(p.error).toBeUndefined();
    expect(p.traces[0].y).toEqual([0, 1, 4, 9, 16, 25, 36, 49, 64, 81, 100]);
    const q = r.results.q.plot!;
    // axis limits: plain numbers are in display units, quantities are converted
    const ws2 = emptyWorksheet();
    ws2.regions = [
      { id: 'L', type: 'math', x: 0, y: 0, src: 'L := 6 m' },
      { id: 'p1', type: 'plot', x: 0, y: 20, traces: [{ x: 'x', y: 'x' }], xmin: '-750', xmax: '750', xUnit: 'mm', yUnit: 'mm' },
      { id: 'p2', type: 'plot', x: 0, y: 400, traces: [{ x: 'x', y: 'x' }], xmin: '0', xmax: 'L', xUnit: 'mm' },
    ];
    const r2 = computeWorksheet(ws2);
    expect(r2.results.p1.plot!.xLim).toEqual([-750, 750]);
    expect(r2.results.p1.plot!.traces[0].y[0]).toBeCloseTo(-750);
    expect(r2.results.p2.plot!.xLim[1]).toBeCloseTo(6000);
    expect(q.traces[0].x.length).toBe(401);
    expect(Math.abs(q.traces[0].y[100] - 1)).toBeLessThan(1e-9);
  });
});

void isMatrix; void si; void lastVal; void (null as unknown as Matrix);

describe('example worksheet', () => {
  it('computes without errors and with the expected key results', async () => {
    const { exampleWorksheet } = await import('../src/ui/examples');
    const ws = exampleWorksheet();
    const r = computeWorksheet(ws);
    expect(r.errorCount).toBe(0);
    const texts = Object.values(r.results).map(x => x.resultText).filter(Boolean).join(' | ');
    expect(texts).toContain('97.703');   // M_Ed in kN·m
    expect(texts).toContain('18.319');   // σ in MPa
    expect(texts).toContain('1.92');     // w_max in mm
    expect(texts).toContain('"erfüllt ✓"');
  });
});

describe('matrix ownership', () => {
  it('assigning elements never modifies another variable', () => {
    expect(last(['B := [1; 2]', 'f(n) :=\n  A ← B\n  A[1] ← 9\n  A[3] ← 7\n  A', 'f(0) =', 'B ='])).toBe('[1; 2]');
    expect(last(['B := [1; 2]', 'g(n) :=\n  A ← B\n  A[1] ← 9\n  A', 'g(0) ='])).toBe('[1; 9]');
    expect(last(['i := 0..4', 'v[i] := i', 'w := v', 'w[2] := 99', 'v ='])).toBe('[0; 1; 2; 3; 4]');
  });
});

describe('Befunde der Testagenten: Matrizen', () => {
  it('rekursive Folgen über Bereiche (Element für Element)', () => {
    expect(last(['x[0] := 1', 'i := 1..5', 'x[i] := x[i - 1]*2', 'x ='])).toBe('[1; 2; 4; 8; 16; 32]');
    expect(last(['F[0] := 0', 'F[1] := 1', 'k := 2..7', 'F[k] := F[k - 1] + F[k - 2]', 'F[7] ='])).toBe('13');
    expect(last(['v := [0; 1; 2]', 'i := 0..2', 'v[i] := v[2 - i]', 'v ='])).toBe('[2; 1; 2]');
  });
  it('in Matrizen gespeicherte Vektoren ändern sich nicht nachträglich', () => {
    expect(last(['f(n) :=\n  v[0] ← 1\n  v[1] ← 2\n  for i ∈ 0..2\n    R[i] ← v\n    v[0] ← v[0] + 10\n  R', 'f(0)[0] ='])).toBe('[1; 2]');
    expect(last(['g(n) :=\n  v[0] ← 1\n  v[1] ← 2\n  w ← [v, v]\n  v[1] ← 99\n  w', 'g(0)[0, 0] ='])).toBe('[1; 2]');
  });
  it('diag, lsolve mit Einheiten, polyroots/eigenvals mit komplexen Wurzeln', () => {
    expect(last(['diag([1; 2; 3]) ='])).toBe('[1, 0, 0; 0, 2, 0; 0, 0, 3]');
    expect(last(['K := [2, -1, 0; -1, 2, -1; 0, -1, 1]*kN/m', 'F := [0; 0; 1]*kN', 'lsolve(K, F) = mm'])).toBe('[1000; 2000; 3000]');
    expect(last(['polyroots([-1; 0; 0; 1]) ='])).toBe('[-0.5 - 0.866i; -0.5 + 0.866i; 1]');
    expect(last(['eigenvals([0, 0, 1; 1, 0, 0; 0, 1, 0]) ='])).toContain('-0.5 + 0.866i');
  });
  it('Fehler statt stiller elementweiser Rechnung bei nicht-quadratischen Matrizen', () => {
    expect(last(['A := [1, 2, 3; 4, 5, 6]', 'A^2 ='])).toMatch(/ERROR: .*quadratisch/);
    expect(last(['M[-1] := [1; 2]', 'M ='])).toMatch(/ERROR/);
    expect(run(['M[-1] := [1; 2]'])[0].error?.message).toMatch(/Index kleiner als ORIGIN/);
  });
  it('Zeilenvektor: Betrag und Skalarprodukt', () => {
    expect(last(['v := [3; 4]', '|v^T| ='])).toBe('5');
    expect(last(['v := [1; 2]', 'v^T*v + 1 ='])).toBe('6');
  });
});

describe('Befunde der Testagenten: Parser & Format', () => {
  it('kleine Größen mit Einheit werden nicht zu 0', () => {
    expect(last(["'h ="])).toBe('6.626·10^-34 J·s');
    expect(last(['a := 0', 'a = m'])).toBe('0');
  });
  it('x^T ist Potenz, wenn T eine Variable und x keine Matrix ist', () => {
    expect(last(['T := 3', 'x := 2', 'x^T ='])).toBe('8');
    expect(last(['T := 3', 'A := [1, 2; 3, 4]', 'A^T ='])).toBe('[1, 3; 2, 4]');
  });
  it('Vergleiche: Zeichenketten und Toleranz', () => {
    expect(last(['"a" == "b" ='])).toBe('0');
    expect(last(['"a" == "a" ='])).toBe('1');
    expect(last(['0.1 + 0.2 > 0.3 ='])).toBe('0');
    expect(last(['y := 2', 'y<-1 ='])).toBe('0');
  });
  it('Division durch null ist ein Fehler', () => {
    expect(last(['1/0 ='])).toMatch(/Division durch null/);
    expect(last(['0^-1 ='])).toMatch(/Division durch null/);
    expect(last(['1 m/0 ='])).toMatch(/Division durch null/);
  });
  it('Eingabefehler werden erkannt', () => {
    expect(last(['1 000 ='])).toMatch(/Zwei Zahlen/);
    expect(last(['not := 1'])).toMatch(/reserviert/);
    expect(last(['5!='])).toBe('120');
  });
  it('Rundung arbeitet dezimal', () => {
    expect(last(['1.0005 ='])).toBe('1.001');
    expect(last(['-1.0005 ='])).toBe('-1.001');
    expect(last(['9999999.9996 ='])).toBe('1·10^7');
  });
  it('Fehlerposition im Einheitenteil und nach Leerzeile', () => {
    expect(() => parseMathRegion('x = m^')).toThrow();
    try { parseMathRegion('\n1 +* 2'); } catch (e) { expect((e as { pos: number }).pos).toBeGreaterThanOrEqual(1); }
  });
  it('Programmschlüsselwort direkt mit Klammer', () => {
    expect(last(['f(y) :=\n  if(y>0)\n    1\n  else\n    2', 'f(3) ='])).toBe('1');
  });
});

describe('Befunde der Testagenten: Einheiten', () => {
  it('°C mit anderen Einheiten unabhängig von der Reihenfolge', () => {
    expect(last(['20 °C * 1 W/K ='])).toBe('293.15 W');
    expect(last(['1 W/K * 20 °C ='])).toBe('293.15 W');
  });
  it('ungerade Wurzeln negativer Größen bleiben reell', () => {
    expect(last(['(-8 m^3)^(1/3) ='])).toBe('-2 m');
  });
  it('Bereichsgrenzen mit unterschiedlichen Einheiten', () => {
    expect(run(['i := 1 m..5 s'])[0].error?.message).toMatch(/Einheiten/);
  });
  it('stdev mit 0 zwischen Größen, Anzeige in % und S', () => {
    expect(last(['stdev([0; 1 m; 2 m]) ='])).toBe('0.816 m');
    expect(last(['x := 0.5', 'x = %'])).toBe('50');
    expect(last(['1/(5 Ω) ='])).toBe('0.2 S');
  });
  it('zusätzliche Einheiten', () => {
    expect(last(['1 cal = J'])).toBe('4.187');
    expect(last(['1 nmi = m'])).toBe('1852');
    expect(last(['1 Bq*1 s ='])).toBe('1');
    expect(last(['1 Gy = J/kg'])).toBe('1');
    expect(last(['1 inHg = Pa'])).toBe('3386.389');
    expect(last(['5 Δ°C = K'])).toBe('5');
  });
});

describe('Befunde der Testagenten: Solver & Programme', () => {
  it('Find meldet unlösbare Systeme', () => {
    expect(last(['x := 1000', 'Given', 'x^2 + 50 == 0', 'Find(x) ='])).toMatch(/keine Lösung/);
    expect(last(['x := 100', 'y := 100', 'Given', 'x^2+y^2 == -1', 'x == y', 'Find(x, y) ='])).toMatch(/keine Lösung/);
  });
  it('Find mit erfüllbarer Ungleichung und schwierigem Startwert', () => {
    expect(last(['x := -1', 'Given', 'x^3 - x == 6', 'x > 0', 'Find(x) ='])).toBe('2');
    expect(last(['x := 1', 'Given', 'x^2 == 4', 'x < 0', 'Find(x) ='])).toBe('-2');
    expect(last(['x := 1', 'Given', 'exp(x) == 1e10', 'Find(x) ='])).toBe('23.026');
  });
  it('Minerr ist ungewichtet und unabhängig vom Schätzwert', () => {
    expect(last(['a := 1', 'b := 1', 'Given', 'a+b == 3', 'a-b == 1', 'a == 2.5', 'Minerr(a, b) ='])).toBe('[2.167; 1]');
    expect(last(['a := 10', 'b := 10', 'Given', 'a+b == 3', 'a-b == 1', 'a == 2.5', 'Minerr(a, b) ='])).toBe('[2.167; 1]');
  });
  it('Find ohne neues Given', () => {
    expect(last(['x := 1', 'Given', 'x^2 == 9', 'a := Find(x)', 'x^2 == 16', 'Find(x) ='])).toMatch(/keine Bedingungen/);
  });
  it('root lehnt Polstellen und Sprünge ab und bleibt nahe am Schätzwert', () => {
    expect(last(['x := 3', 'root(1/(x-2), x) ='])).toMatch(/keine Nullstelle/);
    expect(last(['root(tan(x), x, 1, 2) ='])).toMatch(/keine Nullstelle/);
    expect(last(['root(floor(x) - 0.5, x, 0, 2) ='])).toMatch(/keine Nullstelle/);
    expect(last(['x := 0', 'root(cos(x), x) ='])).toBe('1.571');
  });
  it('try fängt alle Fehler, Rekursionsgrenze ist deterministisch', () => {
    expect(last(['s(n) := if(n <= 0, 0, n + s(n-1))', 't(n) :=\n  try\n    s(n)\n  on error\n    -1', 't(100000) ='])).toBe('-1');
    expect(last(['h(g,x) :=\n  try\n    g(x)\n  on error\n    -1', 'h(eigenvals, [1,2,3]) ='])).toBe('-1');
    expect(last(['f(n) := if(n < 1, 0, f(n - 1) + 1)', 'f(600) ='])).toMatch(/Rekursion zu tief/);
    expect(last(['f(n) := if(n < 1, 0, f(n - 1) + 1)', 'f(250) ='])).toBe('250');
  });
  it('sehr lange Formel bringt das Blatt nicht zum Absturz', () => {
    expect(last(['y := ' + Array(4000).fill('1').join('+') + ' =', 'z := 2 ='])).toBe('2');
  });
});

describe('Befunde der Testagenten: Reihenfolge', () => {
  it('Reihenfolge bei fast gleicher Höhe unabhängig von der Speicherreihenfolge', () => {
    const regs = [
      { id: 'a', type: 'math' as const, x: 0, y: 0.8, src: 'a := 1' },
      { id: 'b', type: 'math' as const, x: 100, y: 0.4, src: 'a := a*10+2' },
      { id: 'c', type: 'math' as const, x: 200, y: 0, src: 'a := a*10+3' },
    ];
    const orders = [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]].map(o => sortRegions(o.map(i => regs[i])).map(r => r.id).join(''));
    expect(new Set(orders).size).toBe(1);
  });
});
