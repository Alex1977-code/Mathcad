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
    expect(sym(['[1, 2] →'])).toBe('ERROR: Symbolisch nicht unterstützt: Matrizen');
    expect(sym(['x → fancy'])).toMatch(/Unbekanntes Schlüsselwort/);
    for (const l of ['x^2 →', 'x → expand', 'x == 2 → solve, x', 'π → float, 4']) {
      const st = parseMathRegion(l);
      expect(stmtToText(st)).toBe(l);
      expect(() => katex.renderToString(run([l])[0].symbolicLatex ?? '1', { throwOnError: true })).not.toThrow();
    }
  });
});
