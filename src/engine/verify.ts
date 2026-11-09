/** Comparison of our results with results stored by Mathcad. */
import type { Complex, Matrix, Unit } from 'mathjs';
import type { ExpScalar, Expected } from './model';
import { isComplex, isMatrix, isRange, isUnit, makeMatrix, matrixRows, rangeValues, type Val } from './values';
import { formatReal, siUnitFactors, unitFactorsText } from './format';

export type CheckStatus = 'match' | 'mismatch' | 'skipped';

function scalarOf(v: Val): { re: number; im: number; dims: number[] } | null {
  if (typeof v === 'number') return { re: v, im: 0, dims: [0, 0, 0, 0, 0, 0, 0, 0, 0] };
  if (isComplex(v)) return { re: (v as Complex).re, im: (v as Complex).im, dims: [0, 0, 0, 0, 0, 0, 0, 0, 0] };
  if (isUnit(v)) {
    const u = v as Unit;
    const val = u.value as unknown;
    const c = typeof val === 'number' ? { re: val, im: 0 } : isComplex(val) ? { re: (val as Complex).re, im: (val as Complex).im } : null;
    if (!c) return null;
    return { ...c, dims: u.dimensions.slice() };
  }
  return null;
}

/** Relative tolerance for comparisons (Mathcad stores ~15 significant digits). */
let REL = 1e-4;

function close(a: number, b: number, scale: number): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
  if (!isFinite(a) || !isFinite(b)) return a === b || (Math.abs(a) > 1e300 && Math.abs(b) > 1e300 && Math.sign(a) === Math.sign(b));
  return Math.abs(a - b) <= REL * Math.max(Math.abs(a), Math.abs(b)) + REL * 1e-2 * scale + (b === 0 ? 1e-15 : 0);
}

function sameDims(a: number[], b: number[]): boolean {
  // Mathcad treats angles as dimensionless, mathjs index 7 is ANGLE
  for (let i = 0; i < 9; i++) if (i !== 7 && Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > 1e-9) return false;
  return true;
}

/** Dimensions of the display unit, when the result is shown in one (the value compared is value/unit). */
let UNIT_DIMS: number[] | null = null;

function scalarMatch(v: Val, e: ExpScalar, scale: number): boolean {
  const s = scalarOf(v);
  if (!s) return false;
  // a dimensionless zero in Mathcad may come back without units
  if (!UNIT_DIMS && !sameDims(s.dims, e.dims) && !(s.re === 0 && e.re === 0)) return false;
  // with a display unit the number compared is value/unit (the displayed number). Its dimension check is
  // unit-aware for both conventions: Prime stores the unit left over (kN·m shown in kN → m), Mathcad 15 the
  // dimension of the whole quantity (left over + display unit). Anything else is a mismatch.
  if (UNIT_DIMS && s.re !== 0) {
    const full = s.dims.map((d, i) => d + (UNIT_DIMS![i] ?? 0));
    if (!sameDims(s.dims, e.dims) && !sameDims(full, e.dims)) return false;
  }
  const sc = Math.max(scale, Math.abs(e.re), Math.abs(e.im ?? 0));
  return close(s.re, e.re, sc) && close(s.im, e.im ?? 0, sc);
}

/**
 * @param iterative results of iterative numerical methods (Find, root, integrals) are compared with
 *   Mathcad's own convergence tolerance TOL = 10⁻³ instead of 10⁻⁴.
 */
export function checkResult(v: Val, exp: Expected, unitDims?: number[], iterative = false): CheckStatus {
  if (isRange(v)) v = makeMatrix(rangeValues(v).map(x => [x]));
  UNIT_DIMS = unitDims ?? null;
  REL = iterative ? 1e-3 : 1e-4;
  try { return checkInner(v, exp); } finally { UNIT_DIMS = null; REL = 1e-4; }
}

function checkInner(v: Val, exp: Expected): CheckStatus {
  if (exp.kind === 'string') return typeof v === 'string' ? (v === exp.v ? 'match' : 'mismatch') : 'mismatch';
  if (exp.kind === 'scalar') {
    if (isMatrix(v)) {
      const rows = matrixRows(v as Matrix);
      if (rows.length === 1 && rows[0].length === 1) return scalarMatch(rows[0][0], exp.v, Math.abs(exp.v.re)) ? 'match' : 'mismatch';
      return 'mismatch';
    }
    return scalarMatch(v, exp.v, Math.abs(exp.v.re)) ? 'match' : 'mismatch';
  }
  if (!isMatrix(v)) {
    if (exp.rows * exp.cols === 1 && exp.v[0]) return scalarMatch(v, exp.v[0], Math.abs(exp.v[0].re)) ? 'match' : 'mismatch';
    return 'mismatch';
  }
  const rows = matrixRows(v as Matrix);
  if (rows.length !== exp.rows || rows[0].length !== exp.cols) return 'mismatch';
  // elements Mathcad stored in a form we cannot read: the result cannot be verified
  if (exp.v.length < exp.rows * exp.cols || exp.v.some(x => !x)) return 'skipped';
  const scale = Math.max(0, ...exp.v.map(x => (x ? Math.abs(x.re) : 0)));
  for (let i = 0; i < exp.rows; i++) for (let j = 0; j < exp.cols; j++) {
    const e = exp.v[i * exp.cols + j];
    if (!e) return 'skipped';
    if (!scalarMatch(rows[i][j], e, scale)) return 'mismatch';
  }
  return 'match';
}

export function expectedToText(exp: Expected, decimals = 4): string {
  const o = { decimals, expThreshold: 7, maxMatrix: 6 };
  const sc = (s: ExpScalar | null) => {
    if (!s) return '?';
    const n = formatReal(s.re, o).text + (s.im ? ` ${s.im < 0 ? '-' : '+'} ${formatReal(Math.abs(s.im), o).text}i` : '');
    const u = s.dims.some(d => d !== 0) ? ' ' + unitFactorsText(siUnitFactors(s.dims)) : '';
    return n + u;
  };
  if (exp.kind === 'string') return JSON.stringify(exp.v);
  if (exp.kind === 'scalar') return sc(exp.v);
  const shown = exp.v.slice(0, 6).map(sc).join('; ');
  return `${exp.rows}×${exp.cols}: [${shown}${exp.v.length > 6 ? '; …' : ''}]`;
}
