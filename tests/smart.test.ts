import { describe, it, expect } from 'vitest';
import { computeWorksheet, type RegionResult } from '../src/engine/worksheet';
import { emptyWorksheet } from '../src/engine/model';
import {
  compatibleUnits, currentUnit, equationSides, plottableFunction, solveBlockLines, toggleShowValue, unknownNames, withDisplayUnit,
} from '../src/ui/smart';

function run(lines: string[]): RegionResult[] {
  const ws = emptyWorksheet();
  ws.regions = lines.map((src, i) => ({ id: `r${i}`, type: 'math' as const, x: 0, y: i * 20, src }));
  const res = computeWorksheet(ws);
  return lines.map((_, i) => res.results[`r${i}`]);
}

describe('Bedienung: Formel-Umschreibungen', () => {
  it('setzt und entfernt die Anzeigeeinheit eines Ergebnisses', () => {
    expect(withDisplayUnit('F*a =', 'kN*m')).toBe('F*a = kN*m');
    expect(withDisplayUnit('F*a = N*m', 'kN*m')).toBe('F*a = kN*m');
    expect(withDisplayUnit('F*a = N*m', null)).toBe('F*a =');
    expect(withDisplayUnit('M := F*a = N*m', 'kN*m')).toBe('M := F*a = kN*m');
    expect(withDisplayUnit('f(x) := if(x = 1, 2, 3)', 'm')).toBeNull();   // "=" inside a call is no result
    expect(withDisplayUnit('x := 5', 'm')).toBeNull();
    expect(withDisplayUnit('a =', 'kN*(')).toBeNull();                     // invalid unit is rejected
    expect(currentUnit('M := F*a = kN*m')).toBe('kN*m');
    expect(currentUnit('M := F*a =')).toBe('');
  });

  it('schaltet die Wertanzeige einer Definition um', () => {
    expect(toggleShowValue('x := 5 m')).toBe('x := 5 m =');
    expect(toggleShowValue('x := 5 m = mm')).toBe('x := 5 m');
    expect(toggleShowValue('f(x) := x^2')).toBeNull();
    expect(toggleShowValue('a + b =')).toBeNull();
  });

  it('erkennt Funktionen zum Plotten und Gleichungen zum Lösen', () => {
    expect(plottableFunction('f(x) := x^2 - 2')).toEqual({ name: 'f', param: 'x' });
    expect(plottableFunction('g(a, b) := a + b')).toBeNull();
    expect(plottableFunction('x := 3')).toBeNull();
    expect(equationSides('x^2 - 2 == 7')).toEqual({ lhs: 'x^2 - 2', rhs: '7' });
    expect(equationSides('3*x + 1 = 10')).toEqual({ lhs: '3*x + 1', rhs: '10' });
    expect(equationSides('x := 3')).toBeNull();
    expect(equationSides('a = b = c')).toBeNull();
    expect(unknownNames('a*x^2 + sin(x) == 2 m', new Set(['a']))).toEqual(['x']);
  });

  it('die Schritte des Lösen-Befehls ergeben die Lösung, der Startwert bekommt die passende Einheit', () => {
    const r = run(['a := 3', 'x := 1', 'Given', 'a*x + 1 == 10', 'x := Find(x) =']);
    expect(r[4].resultText).toBe('3');
    const ws = emptyWorksheet();
    ws.regions = ['F := 12 kN', 'A := 3 cm^2', 'F/A == σ*2', 'z := 1'].map((src, i) => ({ id: `r${i}`, type: 'math' as const, x: 0, y: i * 30, src }));
    const lines = solveBlockLines(ws, 'r2', 'σ', { lhs: 'F/A', rhs: 'σ*2' });
    expect(lines[0]).toBe('σ := 1 Pa');
    const out = run(['F := 12 kN', 'A := 3 cm^2', ...lines.slice(0, 3), 'σ := Find(σ) = MPa']);
    expect(out[5].resultText).toBe('20');   // shown in MPa
  });

  it('bietet nur passende Einheiten an, und der Rechenkern akzeptiert jede davon', () => {
    for (const [def, must] of [['12 kN*2.5 m', 'kN*m'], ['3 MPa', 'N/mm^2'], ['5 m/s', 'km/hr'], ['2 kg', 'tonne']] as const) {
      const [r] = run([`v := ${def} =`]);
      const units = compatibleUnits(r.dims);
      expect(units, def).toContain(must);
      for (const u of units) {
        const [x] = run([`v := ${def} = ${u}`]);
        expect(x.error?.message, `${def} in ${u}`).toBeUndefined();
      }
    }
    expect(compatibleUnits(run(['v := 12 kN =', ''])[0].dims)).not.toContain('m');
  });

  it('liefert den Wert reiner Definitionen für die optionale Anzeige', () => {
    const r = run(['L := 2.5 m', 'f(x) := x', 'A := L^2']);
    expect(r[0].valueText).toBe('2.5 m');
    expect(r[0].literal).toBe(true);
    expect(r[2].valueText).toBe('6.25 m²');
    expect(r[2].literal).toBeUndefined();
    expect(r[0].dims).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(r[1].valueText).toBeUndefined();
  });
});
