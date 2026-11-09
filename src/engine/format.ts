import type { Complex, Matrix, Unit } from 'mathjs';
import { isComplex, isFn, isMatrix, isRange, isUnit, matrixRows, rangeValues, type Val } from './values';

export interface FormatOptions {
  /** Number of decimal places. */
  decimals: number;
  /** Numbers ≥ 10^expThreshold are shown in exponential notation. */
  expThreshold: number;
  /** Maximum matrix rows/cols shown. */
  maxMatrix: number;
  /** Decimal comma instead of point. */
  decimalComma?: boolean;
  /** Internal: values with units are never shown as 0 because of the zero threshold. */
  keepTiny?: boolean;
}

export const DEFAULT_FORMAT: FormatOptions = { decimals: 3, expThreshold: 7, maxMatrix: 12 };

export interface Formatted { latex: string; text: string }

/* ------------------------------ numbers ------------------------------ */

function trimZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

export function formatReal(x: number, o: FormatOptions = DEFAULT_FORMAT): Formatted {
  const f = formatRealDot(x, o);
  if (!o.decimalComma) return f;
  return { latex: f.latex.replace(/(\d)\.(\d)/g, '$1{,}$2'), text: f.text.replace(/(\d)\.(\d)/g, '$1,$2') };
}

/** Decimal rounding (half away from zero) on the shortest decimal representation. */
function toFixedDec(x: number, dec: number): string {
  const [m, e] = Math.abs(x).toExponential(14).split('e');
  const r = Math.round(Number(`${m}e${Number(e) + dec}`));
  const v = Number(`${r}e-${dec}`);
  return (x < 0 && v !== 0 ? '-' : '') + v.toFixed(dec);
}

function formatRealDot(x: number, o: FormatOptions): Formatted {
  if (Number.isNaN(x)) return { latex: '\\mathrm{NaN}', text: 'NaN' };
  if (!isFinite(x) || Math.abs(x) >= 1e307) return { latex: x < 0 ? '-\\infty' : '\\infty', text: x < 0 ? '-∞' : '∞' };
  if (x === 0 || (!o.keepTiny && Math.abs(x) < 1e-15)) return { latex: '0', text: '0' };
  // remove binary representation noise first (1.0005 is stored as 1.000499999…)
  x = Number(x.toPrecision(15));
  const ax = Math.abs(x);
  const small = Math.pow(10, -Math.max(o.decimals, 3));
  const rounded = Math.abs(Number(toFixedDec(x, Math.min(o.decimals, 15))));
  if (ax >= Math.pow(10, o.expThreshold) || rounded >= Math.pow(10, o.expThreshold) || ax < small) {
    let exp = Math.floor(Math.log10(ax));
    let mant = x / Math.pow(10, exp);
    const fix = (m: number) => trimZeros(toFixedDec(m, o.decimals));
    let ms = fix(mant);
    if (Math.abs(parseFloat(ms)) >= 10) { exp += 1; mant = x / Math.pow(10, exp); ms = fix(mant); }
    const sign = ms.startsWith('-') ? '-' : '';
    if (sign) ms = ms.slice(1);
    return {
      latex: `${sign}${ms}\\cdot 10^{${exp}}`,
      text: `${sign}${ms}·10^${exp}`,
    };
  }
  let dec = o.decimals;
  if (ax < 1) dec = Math.min(o.decimals + Math.max(0, Math.floor(-Math.log10(ax))), 15);
  let s = trimZeros(toFixedDec(x, dec));
  if (s === '-0') s = '0';
  return { latex: s.replace('-', '-'), text: s };
}

export function formatComplex(c: Complex, o: FormatOptions): Formatted {
  const scale = Math.max(Math.abs(c.re), Math.abs(c.im));
  const tiny = (x: number) => Math.abs(x) < 1e-15 || Math.abs(x) < scale * 1e-14;
  const re = tiny(c.re) ? 0 : c.re;
  const im = tiny(c.im) ? 0 : c.im;
  if (im === 0) return formatReal(re, o);
  const fi = formatReal(Math.abs(im), o);
  const imL = (fi.text === '1' ? '' : fi.latex) + '\\mathrm{i}';
  const imT = (fi.text === '1' ? '' : fi.text) + 'i';
  if (re === 0) return { latex: (im < 0 ? '-' : '') + imL, text: (im < 0 ? '-' : '') + imT };
  const fr = formatReal(re, o);
  return { latex: `${fr.latex}${im < 0 ? '-' : '+'}${imL}`, text: `${fr.text} ${im < 0 ? '-' : '+'} ${imT}` };
}

/* ------------------------------- units ------------------------------- */

// dimension order in mathjs: MASS, LENGTH, TIME, CURRENT, TEMPERATURE, LUMINOUS_INTENSITY, AMOUNT_OF_SUBSTANCE, ANGLE, BIT
const BASE_SYMS = ['kg', 'm', 's', 'A', 'K', 'cd', 'mol', 'rad', 'b'];
const BASE_ORDER = [0, 1, 4, 6, 3, 5, 7, 8, 2]; // kg m K mol A cd … then s last (kg·m/s²)

const DERIVED: { sym: string; dims: number[] }[] = [
  { sym: 'N', dims: [1, 1, -2, 0, 0, 0, 0, 0, 0] },
  { sym: 'Pa', dims: [1, -1, -2, 0, 0, 0, 0, 0, 0] },
  { sym: 'J', dims: [1, 2, -2, 0, 0, 0, 0, 0, 0] },
  { sym: 'W', dims: [1, 2, -3, 0, 0, 0, 0, 0, 0] },
  { sym: 'V', dims: [1, 2, -3, -1, 0, 0, 0, 0, 0] },
  { sym: 'C', dims: [0, 0, 1, 1, 0, 0, 0, 0, 0] },
  { sym: 'Ω', dims: [1, 2, -3, -2, 0, 0, 0, 0, 0] },
  { sym: 'F', dims: [-1, -2, 4, 2, 0, 0, 0, 0, 0] },
  { sym: 'S', dims: [-1, -2, 3, 2, 0, 0, 0, 0, 0] },
  { sym: 'Wb', dims: [1, 2, -2, -1, 0, 0, 0, 0, 0] },
  { sym: 'T', dims: [1, 0, -2, -1, 0, 0, 0, 0, 0] },
  { sym: 'H', dims: [1, 2, -2, -2, 0, 0, 0, 0, 0] },
];

export type UnitFactors = [string, number][];

/** Choose a readable SI representation for a dimension vector. */
export function siUnitFactors(dims: number[]): UnitFactors {
  const d = dims.map(x => Math.round(x * 1e6) / 1e6);
  const cost = (rest: number[], extra: number) => rest.reduce((s, x) => s + Math.abs(x), 0) + extra;
  let best: { sym?: string; rest: number[]; c: number } = { rest: d, c: cost(d, 0) };
  for (const dv of DERIVED) {
    for (const p of [1, -1, 2]) {
      const rest = d.map((x, i) => x - p * dv.dims[i]);
      // never introduce a mass dimension that the quantity does not have (m/s² instead of N/kg)
      if (d[0] === 0 && rest[0] !== 0) continue;
      const c = cost(rest, p === 1 ? 1 : p === -1 ? 1.01 : 1.5) + (rest[2] !== 0 ? 0.5 : 0);
      if (c < best.c - 1e-9) best = { sym: p === 1 ? dv.sym : `${dv.sym}^${p}`, rest, c };
    }
  }
  const out: UnitFactors = [];
  if (best.sym) {
    const [s, p] = best.sym.split('^');
    out.push([s, p ? parseFloat(p) : 1]);
  }
  for (const i of BASE_ORDER) if (best.rest[i] !== 0) out.push([BASE_SYMS[i], best.rest[i]]);
  return out;
}

const fmtPow = (p: number) => (Number.isInteger(p) ? String(p) : trimZeros(p.toFixed(3)));
const unitSymLatex = (s: string) => (s === 'Ω' ? '\\Omega' : `\\mathrm{${s}}`);

export function unitFactorsLatex(f: UnitFactors): string {
  const num = f.filter(([, p]) => p > 0);
  const den = f.filter(([, p]) => p < 0).map(([s, p]) => [s, -p] as [string, number]);
  const part = (xs: UnitFactors) => xs.map(([s, p]) => unitSymLatex(s) + (p === 1 ? '' : `^{${fmtPow(p)}}`)).join('\\cdot ');
  if (!den.length) return part(num);
  return `\\frac{${num.length ? part(num) : '1'}}{${part(den)}}`;
}
const SUP: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻', '.': '·' };
const sup = (p: number) => fmtPow(p).split('').map(c => SUP[c] ?? c).join('');
export function unitFactorsText(f: UnitFactors): string {
  const num = f.filter(([, p]) => p > 0);
  const den = f.filter(([, p]) => p < 0).map(([s, p]) => [s, -p] as [string, number]);
  const part = (xs: UnitFactors) => xs.map(([s, p]) => s + (p === 1 ? '' : sup(p))).join('·');
  if (!den.length) return part(num);
  const d = part(den);
  return `${num.length ? part(num) : '1'}/${den.length > 1 ? `(${d})` : d}`;
}

/* ------------------------------- values ------------------------------ */

function scalarSI(v: Val): { n: number | Complex; dims: number[] | null } {
  if (isUnit(v)) {
    const u = v as Unit;
    const val = u.value as unknown;
    return { n: (typeof val === 'number' ? val : (val as Complex)), dims: u.dimensions.every(d => d === 0) ? null : u.dimensions };
  }
  return { n: v as number | Complex, dims: null };
}

function fmtScalarNumber(n: number | Complex, o: FormatOptions, dims?: number[] | null): Formatted {
  if (dims) o = { ...o, keepTiny: true };
  return isComplex(n) ? formatComplex(n as Complex, o) : formatReal(n as number, o);
}

/** Format any value with automatic SI units. */
export function formatValue(v: Val, o: FormatOptions = DEFAULT_FORMAT): Formatted {
  if (typeof v === 'string') return { latex: `\\text{“${escapeText(v)}”}`, text: `"${v}"` };
  if (isFn(v)) return { latex: `\\text{Funktion}`, text: 'Funktion' };
  if (isRange(v)) {
    const vals = rangeValues(v);
    return formatColumn(vals, o);
  }
  if (isMatrix(v)) return formatMatrix(v as Matrix, o);
  const { n, dims } = scalarSI(v);
  const num = fmtScalarNumber(n, o, dims);
  if (!dims) return num;
  const f = siUnitFactors(dims);
  const needParens = isComplex(n) && (n as Complex).re !== 0 && (n as Complex).im !== 0;
  return {
    latex: `${needParens ? `\\left(${num.latex}\\right)` : num.latex}\\ ${unitFactorsLatex(f)}`,
    text: `${needParens ? `(${num.text})` : num.text} ${unitFactorsText(f)}`,
  };
}

function formatColumn(vals: Val[], o: FormatOptions): Formatted {
  const rows = vals.map(x => [x]);
  return formatRows(rows, o);
}

export function formatMatrix(m: Matrix, o: FormatOptions): Formatted {
  return formatRows(matrixRows(m), o);
}

function formatRows(rows: Val[][], o: FormatOptions): Formatted {
  const R = rows.length, C = rows[0]?.length ?? 0;
  if (!R || !C) return { latex: '\\left[\\;\\right]', text: '[]' };
  // common unit?
  const first = scalarSI(rows[0][0]);
  const common = first.dims ? first.dims.join(',') : '';
  const allSame = rows.every(r => r.every(x => !isMatrix(x) && typeof x !== 'string' && (scalarSI(x).dims?.join(',') ?? '') === common));
  const maxR = Math.min(R, o.maxMatrix), maxC = Math.min(C, o.maxMatrix);
  const cell = (x: Val): Formatted => {
    if (isMatrix(x)) { const s = (x as Matrix).size(); return { latex: `\\{${s[0]}\\times ${s[1]}\\}`, text: `{${s[0]}×${s[1]}}` }; }
    if (allSame) return fmtScalarNumber(scalarSI(x).n, o, first.dims);
    return formatValue(x, o);
  };
  const lrows: string[] = [];
  const trows: string[] = [];
  for (let i = 0; i < maxR; i++) {
    const cells = rows[i].slice(0, maxC).map(cell);
    const l = cells.map(c => c.latex);
    if (C > maxC) l.push('\\cdots');
    lrows.push(l.join(' & '));
    trows.push(cells.map(c => c.text).join(o.decimalComma ? '; ' : ', '));
  }
  if (R > maxR) lrows.push(Array(Math.min(C, maxC) + (C > maxC ? 1 : 0)).fill('\\vdots').join(' & '));
  let latex = `\\begin{bmatrix}${lrows.join(' \\\\ ')}\\end{bmatrix}`;
  const rs = o.decimalComma ? ' | ' : '; ';
  let text = `[${trows.join(rs)}${R > maxR ? rs + '…' : ''}]`;
  if (allSame && first.dims) {
    const f = siUnitFactors(first.dims);
    latex += `\\ ${unitFactorsLatex(f)}`;
    text += ` ${unitFactorsText(f)}`;
  }
  return { latex, text };
}

export function escapeText(s: string): string {
  const map: Record<string, string> = { '\\': '\\textbackslash{}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' };
  return s.replace(/[\\{}$&#^_%~]/g, c => map[c] ?? `\\${c}`);
}
