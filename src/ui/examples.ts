import { emptyWorksheet, newId, type Region, type Worksheet } from '../engine/model';

const m = (x: number, y: number, src: string): Region => ({ id: newId(), type: 'math', x, y, src });
const t = (x: number, y: number, html: string, w = 640): Region => ({ id: newId(), type: 'text', x, y, w, html });

/** Example: single-span beam design (shows units, functions, matrices, programs, plots, solve blocks). */
export function exampleWorksheet(): Worksheet {
  const ws = emptyWorksheet('Beispiel – Einfeldträger');
  const L = 48;
  ws.regions = [
    t(L, 36, '<h2>Einfeldträger unter Gleichlast</h2><p>Beispiel für FormelWerk: Werte ändern – alles rechnet sofort neu. Einheiten werden automatisch umgerechnet und geprüft.</p>'),
    t(L, 114, '<h3>1 · Eingabewerte</h3>', 300),
    m(L, 150, 'L := 6.5 m'),
    m(222, 150, 'q_d := 18.5 kN/m'),
    m(420, 150, 'f_yd := 235 MPa'),
    m(L, 192, 'b := 200 mm'),
    m(222, 192, 'h := 400 mm'),
    m(420, 192, 'E := 210 GPa'),
    t(L, 246, '<h3>2 · Schnittgrößen</h3>', 300),
    m(L, 282, 'M_Ed := q_d*L^2/8 = kN*m'),
    m(330, 282, 'V_Ed := q_d*L/2 = kN'),
    m(L, 330, 'M(x) := q_d*x/2*(L - x)'),
    m(330, 330, 'x_0 := L/3'),
    m(L, 372, 'M(x_0) = kN*m'),
    t(L, 426, '<h3>3 · Querschnitt &amp; Nachweis</h3>', 340),
    m(L, 462, 'W := b*h^2/6 = cm^3'),
    m(330, 462, 'I := b*h^3/12 = cm^4'),
    m(L, 510, 'σ := M_Ed/W = MPa'),
    m(330, 510, 'η := σ/f_yd ='),
    m(L, 558, 'Nachweis :=\n  if η ≤ 1\n    "erfüllt ✓"\n  else\n    "nicht erfüllt"'),
    m(330, 558, 'Nachweis ='),
    m(L, 666, 'w_max := 5/384*q_d*L^4/(E*I) = mm'),
    m(330, 666, 'w_zul := L/300 = mm'),
    t(L, 714, '<h3>4 · Momentenverlauf</h3>', 300),
    { id: newId(), type: 'plot', x: L, y: 750, w: 640, h: 270, traces: [{ x: 'x', y: 'M(x)', color: '#3b5bdb' }], xmin: '0', xmax: 'L', xUnit: 'm', yUnit: 'kN*m', title: 'Biegemoment M(x)' },
    t(L, 1160, '<h3>5 · Weitere Möglichkeiten</h3>', 360),
    m(L, 1200, 'A := [4, -2; 1, 1]'),
    m(222, 1200, 'A^-1 ='),
    m(420, 1200, 'eigenvals(A) ='),
    m(L, 1272, 'i := 0..4'),
    m(222, 1272, 'v[i] := i^2'),
    m(420, 1272, 'sum(v) ='),
    m(L, 1320, 'int(sin(x)^2, x, 0, π) ='),
    m(330, 1320, 'z := 1'),
    m(420, 1320, 'root(z^3 - 2*z - 5, z) ='),
  ];
  return ws;
}
