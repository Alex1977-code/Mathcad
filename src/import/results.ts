/** Parsing of results stored by Mathcad in the file (used to verify our calculation). */
import { kids, local, child } from './mathml';
import { lookupUnit } from '../engine/units';
import type { Unit } from 'mathjs';

import type { ExpScalar, Expected } from '../engine/model';
export type { ExpScalar, Expected };

const ZERO = () => [0, 0, 0, 0, 0, 0, 0, 0, 0];

function unitDims(name: string): number[] | null {
  const u = lookupUnit(name, true);
  if (u === null) return null;
  if (typeof u === 'number') return ZERO();
  return (u as Unit).dimensions.slice();
}

function parseMonomial(e: Element | undefined): number[] | null {
  const d = ZERO();
  if (!e) return d;
  for (const r of kids(e)) {
    if (local(r) !== 'unitReference') continue;
    const name = r.getAttribute('unit') ?? '';
    const num = parseFloat(r.getAttribute('power-numerator') ?? '1');
    const den = parseFloat(r.getAttribute('power-denominator') ?? '1');
    const ud = unitDims(name);
    if (!ud) return null;
    for (let i = 0; i < d.length; i++) d[i] += ud[i] * (num / den);
  }
  return d;
}

function parseScalar(e: Element): ExpScalar | null {
  switch (local(e)) {
    case 'real': return { re: parseFloat(e.textContent ?? 'NaN'), dims: ZERO() };
    case 'imag': return { re: 0, im: parseFloat(e.textContent ?? 'NaN'), dims: ZERO() };
    case 'complex': {
      const r = child(e, 'real'), i = child(e, 'imag');
      return { re: r ? parseFloat(r.textContent ?? '0') : 0, im: i ? parseFloat(i.textContent ?? '0') : 0, dims: ZERO() };
    }
    case 'unitedValue': {
      const valEl = kids(e).find(c => ['real', 'imag', 'complex'].includes(local(c)));
      if (!valEl) return null;
      const s = parseScalar(valEl);
      const dims = parseMonomial(child(e, 'unitMonomial'));
      if (!s || !dims) return null;
      return { ...s, dims };
    }
    default: return null;
  }
}

/** Parse a <result> element (or its single child). */
export function parseExpected(e: Element | undefined | null): Expected | null {
  if (!e) return null;
  let v: Element | undefined = e;
  if (local(e) === 'result') v = kids(e)[0];
  if (!v) return null;
  // a matrix with one unit for all elements: <unitedValue><matrix/><unitMonomial/></unitedValue>
  if (local(v) === 'unitedValue' && child(v, 'matrix')) {
    const m = parseExpected(child(v, 'matrix')!);
    const dims = parseMonomial(child(v, 'unitMonomial'));
    if (!m || m.kind !== 'matrix') return m;
    return { ...m, v: m.v.map(x => (x && dims && x.dims.every(d => d === 0) ? { ...x, dims } : dims ? x : null)) };
  }
  if (local(v) === 'str') return { kind: 'string', v: v.textContent ?? '' };
  if (local(v) === 'matrix') {
    const rows = parseInt(v.getAttribute('rows') ?? '0', 10);
    const cols = parseInt(v.getAttribute('cols') ?? '0', 10);
    const els = kids(v);
    if (els.some(x => local(x) === 'matrix')) return null; // nested arrays not compared
    const vals: (ExpScalar | null)[] = new Array(rows * cols).fill(null);
    // column-major → row-major
    for (let j = 0; j < cols; j++) for (let i = 0; i < rows; i++) {
      const el = els[j * rows + i];
      vals[i * cols + j] = el ? parseScalar(el) : null;
    }
    return { kind: 'matrix', rows, cols, v: vals };
  }
  const s = parseScalar(v);
  return s ? { kind: 'scalar', v: s } : null;
}

export function expectedText(x: Expected): string {
  const sc = (s: ExpScalar | null) => (s ? (s.im ? `${s.re}+${s.im}i` : String(s.re)) : '?');
  if (x.kind === 'string') return JSON.stringify(x.v);
  if (x.kind === 'scalar') return sc(x.v);
  return `[${x.rows}×${x.cols}] ${x.v.slice(0, 6).map(sc).join(', ')}${x.v.length > 6 ? ', …' : ''}`;
}
