/**
 * Fast arithmetic for physical quantities.
 *
 * mathjs Units carry a list of unit factors that grows with every multiplication and is deep-cloned
 * on every operation, plus generic type dispatch. Here quantities with plain number values are
 * computed directly from their SI value and dimension vector; the result is again a (mathjs
 * compatible) Unit whose factor list is the canonical SI base representation, shared per dimension.
 */
import type { Unit } from 'mathjs';
import { math } from './units';

type U = Unit & { value: unknown; dimensions: number[]; units: { unit: { offset?: number } }[] };

const N = 9;
const UnitProto = (math.Unit as unknown as { prototype: object }).prototype;
/**
 * Prototype for fast quantities: the list of unit factors is only built when mathjs itself needs it
 * (e.g. for conversions), never in the arithmetic hot path.
 */
const QProto = Object.create(UnitProto, {
  units: {
    get(this: { dimensions: number[] }) {
      const u = canonicalUnits(this.dimensions);
      Object.defineProperty(this, 'units', { value: u, writable: true, configurable: true, enumerable: true });
      return u;
    },
    set(this: object, v: unknown) {
      Object.defineProperty(this, 'units', { value: v, writable: true, configurable: true, enumerable: true });
    },
    configurable: true,
  },
});
const BASE_SYMBOLS = ['kg', 'm', 's', 'A', 'K', 'cd', 'mol', 'rad', 'bits'];
const canonCache = new Map<string, unknown[]>();

function canonicalUnits(dims: number[]): unknown[] {
  const key = dims.join(',');
  let c = canonCache.get(key);
  if (!c) {
    const parts: string[] = [];
    for (let i = 0; i < N; i++) if (dims[i]) parts.push(`${BASE_SYMBOLS[i]}^${dims[i]}`);
    try {
      c = parts.length ? (math.unit(parts.join(' ')) as unknown as U).units : [];
    } catch {
      c = [];
    }
    Object.freeze(c);
    if (canonCache.size > 5000) canonCache.clear();
    canonCache.set(key, c);
  }
  return c;
}

export function isUnitFast(x: unknown): x is Unit {
  return typeof x === 'object' && x !== null && (x as { isUnit?: boolean }).isUnit === true;
}

/** True if the unit carries an offset (°C, °F) – such values use the exact mathjs path. */
export function hasOffset(u: Unit): boolean {
  if (Object.getPrototypeOf(u) === QProto) return false;
  const us = (u as U).units;
  for (let i = 0; i < us.length; i++) if (us[i].unit.offset) return true;
  return false;
}

/** A quantity with SI value `value` and dimension vector `dims` (plain number if dimensionless). */
export function mkQ(value: number, dims: number[]): Unit | number {
  let zero = true;
  for (let i = 0; i < N; i++) {
    const x = dims[i];
    // remove floating point residue from fractional powers: 0.5·2 = 0.9999999999999999
    if (x && Math.abs(x - Math.round(x)) < 1e-9) dims[i] = Math.round(x);
    if (dims[i]) zero = false;
  }
  if (zero) return value;
  const u = Object.create(QProto) as U;
  u.value = value;
  u.dimensions = dims;
  (u as unknown as { fixPrefix: boolean }).fixPrefix = false;
  (u as unknown as { skipAutomaticSimplification: boolean }).skipAutomaticSimplification = true;
  return u;
}

/** Plain-number SI value and dimensions of a scalar, or null if not applicable. */
export function qParts(x: unknown): { v: number; d: number[] | null } | null {
  if (typeof x === 'number') return { v: x, d: null };
  if (isUnitFast(x)) {
    const u = x as U;
    if (typeof u.value !== 'number' || hasOffset(u)) return null;
    return { v: u.value, d: u.dimensions };
  }
  return null;
}

function absParts(u: U): { v: number; d: number[] | null } | null {
  if (typeof u.value !== 'number') return null;
  const si = (u as unknown as Unit).toSI() as unknown as U;
  return typeof si.value === 'number' ? { v: si.value, d: si.dimensions } : null;
}

const ZERO = [0, 0, 0, 0, 0, 0, 0, 0, 0];

export function sameDims(a: number[] | null, b: number[] | null): boolean {
  const x = a ?? ZERO, y = b ?? ZERO;
  for (let i = 0; i < N; i++) if (Math.abs((x[i] ?? 0) - (y[i] ?? 0)) > 1e-12) return false;
  return true;
}

export class UnitMismatch extends Error {}

/** Fast scalar operation; returns undefined if the operands need the general path. */
export function qBinary(op: string, a: unknown, b: unknown): unknown {
  let pa = qParts(a);
  let pb = qParts(b);
  // °C/°F multiplied with or divided by another quantity: absolute temperature (independent of the order)
  if ((op === '*' || op === '/') && isUnitFast(a) && isUnitFast(b)) {
    pa ??= absParts(a as U);
    pb ??= absParts(b as U);
  }
  if (!pa || !pb) return undefined;
  if (!pa.d && !pb.d) return undefined; // plain numbers are handled by the caller
  switch (op) {
    case '*': {
      if (!pa.d) return mkQ(pa.v * pb.v, pb.d!);
      if (!pb.d) return mkQ(pa.v * pb.v, pa.d);
      const d = new Array(N);
      for (let i = 0; i < N; i++) d[i] = (pa.d[i] ?? 0) + (pb.d[i] ?? 0);
      return mkQ(pa.v * pb.v, d);
    }
    case '/': {
      if (pb.v === 0) return undefined;
      if (!pb.d) return mkQ(pa.v / pb.v, pa.d!);
      const d = new Array(N);
      for (let i = 0; i < N; i++) d[i] = ((pa.d ?? ZERO)[i] ?? 0) - (pb.d[i] ?? 0);
      return mkQ(pa.v / pb.v, d);
    }
    case '+': case '-': {
      if (!sameDims(pa.d, pb.d)) {
        // zero is compatible with every unit (Mathcad)
        if (pa.v === 0 && !pa.d) return op === '+' ? b : mkQ(-pb.v, pb.d!);
        if (pb.v === 0 && !pb.d) return a;
        throw new UnitMismatch('Einheiten passen nicht zusammen');
      }
      return mkQ(op === '+' ? pa.v + pb.v : pa.v - pb.v, (pa.d ?? pb.d)!);
    }
    case '<': case '>': case '<=': case '>=': case '==': case '!=': {
      if (!sameDims(pa.d, pb.d) && !(pa.v === 0 && !pa.d) && !(pb.v === 0 && !pb.d)) throw new UnitMismatch('Einheiten passen nicht zusammen');
      const x = pa.v, y = pb.v;
      const eq = x === y || Math.abs(x - y) <= 1e-12 * Math.max(Math.abs(x), Math.abs(y));
      switch (op) {
        case '<': return x < y && !eq ? 1 : 0;
        case '>': return x > y && !eq ? 1 : 0;
        case '<=': return x < y || eq ? 1 : 0;
        case '>=': return x > y || eq ? 1 : 0;
        case '==': return eq ? 1 : 0;
        default: return eq ? 0 : 1;
      }
    }
  }
  return undefined;
}

/** x^p for a quantity and a plain number exponent. */
export function qPow(a: unknown, p: number): unknown {
  const pa = qParts(a);
  if (!pa || !pa.d) return undefined;
  let v: number;
  if (pa.v < 0 && !Number.isInteger(p)) {
    // odd roots of negative quantities stay real: (-8 m³)^(1/3) = -2 m
    const inv = 1 / p;
    if (Math.abs(inv - Math.round(inv)) < 1e-12 && Math.round(inv) % 2 !== 0) v = -Math.pow(-pa.v, p);
    else return undefined;
  } else v = Math.pow(pa.v, p);
  const d = new Array(N);
  for (let i = 0; i < N; i++) d[i] = (pa.d[i] ?? 0) * p;
  return mkQ(v, d);
}

export function qNeg(a: unknown): unknown {
  const pa = qParts(a);
  if (!pa || !pa.d) return undefined;
  return mkQ(-pa.v, pa.d);
}

/** Quantity with the same dimensions as `tmpl` and SI value v. */
export function withValue(tmpl: Unit, v: number): Unit | number {
  if (hasOffset(tmpl)) { const u = tmpl.clone(); (u as U).value = v; return u; }
  return mkQ(v, (tmpl as U).dimensions);
}

/** Sum of scalars (numbers or quantities of equal dimension); undefined if the general path is needed. */
export function qSum(xs: unknown[]): unknown {
  let s = 0;
  let d: number[] | null = null;
  for (let i = 0; i < xs.length; i++) {
    const p = qParts(xs[i]);
    if (!p) return undefined;
    if (i === 0) d = p.d;
    else if (!sameDims(d, p.d)) {
      if (p.v === 0 && !p.d) continue;
      if (s === 0 && !d) d = p.d;
      else throw new UnitMismatch('Einheiten passen nicht zusammen');
    }
    s += p.v;
  }
  return d ? mkQ(s, d) : s;
}
