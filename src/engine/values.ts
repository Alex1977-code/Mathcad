import type { Complex, Matrix, Unit } from 'mathjs';
import type { Node } from './ast';
import { math } from './units';

export interface FnVal {
  kind: 'fn';
  name: string;
  params: string[];
  body?: Node;
  scope?: Scope;
  builtin?: (args: Val[], ctx: unknown) => Val;
  /** Solve-block constraints captured when the function was defined. */
  constraints?: { node: Node }[];
  /** Solve-block guess definitions captured with the constraints. */
  guesses?: { name: string; expr: Node }[];
}

export interface RangeVal {
  kind: 'range';
  start: number | Unit;
  step: number | Unit;
  end: number | Unit;
}

export type Val = number | Complex | Unit | Matrix | string | FnVal | RangeVal;

export class CalcError extends Error {
  constructor(msg: string, public culprit?: string) { super(msg); }
}

/** Lexically nested variable scope. */
export class Scope {
  vars = new Map<string, Val>();
  constructor(public parent?: Scope) {}
  get(name: string): Val | undefined {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let s: Scope | undefined = this;
    while (s) {
      const v = s.vars.get(name);
      if (v !== undefined) return v;
      s = s.parent;
    }
    return undefined;
  }
  has(name: string): boolean { return this.get(name) !== undefined; }
  set(name: string, v: Val) { this.vars.set(name, v); }
  /** Flattened copy (used to freeze the environment of a function definition). */
  snapshot(): Scope {
    const s = new Scope();
    const chain: Scope[] = [];
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let c: Scope | undefined = this;
    while (c) { chain.unshift(c); c = c.parent; }
    for (const sc of chain) for (const [k, v] of sc.vars) s.vars.set(k, v);
    return s;
  }
}

export const isFn = (v: unknown): v is FnVal => typeof v === 'object' && v !== null && (v as FnVal).kind === 'fn';
export const isRange = (v: unknown): v is RangeVal => typeof v === 'object' && v !== null && (v as RangeVal).kind === 'range';
export const isMatrix = (v: unknown): v is Matrix => math.isMatrix(v);
export const isUnit = (v: unknown): v is Unit => math.isUnit(v);
export const isComplex = (v: unknown): v is Complex => math.isComplex(v);

export function rangeValues(r: RangeVal): (number | Unit)[] {
  const out: (number | Unit)[] = [];
  const toN = (x: number | Unit) => (isUnit(x) ? (x as Unit).value as number : x as number);
  const start = toN(r.start), step = toN(r.step), end = toN(r.end);
  if (step === 0 || !isFinite(step)) throw new CalcError('Ungültige Schrittweite im Bereich');
  if ((end - start) / step < -1e-12) return out;
  const n = Math.floor((end - start) / step + 1e-9);
  if (n > 1e7) throw new CalcError('Bereich zu groß');
  const tmpl = isUnit(r.start) ? (r.start as Unit) : isUnit(r.end) ? (r.end as Unit) : null;
  for (let i = 0; i <= n; i++) {
    const v = start + i * step;
    if (tmpl) { const u = tmpl.clone(); (u as unknown as { value: number }).value = v; out.push(u); }
    else out.push(v);
  }
  return out;
}

/** Convert a value to a plain JS number if possible (dimensionless). */
export function toNumber(v: Val, what = 'Wert'): number {
  if (typeof v === 'number') return v;
  if (isUnit(v)) {
    const u = v as Unit;
    if (u.dimensions.every(d => d === 0)) return u.value as number;
    throw new CalcError(`${what} muss einheitenlos sein (hat Einheit ${u.formatUnits()})`);
  }
  if (isComplex(v)) {
    const c = v as Complex;
    if (Math.abs(c.im) < 1e-14 * Math.max(1, Math.abs(c.re))) return c.re;
    throw new CalcError(`${what} muss reell sein`);
  }
  if (isMatrix(v)) {
    const m = v as Matrix;
    if (m.size().every(s => s === 1)) return toNumber(m.toArray().flat(3)[0] as Val, what);
    throw new CalcError(`${what} muss ein Skalar sein, nicht eine Matrix`);
  }
  if (typeof v === 'string') throw new CalcError(`${what} muss eine Zahl sein, nicht eine Zeichenkette`);
  throw new CalcError(`${what} muss eine Zahl sein`);
}

export function toInt(v: Val, what = 'Index'): number {
  const n = toNumber(v, what);
  const r = Math.round(n);
  if (Math.abs(r - n) > 1e-9) throw new CalcError(`${what} muss ganzzahlig sein`);
  return r;
}

/** SI magnitude + dimension signature (for comparisons / verification). */
export function siValue(v: Val): { value: number | Complex; dims: number[] } {
  if (isUnit(v)) {
    const u = v as Unit;
    return { value: u.value as number, dims: u.dimensions.slice() };
  }
  if (typeof v === 'number' || isComplex(v)) return { value: v as number, dims: [0, 0, 0, 0, 0, 0, 0, 0, 0] };
  throw new CalcError('Kein Skalar');
}

/** Get the 2D array representation (rows × cols) of a matrix value. */
export function matrixRows(m: Matrix): Val[][] {
  const arr = m.toArray() as unknown;
  const size = m.size();
  if (size.length === 1) return (arr as Val[]).map(x => [x]);
  return arr as Val[][];
}

export function makeMatrix(rows: Val[][]): Matrix {
  if (rows.some(r => r.some(x => isMatrix(x)))) {
    // nested arrays (Mathcad allows matrices as elements)
    const M = (math as unknown as { DenseMatrix: new (d: unknown) => Matrix }).DenseMatrix;
    return new M({ data: rows.map(r => r.slice()), size: [rows.length, rows[0]?.length ?? 0] });
  }
  return math.matrix(rows as unknown as number[][]);
}

export function describeType(v: Val): string {
  if (typeof v === 'number') return 'Zahl';
  if (typeof v === 'string') return 'Zeichenkette';
  if (isFn(v)) return 'Funktion';
  if (isRange(v)) return 'Bereichsvariable';
  if (isMatrix(v)) return 'Matrix';
  if (isUnit(v)) return 'Größe';
  if (isComplex(v)) return 'komplexe Zahl';
  return 'Wert';
}
