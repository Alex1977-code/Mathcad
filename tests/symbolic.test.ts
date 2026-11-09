import { describe, it, expect } from 'vitest';
import { computeWorksheet, type RegionResult } from '../src/engine/worksheet';
import { emptyWorksheet } from '../src/engine/model';
import { parseMathRegion } from '../src/engine/parser';
import { stmtToText } from '../src/engine/serialize';
import katex from 'katex';

function run(lines: string[]): RegionResult[] {
  const ws = emptyWorksheet();
  ws.regions = lines.map((src, i) => ({ id: `r${i}`, type: 'math' as const, x: 0, y: i * 20, src }));
  const res = computeWorksheet(ws);
  return lines.map((_, i) => res.results[`r${i}`]);
}
/** Symbolic result of the last line (as text) or the error. */
function sym(lines: string[]): string {
  const r = run(lines).pop()!;
  if (r.error) return 'ERROR: ' + r.error.message;
  return r.resultText ?? '';
}

describe('Symbolische Auswertung →', () => {
  it('vereinfacht und lässt unbekannte Namen symbolisch', () => {
    expect(sym(['x^2 + 2*x*x →'])).toBe('3*x^2');
    expect(sym(['a := 2', 'a*x + a*x →'])).toBe('4*x');
    expect(sym(['1/3 + 1/6 →'])).toBe('1/2');
    expect(sym(['sin(x)^2 + cos(x)^2 →'])).toMatch(/^(1|.*sin.*)$/);
  });

  it('setzt Funktionen ein und leitet symbolisch ab', () => {
    expect(sym(['f(t) := t^2 + 1', 'f(y + 1) →'])).toBe('(y + 1)^2 + 1');
    expect(sym(['deriv(x^3, x) →'])).toBe('3*x^2');
    expect(sym(['x := 5', 'deriv(x^3 + sin(x), x) →'])).toBe('3*x^2 + cos(x)');
  });

  it('Schlüsselwörter expand, float und solve', () => {
    expect(sym(['(x + 1)^2 → expand'])).toBe('x^2 + 2*x + 1');
    expect(sym(['π → float, 5'])).toBe('3.1416');
    expect(sym(['2*x + 3 == 11 → solve, x'])).toBe('4');
    expect(sym(['a*x + b == 0 → solve, x'])).toBe('-(b/a)');
    expect(run(['a*x + b == 0 → solve, x'])[0].symbolicLatex?.replace(/\s+/g, '')).toMatch(/^-\\frac\{.*b.*\}\{.*a.*\}$/);
    const q = sym(['x^2 - 5*x + 6 == 0 → solve, x']);
    expect(q).toContain('2');
    expect(q).toContain('3');
    expect(sym(['x^3 == 2 → solve, x'])).toMatch(/^ERROR: solve: symbolisch nur/);
  });

  it('Einheiten werden als SI-Größen eingesetzt', () => {
    expect(sym(['F := 12 kN', 'F*2 →'])).toBe('24000*N');
  });

  it('meldet Nicht-Unterstütztes verständlich und bleibt darstellbar', () => {
    expect(sym(['sum(v) →'])).toBe('ERROR: Symbolisch nicht unterstützt: Summen/Produkte über Vektoren');
    expect(sym(['x → fancy'])).toMatch(/Unbekanntes Schlüsselwort/);
    for (const l of ['x^2 →', 'x → expand', 'x == 2 → solve, x', 'π → float, 4']) {
      const st = parseMathRegion(l);
      expect(stmtToText(st)).toBe(l);
      expect(() => katex.renderToString(run([l])[0].symbolicLatex ?? '1', { throwOnError: true })).not.toThrow();
    }
  });

  it('Integrale: unbestimmt und bestimmt, Ergebnis abgeleitet = Integrand', () => {
    expect(sym(['int(3*x^2, x) →'])).toBe('x^3');
    expect(sym(['int(x^2, x, 0, 3) →'])).toBe('9');
    expect(sym(['int(1/x, x) →'])).toBe('ln(x)');
    expect(sym(['int(cos(2*x), x) →'])).toBe('sin(2*x)/2');
    expect(sym(['q := 4', 'int(q*x, x, 0, w) →'])).toBe('2*w^2');
    // each antiderivative is checked numerically: F'(x) ≈ f(x) at x = 0.7
    const cases = ['x*exp(x)', 'x^2*sin(x)', 'exp(3*x + 1)', '(2*x + 1)^3', '1/(2*x + 5)', 'sqrt(x)', 'x*cos(x)', '2^x', 'ln(x)', 'tan(x)', 'a*x^2 + b*x'];
    for (const f of cases) {
      const r = run(['a := 1.5', 'b := -2', `F(x) := ${f}`, `int(F(x), x) →`]);
      const res = r[3];
      expect(res.error?.message, f).toBeUndefined();
      const chk = run(['a := 1.5', 'b := -2', `G(x) := ${res.resultText}`, `F(x) := ${f}`, 'abs((G(0.7 + 1e-6) - G(0.7 - 1e-6))/2e-6 - F(0.7)) < 1e-4 =']);
      expect(chk[4].resultText, `${f} → ${res.resultText}`).toBe('1');
    }
    expect(sym(['int(exp(x^2), x) →'])).toMatch(/^ERROR: Symbolisch nicht unterstützt: Integral/);
    expect(sym(['int(x, x) =']).startsWith('ERROR: Unbestimmtes Integral')).toBe(true);
  });

  it('substitute, factor, coeffs, series', () => {
    expect(sym(['x^2 + 1 → substitute, x = a + 1'])).toBe('(a + 1)^2 + 1');
    expect(sym(['x*y → substitute, x = 2, y = 3'])).toBe('6');
    expect(sym(['x^2 - 5*x + 6 → factor'])).toBe('(x - 2)*(x - 3)');
    expect(sym(['2*x^3 - 2*x → factor'])).toBe('2*x*(x + 1)*(x - 1)');
    expect(sym(['2*x^2 + 3*x + 1 → factor'])).toBe('(x + 1)*(2*x + 1)');
    expect(sym(['x^2 - 2*x + 1 → factor'])).toBe('(x - 1)^2');
    expect(sym(['x^2 + 1 → factor'])).toMatch(/^ERROR: factor: keine rationalen/);
    expect(sym(['3*x^2 + a*x - 7 → coeffs, x'])).toBe('[-7; a; 3]');
    expect(sym(['exp(x) → series, x, 4'])).toMatch(/^(1 \+ x \+ x\^2\/2 \+ x\^3\/6|.*x\^3\/6.*)$/);
    const ser = run(['exp(x) → series, x, 4'])[0].resultText!;
    const v = run([`S(x) := ${ser}`, 'S(0.1) ='])[1].resultText;
    expect(Number(v)).toBeCloseTo(1 + 0.1 + 0.005 + 0.1 ** 3 / 6, 3);
    expect(sym(['sin(x) → series, x = π, 2'])).toBe('π - x');
  });

  it('lineare Gleichungssysteme und Vektoren', () => {
    expect(sym(['[x + y == 10; x - y == 2] → solve, x, y'])).toBe('[6, 4]');
    expect(sym(['[a*x + y == 1; x - y == 0] → solve, [x; y]'])).toBe('[1/(a + 1), 1/(a + 1)]');
    expect(sym(['[x*y == 1; x == 2] → solve, x, y'])).toMatch(/nur linear/);
    expect(sym(['[deriv(x^2, x); x + x] →'])).toBe('[2*x; 2*x]');
  });

  it('Summen und Produkte in geschlossener Form', () => {
    expect(sym(['sum(i, i, 1, n) →'])).toBe('n*(n + 1)/2');
    expect(sym(['sum(i^2, i, 1, n) →'])).toBe('n*(n + 1)*(2*n + 1)/6');
    expect(sym(['sum(i^3, i, 1, n) →'])).toBe('n^2*(n + 1)^2/4');
    expect(sym(['sum(2^i, i, 0, n) →'])).toBe('2^(n + 1) - 1');
    expect(sym(['sum((1/2)^i, i, 0, ∞) →'])).toBe('2');
    expect(sym(['sum(i, i, 1, 10) →'])).toBe('55');
    expect(sym(['prod(i, i, 1, 5) →'])).toBe('120');
    expect(sym(['sum(i, i, 1, ∞) →'])).toMatch(/divergiert/);
    expect(sym(['sum(1/i, i, 1, n) →'])).toMatch(/nur Polynome und geometrische/);
    // closed form agrees with the numeric sum
    const r = run(['S(n) := ' + run(['sum(i^2 + 3*i, i, 2, n) →'])[0].resultText, 'S(17) - sum(i^2 + 3*i, i, 2, 17) ='])[1];
    expect(r.resultText).toBe('0');
  });

  it('Grenzwerte lim(f, x, a) symbolisch und numerisch', () => {
    expect(sym(['lim(sin(x)/x, x, 0) →'])).toBe('1');
    expect(sym(['lim((x^2 - 1)/(x - 1), x, 1) →'])).toBe('2');
    expect(sym(['lim((1 + 1/x)^x, x, ∞) →'])).toBe('e');
    expect(sym(['lim((3*x^2 + 1)/(x^2 + 5), x, ∞) →'])).toBe('3');
    expect(sym(['lim(a*x/x, x, 0) →'])).toBe('a');
    expect(sym(['lim(x*ln(x), x, 0, "right") →'])).toBe('0');
    expect(sym(['lim(1/x, x, 0, "right") →'])).toBe('∞');
    expect(sym(['lim(1/x, x, 0) →'])).toMatch(/von links −∞, von rechts ∞/);
    expect(run(['lim(sin(x)/x, x, 0) ='])[0].resultText).toBe('1');
    expect(run(['lim((1 + 1/x)^x, x, ∞) ='])[0].resultText).toBe('2.718');
    expect(() => katex.renderToString(run(['lim(1/x, x, 0, "right") →'])[0].latex ?? '', { throwOnError: true })).not.toThrow();
  });

  it('Partialbruchzerlegung → parfrac', () => {
    expect(sym(['1/(x^2 - 1) → parfrac, x'])).toBe('-(1/(2*(x + 1))) + 1/(2*(x - 1))');
    expect(sym(['(x^3 + 1)/(x^2 - 3*x + 2) → parfrac'])).toBe('x + 3 - 2/(x - 1) + 9/(x - 2)');
    expect(sym(['1/(x*(x+1)^2) → parfrac'])).toBe('-(1/(x + 1)) - 1/(x + 1)^2 + 1/x');
    expect(sym(['1/(x^3 + x) → parfrac'])).toBe('1/x - x/(x^2 + 1)');
    // the decomposition equals the original function
    for (const f of ['(2*x + 5)/(x^2 + x - 6)', '(x^4 + 1)/((x - 1)^2*(x + 2))', '3/(x^2*(x^2 + 4))']) {
      const pf = run([`${f} → parfrac`])[0].resultText!;
      const chk = run([`F(x) := ${f}`, `G(x) := ${pf}`, 'abs(F(0.37) - G(0.37)) + abs(F(5.3) - G(5.3)) < 1e-9 =']);
      expect(chk[2].resultText, `${f} → ${pf}`).toBe('1');
    }
  });

  it('Partialbruchzerlegung mit Buchstaben', () => {
    expect(sym(['1/((x - a)*(x - b)) → parfrac, x'])).toBe('1/((a - b)*(x - a)) + 1/((b - a)*(x - b))');
    expect(sym(['1/(x^2 - a^2) → parfrac, x'])).toBe('1/(2*a*(x - a)) - 1/(2*a*(x + a))');
    expect(sym(['1/(x^2 - a^2) → parfrac'])).toBe('1/(2*a*(x - a)) - 1/(2*a*(x + a))');   // x is taken as the variable
    expect(sym(['1/(x^2 + a) → parfrac, x'])).toMatch(/Nenner bitte faktorisiert/);
    // each decomposition equals the original function for numbers in place of the letters
    for (const f of ['1/((x - a)*(x - b))', '(x + c)/(x^2*(x - a))', '1/((x - a)^2*(x + a))', '1/((x - a)*(x^2 + b^2))',
      'x^3/((x - a)*(x - b))', '1/(x^2 - (a + b)*x + a*b)', '(2*x + c)/((x - (a + 1))*(x + b)^2)']) {
      const pf = run([`${f} → parfrac, x`])[0];
      expect(pf.error?.message, f).toBeUndefined();
      const chk = run(['a := 1.7', 'b := 0.6', 'c := 2.3', `F(x) := ${f}`, `G(x) := ${pf.resultText}`, 'abs(F(0.37) - G(0.37)) + abs(F(5.3) - G(5.3)) + abs(F(-2.9) - G(-2.9)) < 1e-9 =']);
      expect(chk[5].resultText, `${f} → ${pf.resultText}`).toBe('1');
    }
  });
});