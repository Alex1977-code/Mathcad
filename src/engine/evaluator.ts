import type { Complex, Matrix, Unit } from 'mathjs';
import { walk, type Node, type Stmt } from './ast';
import { math, lookupUnit } from './units';
import {
  CalcError, Scope, isFn, isMatrix, isRange, isUnit, isComplex, makeMatrix, matrixRows, rowsOf,
  rangeValues, toInt, toNumber, type FnVal, type RangeVal, type Val,
} from './values';
import { BUILTINS, LAZY_BUILTINS, CONSTANTS, PHYS_CONSTANTS } from './builtins';
import { derivative, integrate } from './numeric';
import { hasOffset, mkQ, qBinary, qNeg, qPow, UnitMismatch, withValue } from './quantity';

export interface EvalOptions {
  origin: number;
}

export interface Constraint { node: Node }

export class Evaluator {
  depth = 0;
  steps = 0;
  /** Matrices created by indexed assignment that no other variable references (may be mutated in place). */
  owned = new WeakSet<object>();
  intDepth = 0;
  /** >0 while a solve block iterates (integrals may use a looser tolerance). */
  inSolver = 0;
  /** Solve block constraints visible to Find/Minerr. */
  constraints: Constraint[] = [];
  /** Guess definitions of the current solve block (re-evaluated by Find). */
  guesses: { name: string; expr: Node }[] = [];
  constructor(public opts: EvalOptions = { origin: 0 }) {}

  /* --------------------------- lookup ---------------------------- */

  lookup(name: string, scope: Scope): Val {
    if (name.startsWith("'")) {
      const pc = PHYS_CONSTANTS[name.slice(1)];
      if (pc) return pc();
      const u = lookupUnit(name.slice(1));
      if (u === null) throw new CalcError(`Einheit „${name.slice(1)}“ ist unbekannt`, name);
      return u as Val;
    }
    const v = scope.get(name);
    if (v !== undefined) return v;
    if (name in CONSTANTS) return CONSTANTS[name]();
    if (name === 'ORIGIN') return this.opts.origin;
    const u = lookupUnit(name);
    if (u !== null) return u as Val;
    if (name in BUILTINS || name in LAZY_BUILTINS) {
      const b = BUILTINS[name];
      if (b) return { kind: 'fn', name, params: [], builtin: (args) => b(args, this) } as FnVal;
    }
    throw new CalcError(`„${name}“ ist nicht definiert`, name);
  }

  /* --------------------------- evaluate -------------------------- */

  eval(n: Node, scope: Scope, vec = false): Val {
    if (++this.steps > 3e8) throw new CalcError('Berechnung abgebrochen (zu viele Schritte)');
    switch (n.k) {
      case 'num': return n.v;
      case 'imag': return math.complex(0, n.v);
      case 'str': return n.v;
      case 'id': return this.lookup(n.name, scope);
      case 'paren': return this.eval(n.a, scope, vec);
      case 'placeholder': throw new CalcError('Platzhalter ist leer');
      case 'bin': return this.evalBin(n, scope, vec);
      case 'un': return this.evalUn(n.op, n.a, scope, vec);
      case 'nroot': {
        const deg = toNumber(this.eval(n.n, scope, vec), 'Wurzelexponent');
        const a = this.eval(n.a, scope, vec);
        return this.nthRoot(a, deg, vec);
      }
      case 'call': return this.evalCall(n.name, n.args, scope, vec);
      case 'index': {
        const a = this.eval(n.a, scope, vec);
        const idx = n.idx.map(i => this.eval(i, scope));
        return this.indexGet(a, idx);
      }
      case 'col': {
        const a = this.eval(n.a, scope, vec);
        if (!isMatrix(a)) throw new CalcError('Spaltenoperator benötigt eine Matrix');
        const j = toInt(this.eval(n.j, scope), 'Spaltenindex') - this.opts.origin;
        const rows = matrixRows(a as Matrix);
        if (j < 0 || j >= rows[0].length) throw new CalcError('Spaltenindex außerhalb des Bereichs');
        return makeMatrix(rows.map(r => [r[j]]));
      }
      case 'matrix': {
        if (!n.rows.length) throw new CalcError('Leere Matrix');
        const rows = n.rows.map(r => r.map(c => this.eval(c, scope, vec)));
        if (rows.length === 1 && rows[0].length === 1 && isMatrix(rows[0][0])) return rows[0][0];
        for (const r of rows) for (const c of r) {
          if (isFn(c) || isRange(c)) throw new CalcError('Ungültiges Matrixelement');
          // a matrix stored inside another one is shared: it must never be modified in place again
          if (isMatrix(c)) this.owned.delete(c as object);
        }
        return makeMatrix(rows);
      }
      case 'range': {
        const start = this.eval(n.start, scope) as number | Unit;
        const end = this.eval(n.end, scope) as number | Unit;
        let step: number | Unit;
        if (n.second) step = math.subtract(this.eval(n.second, scope) as number, start as number) as number | Unit;
        else {
          const s = isUnit(start) ? (start as Unit).value as number : start as number;
          const e = isUnit(end) ? (end as Unit).value as number : end as number;
          step = e >= s ? 1 : -1;
        }
        for (const x of [start, end, step]) if (!(typeof x === 'number' || isUnit(x))) throw new CalcError('Bereichsgrenzen müssen reelle Zahlen sein');
        return { kind: 'range', start, step, end } as RangeVal;
      }
      case 'iter': return this.evalIter(n, scope, vec);
      case 'int': return this.evalIntegral(n.body, n.v, n.lo, n.hi, scope);
      case 'deriv': return this.evalDerivative(n.body, n.v, n.order ?? 1, scope);
      case 'program': return this.runProgram(n.body, new Scope(scope));
    }
  }

  /* --------------------------- operators ------------------------- */

  evalBin(n: Extract<Node, { k: 'bin' }>, scope: Scope, vec: boolean): Val {
    if (n.op === 'and') return this.truthy(this.eval(n.a, scope, vec)) ? (this.truthy(this.eval(n.b, scope, vec)) ? 1 : 0) : 0;
    if (n.op === 'or') return this.truthy(this.eval(n.a, scope, vec)) ? 1 : (this.truthy(this.eval(n.b, scope, vec)) ? 1 : 0);
    const a = this.eval(n.a, scope, vec);
    const b = this.eval(n.b, scope, vec);
    return this.binary(n.op, a, b, vec);
  }

  binary(op: string, a: Val, b: Val, vec = false): Val {
    if (typeof a === 'number' && typeof b === 'number') {
      // fast path for plain numbers (avoids mathjs dispatch)
      switch (op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': if (b !== 0) return a / b; break;
        case '^': if (a >= 0 || Number.isInteger(b)) return Math.pow(a, b); break;
        case '<': return a < b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '<=': return a <= b || Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b)) ? 1 : 0;
        case '>=': return a >= b || Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b)) ? 1 : 0;
        case '==': return a === b || Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b)) ? 1 : 0;
        case '!=': return a === b || Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b)) ? 0 : 1;
      }
    }
    if (isUnit(a) || isUnit(b)) {
      // fast path for scalar quantities
      try {
        const r = qBinary(op, a, b);
        if (r !== undefined) return r as Val;
      } catch (e) { if (e instanceof UnitMismatch) throw new CalcError(e.message); throw e; }
    }
    if (isFn(a) || isFn(b)) throw new CalcError('Funktionen können nicht direkt verrechnet werden – Argumente angeben, z. B. f(x)');
    if (isRange(a) || isRange(b)) throw new CalcError('Bereichsvariable hier nicht erlaubt');
    try {
      switch (op) {
        case '+':
          if (typeof a === 'string' || typeof b === 'string') throw new CalcError('Zeichenketten mit concat() verbinden');
          if (isMatrix(a) || isMatrix(b)) return this.ew('+', a, b);
          // 0 is compatible with every unit (Mathcad)
          if (a === 0 && isUnit(b)) return b;
          if (b === 0 && isUnit(a)) return a;
          return this.simplify(math.add(a as number, b as number) as Val);
        case '-':
          if (isMatrix(a) || isMatrix(b)) return this.ew('-', a, b);
          if (b === 0 && isUnit(a)) return a;
          if (a === 0 && isUnit(b)) return math.unaryMinus(b as Unit) as Val;
          return this.simplify(math.subtract(a as number, b as number) as Val);
        case '*': return this.multiply(a, b, vec);
        case '/': return this.divide(a, b, vec);
        case '^': return this.power(a, b, vec);
        case 'cross': return cross3(a, b);
        case '==': return this.compare(a, b, (x, y) => math.equal(x, y) as boolean, vec, '==');
        case '!=': return this.compare(a, b, (x, y) => !math.equal(x, y), vec, '!=');
        case '<': return this.compare(a, b, (x, y) => math.smaller(x, y) as boolean, vec, '<');
        case '>': return this.compare(a, b, (x, y) => math.larger(x, y) as boolean, vec, '>');
        case '<=': return this.compare(a, b, (x, y) => math.smallerEq(x, y) as boolean, vec, '<=');
        case '>=': return this.compare(a, b, (x, y) => math.largerEq(x, y) as boolean, vec, '>=');
        case 'xor': return (this.truthy(a) !== this.truthy(b)) ? 1 : 0;
      }
    } catch (e) { throw translateError(e); }
    throw new CalcError(`Unbekannter Operator ${op}`);
  }

  compare(a: Val, b: Val, f: (x: never, y: never) => boolean, vec: boolean, op = ''): Val {
    if (typeof a === 'string' && typeof b === 'string') return f(a as never, b as never) ? 1 : 0;
    if (isMatrix(a) || isMatrix(b)) {
      if (!vec && isMatrix(a) && isMatrix(b) && (op === '==' || op === '!=')) {
        const eq = math.deepEqual(a as Matrix, b as Matrix) as unknown as boolean;
        return (op === '==') === eq ? 1 : 0;
      }
      return this.ew(op, a, b);
    }
    return f(a as never, b as never) ? 1 : 0;
  }

  multiply(a: Val, b: Val, vec: boolean): Val {
    if (typeof a === 'number' && typeof b === 'number') return a * b;
    if (isUnit(a) || isUnit(b)) { const r = qBinary('*', a, b); if (r !== undefined) return r as Val; }
    if (typeof a === 'string' || typeof b === 'string') throw new CalcError('Zeichenketten können nicht multipliziert werden');
    if (isMatrix(a) && isMatrix(b)) {
      const A = a as Matrix, B = b as Matrix;
      if (vec) return this.ew('*', A, B);
      const sa = A.size(), sb = B.size();
      if (sa[1] === 1 && sb[1] === 1 && sa[0] === sb[0] && sa[0] !== 1) {
        // vector · vector  → dot product (Mathcad)
        const ra = rowsOf(A), rb = rowsOf(B);
        let acc: Val = this.binary('*', ra[0][0], rb[0][0]);
        for (let i = 1; i < ra.length; i++) acc = this.binary('+', acc, this.binary('*', ra[i][0], rb[i][0]));
        return acc;
      }
      if (sa[1] !== sb[0]) throw new CalcError(`Matrixdimensionen passen nicht: ${sa.join('×')} · ${sb.join('×')}`);
      if (rowsOf(A).some(r => r.some(x => isUnit(x))) || rowsOf(B).some(r => r.some(x => isUnit(x)))) return this.matmul(A, B);
    } else if (isMatrix(a) || isMatrix(b)) return this.ew('*', a, b);
    const prod = math.multiply(a as number, b as number) as Val;
    // row · column gives a scalar (as with quantities)
    if (isMatrix(prod) && (prod as Matrix).size().every(d => d === 1)) return this.simplify(rowsOf(prod as Matrix)[0][0]);
    return this.simplify(prod);
  }

  divide(a: Val, b: Val, vec: boolean): Val {
    if (typeof a === 'number' && typeof b === 'number' && b !== 0) return a / b;
    if (isUnit(a) || isUnit(b)) { const r = qBinary('/', a, b); if (r !== undefined) return r as Val; }
    if (typeof a === 'string' || typeof b === 'string') throw new CalcError('Zeichenketten können nicht dividiert werden');
    if (isMatrix(b) && vec) return this.ew('/', a, b);
    if (isMatrix(a) && !isMatrix(b)) return this.ew('/', a, b);
    if (isMatrix(b) && !this.isSquare(b as Matrix)) throw new CalcError('Division durch eine nicht-quadratische Matrix');
    const r = math.divide(a as number, b as number) as Val;
    return this.simplify(r);
  }

  isSquare(m: Matrix) { const s = m.size(); return s.length === 2 && s[0] === s[1]; }

  /** Element-wise operation with broadcasting of scalars (fast path, no mathjs dispatch). */
  ew(op: string, a: Val, b: Val): Matrix {
    const A = isMatrix(a) ? rowsOf(a as Matrix) : null, B = isMatrix(b) ? rowsOf(b as Matrix) : null;
    const R = (A ?? B)!;
    if (A && B && (A.length !== B.length || A[0].length !== B[0].length)) {
      throw new CalcError(`Dimensionen passen nicht: ${A.length}×${A[0].length} und ${B.length}×${B[0].length}`);
    }
    const out: Val[][] = new Array(R.length);
    for (let i = 0; i < R.length; i++) {
      const row = new Array(R[0].length);
      for (let j = 0; j < R[0].length; j++) row[j] = this.binary(op, A ? A[i][j] : a, B ? B[i][j] : b);
      out[i] = row;
    }
    return makeMatrix(out);
  }

  /** Matrix product for matrices containing quantities. */
  matmul(A: Matrix, B: Matrix): Val {
    const a = rowsOf(A), b = rowsOf(B);
    const n = a.length, m = b[0].length, k = b.length;
    const out: Val[][] = [];
    for (let i = 0; i < n; i++) {
      const row: Val[] = [];
      for (let j = 0; j < m; j++) {
        let acc: Val = this.binary('*', a[i][0], b[0][j]);
        for (let t = 1; t < k; t++) acc = this.binary('+', acc, this.binary('*', a[i][t], b[t][j]));
        row.push(acc);
      }
      out.push(row);
    }
    return n === 1 && m === 1 ? out[0][0] : makeMatrix(out);
  }

  power(a: Val, b: Val, vec: boolean): Val {
    if (isMatrix(b)) {
      if (vec || !isMatrix(a)) return this.ew('^', a, b);
      throw new CalcError('Exponent darf keine Matrix sein');
    }
    if (isMatrix(a)) {
      if (vec) return this.ew('^', a, b);
      if (!this.isSquare(a as Matrix)) throw new CalcError('Potenz einer Matrix: Matrix muss quadratisch sein (elementweise mit vec(…))');
      const n = toNumber(b, 'Matrixexponent');
      if (!Number.isInteger(n)) throw new CalcError('Matrixexponent muss ganzzahlig sein');
      let M = a as Matrix;
      if (n < 0) { M = math.inv(M); }
      return this.simplify(math.pow(M, Math.abs(n)) as Val);
    }
    if (isUnit(b)) b = toNumber(b, 'Exponent');
    if (isUnit(a)) {
      const ua = a as Unit;
      const e = toNumber(b, 'Exponent');
      const fast = qPow(ua, e);
      if (fast !== undefined) return fast as Val;
      if (ua.dimensions.every(d => d === 0)) return Math.pow(ua.value as number, e);
      return this.simplify(math.pow(ua, e) as Val);
    }
    if (typeof a === 'number' && typeof b === 'number') {
      if (a < 0 && !Number.isInteger(b)) {
        // odd roots of negatives stay real in Mathcad when the exponent is 1/n with odd n
        const inv = 1 / b;
        if (Math.abs(inv - Math.round(inv)) < 1e-12 && Math.round(inv) % 2 !== 0) return -Math.pow(-a, b);
        return math.pow(a, b) as Val;
      }
      return Math.pow(a, b);
    }
    return this.simplify(math.pow(a as number, b as number) as Val);
  }

  nthRoot(a: Val, n: number, vec: boolean): Val {
    if (isMatrix(a)) return math.map(a as Matrix, (x: unknown) => this.nthRoot(x as Val, n, vec) as never) as Matrix;
    if (typeof a === 'number') {
      if (a < 0 && Number.isInteger(n) && n % 2 !== 0) return -Math.pow(-a, 1 / n);
      if (a < 0) return math.pow(a, 1 / n) as Val;
      return Math.pow(a, 1 / n);
    }
    return this.power(a, 1 / n, vec);
  }

  evalUn(op: string, an: Node, scope: Scope, vec: boolean): Val {
    if (op === 'vec') return this.eval(an, scope, true);
    const a = this.eval(an, scope, vec);
    if (isUnit(a)) {
      if (op === 'neg') { const r = qNeg(a); if (r !== undefined) return r as Val; }
      if (op === 'sqrt') { const r = qPow(a, 0.5); if (r !== undefined) return r as Val; }
      if (op === 'abs') { const v = (a as unknown as { value: unknown }).value; if (typeof v === 'number' && !hasOffset(a as Unit)) return mkQ(Math.abs(v), (a as unknown as { dimensions: number[] }).dimensions) as Val; }
    }
    if (typeof a === 'number') {
      if (op === 'neg') return -a;
      if (op === 'sqrt' && a >= 0) return Math.sqrt(a);
      if (op === 'abs') return Math.abs(a);
      if (op === 'pct') return a / 100;
    }
    if (isFn(a)) throw new CalcError('Funktion ohne Argumente verwendet');
    if (isRange(a)) throw new CalcError('Bereichsvariable hier nicht erlaubt');
    try {
      switch (op) {
        case 'neg':
          if (isMatrix(a)) return makeMatrix(rowsOf(a as Matrix).map(r => r.map(x => this.binary('-', 0, x))));
          return math.unaryMinus(a as number) as Val;
        case 'not': return this.truthy(a) ? 0 : 1;
        case 'fact': {
          if (isMatrix(a)) return math.map(a as Matrix, (x: number) => math.factorial(x)) as Matrix;
          const x = toNumber(a, 'Fakultät');
          if (x < 0 || !Number.isInteger(x)) return math.gamma(x + 1);
          return math.factorial(x);
        }
        case 'pct': return math.divide(a as number, 100) as Val;
        case 'transpose':
          if (!isMatrix(a)) return a;
          return math.transpose(a as Matrix);
        case 'abs': {
          if (isMatrix(a)) {
            const m = a as Matrix;
            const s = m.size();
            if (s[1] === 1 || s[0] === 1) {
              let acc: Val = 0;
              for (const x of rowsOf(m).flat()) acc = this.binary('+', acc, this.binary('*', x, x));
              return this.power(acc, 0.5, false);
            }
            if (s[0] === s[1]) return this.simplify(math.det(m) as Val);
            throw new CalcError('|M| ist nur für Vektoren und quadratische Matrizen definiert');
          }
          if (typeof a === 'string') return a.length;
          return math.abs(a as number) as Val;
        }
        case 'sqrt': {
          if (isMatrix(a)) return math.map(a as Matrix, (x: number) => (typeof x === 'number' && x >= 0 ? Math.sqrt(x) : math.sqrt(x))) as Matrix;
          if (typeof a === 'number' && a >= 0) return Math.sqrt(a);
          return this.simplify(math.sqrt(a as number) as Val);
        }
      }
    } catch (e) { throw translateError(e); }
    throw new CalcError(`Unbekannter Operator ${op}`);
  }

  /** Collapse dimensionless units to numbers and tiny imaginary parts to reals. */
  simplify(v: Val): Val {
    if (isMatrix(v) && (v as Matrix).size().length === 1) return math.reshape(v as Matrix, [(v as Matrix).size()[0], 1]) as Matrix;
    if (isUnit(v)) {
      const u = v as Unit;
      // offset units (°C, °F) are converted to absolute temperatures immediately
      if (u.units.some(x => (x.unit as unknown as { offset: number }).offset)) return u.toSI() as Val;
      if (u.dimensions.every(d => d === 0)) {
        const val = u.value as unknown;
        if (typeof val === 'number') return val;
        if (val !== null && val !== undefined) return val as Val;
        return 1;
      }
    }
    return v;
  }

  truthy(v: Val): boolean {
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v.length > 0;
    if (isUnit(v)) return ((v as Unit).value as number) !== 0;
    if (isComplex(v)) return (v as Complex).re !== 0 || (v as Complex).im !== 0;
    if (isMatrix(v)) throw new CalcError('Bedingung muss ein Skalar sein, nicht eine Matrix');
    throw new CalcError('Ungültige Bedingung');
  }

  /* --------------------------- indexing -------------------------- */

  indexGet(a: Val, idxv: Val[]): Val {
    if (typeof a === 'string') throw new CalcError('Zeichenketten können nicht indiziert werden');
    if (!isMatrix(a)) {
      // scalars behave like 1×1 matrices
      const idx = idxv.map(i => toInt(i) - this.opts.origin);
      if (idx.every(i => i === 0)) return a;
      throw new CalcError('Index auf einen Skalar angewendet');
    }
    const m = a as Matrix;
    const [r, c] = m.size();
    const idx = idxv.map(i => toInt(i, 'Index') - this.opts.origin);
    let i: number, j: number;
    if (idx.length === 1) {
      if (c === 1) { i = idx[0]; j = 0; }
      else if (r === 1) { i = 0; j = idx[0]; }
      else throw new CalcError('Matrix benötigt zwei Indizes [Zeile, Spalte]');
    } else if (idx.length === 2) { i = idx[0]; j = idx[1]; }
    else throw new CalcError('Zu viele Indizes');
    if (i < 0 || j < 0 || i >= r || j >= c) {
      throw new CalcError(`Index außerhalb des Bereichs (gültig: ${this.opts.origin}…${this.opts.origin + (idx.length === 1 ? Math.max(r, c) : r) - 1})`);
    }
    return m.get([i, j]) as Val;
  }

  /** Return a new (or mutated, if owned) matrix with element set. */
  indexSet(base: Val | undefined, idxv: Val[], value: Val, mutate: boolean): Matrix {
    const idx = idxv.map(i => toInt(i, 'Index') - this.opts.origin);
    if (mutate && !(base !== undefined && isMatrix(base) && this.owned.has(base as object))) mutate = false;
    // append to an owned column vector without copying (common in loops: v[i] ← …)
    if (mutate && base !== undefined && isMatrix(base) && !isMatrix(value) && idx.length === 1) {
      const m = base as Matrix & { _data: Val[][]; _size: number[] };
      if (Array.isArray(m._data) && m._size.length === 2 && m._size[1] === 1 && idx[0] >= m._size[0] && Array.isArray(m._data[0])) {
        for (let k = m._size[0]; k < idx[0]; k++) m._data.push([0]);
        m._data.push([value]);
        m._size[0] = idx[0] + 1;
        return m;
      }
    }
    if (idx.some(i => i < 0)) throw new CalcError(`Index kleiner als ORIGIN (${this.opts.origin})`);
    if (isMatrix(value) || (base !== undefined && isMatrix(base) && hasNested(base as Matrix))) {
      if (isMatrix(value)) this.owned.delete(value as object);
      // nested array: rebuild from rows
      const rows: Val[][] = base !== undefined && isMatrix(base) ? matrixRows(base as Matrix).map(r => r.slice()) : (base !== undefined && !isFn(base) && !isRange(base) && typeof base !== 'string' ? [[base]] : [[0]]);
      const c0 = rows[0].length;
      let i: number, j: number;
      if (idx.length === 1) { if (c0 === 1) { i = idx[0]; j = 0; } else if (rows.length === 1) { i = 0; j = idx[0]; } else throw new CalcError('Matrix benötigt zwei Indizes'); } else { i = idx[0]; j = idx[1]; }
      const C = Math.max(c0, j + 1);
      while (rows.length <= i) rows.push([]);
      for (const r of rows) while (r.length < C) r.push(0);
      rows[i][j] = value;
      const nm = makeMatrix(rows);
      this.owned.add(nm);
      return nm;
    }
    if (idx.some(i => i < 0)) throw new CalcError(`Index kleiner als ORIGIN (${this.opts.origin})`);
    let m: Matrix;
    if (base !== undefined && isMatrix(base)) m = mutate ? base as Matrix : (base as Matrix).clone();
    else if (base !== undefined && !isFn(base) && !isRange(base) && typeof base !== 'string') m = makeMatrix([[base]]);
    else m = makeMatrix([[0]]);
    const [r, c] = m.size();
    let i: number, j: number;
    if (idx.length === 1) {
      if (c === 1) { i = idx[0]; j = 0; } else if (r === 1) { i = 0; j = idx[0]; } else throw new CalcError('Matrix benötigt zwei Indizes');
    } else { i = idx[0]; j = idx[1]; }
    if (i >= r || j >= c) m.resize([Math.max(r, i + 1), Math.max(c, j + 1)], 0);
    m.set([i, j], value as number);
    this.owned.add(m);
    return m;
  }

  /* ---------------------------- calls ---------------------------- */

  evalCall(name: string, argNodes: Node[], scope: Scope, vec: boolean): Val {
    const user = scope.get(name);
    if (user !== undefined) {
      if (isFn(user)) return this.callFn(user, argNodes.map(a => this.eval(a, scope, vec)), vec);
      if (argNodes.length === 1 && !isRange(user)) {
        // a(b) with a variable a: implicit multiplication
        return this.multiply(user, this.eval(argNodes[0], scope, vec), vec);
      }
      throw new CalcError(`„${name}“ ist keine Funktion`, name);
    }
    const lazy = LAZY_BUILTINS[name];
    if (lazy) return lazy(argNodes, scope, this);
    const b = BUILTINS[name];
    if (b) {
      const args = argNodes.map(a => this.eval(a, scope, vec));
      try {
        return this.simplify(b(args, this));
      } catch (e) { throw translateError(e); }
    }
    const u = lookupUnit(name);
    if (u !== null && argNodes.length === 1) return this.multiply(u as Val, this.eval(argNodes[0], scope, vec), vec);
    throw new CalcError(`Funktion „${name}“ ist nicht definiert`, name);
  }

  callFn(f: FnVal, args: Val[], vec = false): Val {
    if (f.builtin) return this.simplify(f.builtin(args, this));
    if (args.length !== f.params.length) {
      throw new CalcError(`${f.name} erwartet ${f.params.length} Argument${f.params.length === 1 ? '' : 'e'}, erhalten: ${args.length}`, f.name);
    }
    if (vec && args.some(a => isMatrix(a))) {
      const shapeSrc = args.find(a => isMatrix(a)) as Matrix;
      return math.map(shapeSrc, (_x: unknown, idx: number[]) =>
        this.callFn(f, args.map(a => (isMatrix(a) ? (a as Matrix).get(idx) : a)), false) as never) as Matrix;
    }
    if (this.depth > 3000) throw new CalcError('Rekursion zu tief');
    const local = new Scope(f.scope);
    f.params.forEach((p, i) => local.set(p, args[i]));
    this.depth++;
    const saved = this.constraints, savedG = this.guesses;
    if (f.constraints) this.constraints = f.constraints;
    if (f.guesses) this.guesses = f.guesses;
    try {
      return this.eval(f.body!, local, false);
    } finally {
      this.depth--;
      this.constraints = saved;
      this.guesses = savedG;
    }
  }

  /* --------------------------- iterated -------------------------- */

  evalIter(n: Extract<Node, { k: 'iter' }>, scope: Scope, vec: boolean): Val {
    const combine = (acc: Val | undefined, v: Val): Val =>
      acc === undefined ? v : (n.op === 'sum' ? this.binary('+', acc, v) : this.multiply(acc, v, true));
    if (!n.v) {
      // Σv: sum of all elements
      const v = this.eval(n.body, scope, vec);
      if (!isMatrix(v)) return v;
      let acc: Val | undefined;
      for (const x of (v as Matrix).toArray().flat(2) as Val[]) acc = combine(acc, x);
      return acc ?? (n.op === 'sum' ? 0 : 1);
    }
    let values: Val[];
    if (n.lo && n.hi) {
      const lo = toInt(this.eval(n.lo, scope), 'Untere Grenze');
      const hi = toInt(this.eval(n.hi, scope), 'Obere Grenze');
      values = [];
      for (let i = lo; i <= hi; i++) values.push(i);
    } else {
      const r = scope.get(n.v) ?? (() => { throw new CalcError(`Bereichsvariable „${n.v}“ ist nicht definiert`, n.v); })();
      if (isRange(r)) values = rangeValues(r as RangeVal);
      else if (isMatrix(r)) values = (r as Matrix).toArray().flat(2) as Val[];
      else values = [r];
    }
    const local = new Scope(scope);
    let acc: Val | undefined;
    for (const x of values) {
      local.vars.set(n.v, x);
      acc = combine(acc, this.eval(n.body, local, vec));
    }
    return acc ?? (n.op === 'sum' ? 0 : 1);
  }

  /** Build a numeric function t ↦ SI(body(x=t·unit)). */
  numericFn(body: Node, v: string, scope: Scope, xTemplate: Val): { f: (t: number) => number; probe: (t: number) => Val } {
    const local = new Scope(scope);
    const make = (t: number): Val => {
      if (isUnit(xTemplate)) return withValue(xTemplate as Unit, t);
      return t;
    };
    const probe = (t: number) => { local.vars.set(v, make(t)); return this.eval(body, local); };
    const f = (t: number) => {
      const r = probe(t);
      if (typeof r === 'number') return r;
      if (isUnit(r)) return (r as Unit).value as number;
      if (isComplex(r)) {
        const c = r as Complex;
        if (Math.abs(c.im) < 1e-12 * Math.max(1, Math.abs(c.re))) return c.re;
      }
      throw new CalcError('Ausdruck muss eine reelle Zahl liefern');
    };
    return { f, probe };
  }

  evalIntegral(body: Node, v: string, loN: Node, hiN: Node, scope: Scope): Val {
    const lo = this.eval(loN, scope), hi = this.eval(hiN, scope);
    const si = (x: Val) => (isUnit(x) ? (x as Unit).value as number : toNumber(x, 'Integrationsgrenze'));
    const a = si(lo), b = si(hi);
    const tmpl = isUnit(lo) ? lo : hi;
    const { f, probe } = this.numericFn(body, v, scope, tmpl);
    const mid = isFinite(a) && isFinite(b) ? (a + b) / 2 : isFinite(a) ? a + 1 : isFinite(b) ? b - 1 : 0;
    const fm = probe(mid);
    // nested integrals use a looser tolerance (Mathcad: TOL = 10⁻³); outer integrals 10⁻¹⁰
    this.intDepth++;
    let res: number;
    // the result of an inner integral carries ~1e-9 relative noise; the outer tolerance must stay above it
    let nested = false;
    walk(body, (x) => { if (x.k === 'int') nested = true; });
    const tol = this.intDepth > 1 ? 1e-8 : nested ? 1e-6 : this.inSolver ? 1e-9 : 1e-10;
    try { res = integrate(f, a, b, tol); } finally { this.intDepth--; }
    let out: Val = res;
    if (isUnit(fm)) out = math.multiply(res, unitTemplate(fm as Unit)) as Val;
    if (isUnit(tmpl)) out = math.multiply(out as number, unitTemplate(tmpl as Unit)) as Val;
    return this.simplify(out);
  }

  evalDerivative(body: Node, v: string, order: number, scope: Scope): Val {
    const x0 = scope.get(v);
    if (x0 === undefined) throw new CalcError(`Für d/d${v} muss ${v} definiert sein (Auswertungsstelle)`, v);
    const { f, probe } = this.numericFn(body, v, scope, x0);
    const t0 = isUnit(x0) ? (x0 as Unit).value as number : toNumber(x0, v);
    const d = derivative(f, t0, order);
    const fx = probe(t0);
    let out: Val = d;
    if (isUnit(fx)) out = math.multiply(d, unitTemplate(fx as Unit)) as Val;
    if (isUnit(x0)) out = math.divide(out as number, math.pow(unitTemplate(x0 as Unit), order) as Unit) as Val;
    return this.simplify(out);
  }

  /* --------------------------- programs -------------------------- */

  runProgram(stmts: Stmt[], scope: Scope): Val {
    const r = this.execBlock(stmts, scope);
    if (r.value === undefined) throw new CalcError('Programm liefert keinen Wert');
    return r.value;
  }

  execBlock(stmts: Stmt[], scope: Scope): { flow: 'normal' | 'break' | 'continue' | 'return'; value?: Val } {
    let last: Val | undefined;
    for (const s of stmts) {
      switch (s.k) {
        case 'assign': last = this.assign(s.target, this.eval(s.value, scope), scope); break;
        case 'expr': last = this.eval(s.value, scope); break;
        case 'return': return { flow: 'return', value: this.eval(s.value, scope) };
        case 'break': return { flow: 'break', value: last };
        case 'continue': return { flow: 'continue', value: last };
        case 'if': {
          let taken = false;
          for (const br of s.branches) {
            if (this.truthy(this.eval(br.cond, scope))) {
              taken = true;
              const r = this.execBlock(br.body, scope);
              if (r.flow !== 'normal') return r;
              if (r.value !== undefined) last = r.value;
              break;
            }
          }
          if (!taken && s.otherwise) {
            const r = this.execBlock(s.otherwise, scope);
            if (r.flow !== 'normal') return r;
            if (r.value !== undefined) last = r.value;
          }
          break;
        }
        case 'for': {
          const it = this.eval(s.iter, scope);
          let values: Val[];
          if (isRange(it)) values = rangeValues(it as RangeVal);
          else if (isMatrix(it)) values = (it as Matrix).toArray().flat(2) as Val[];
          else values = [it];
          for (const x of values) {
            scope.vars.set(s.v, x);
            const r = this.execBlock(s.body, scope);
            if (r.value !== undefined) last = r.value;
            if (r.flow === 'return') return r;
            if (r.flow === 'break') break;
          }
          break;
        }
        case 'while': {
          let guard = 0;
          while (this.truthy(this.eval(s.cond, scope))) {
            if (++guard > 1e7) throw new CalcError('while-Schleife endet nicht');
            const r = this.execBlock(s.body, scope);
            if (r.value !== undefined) last = r.value;
            if (r.flow === 'return') return r;
            if (r.flow === 'break') break;
          }
          break;
        }
        case 'try': {
          try {
            const r = this.execBlock(s.body, scope);
            if (r.flow !== 'normal') return r;
            if (r.value !== undefined) last = r.value;
          } catch (e) {
            if (!(e instanceof CalcError)) throw e;
            const r = this.execBlock(s.onError, scope);
            if (r.flow !== 'normal') return r;
            if (r.value !== undefined) last = r.value;
          }
          break;
        }
      }
    }
    return { flow: 'normal', value: last };
  }

  assign(target: Node, value: Val, scope: Scope): Val {
    if (target.k === 'id') { if (isMatrix(value)) this.owned.delete(value as object); scope.vars.set(target.name, value); return value; }
    if (target.k === 'index' && target.a.k === 'id') {
      const name = target.a.name;
      const own = scope.vars.has(name);
      const base = scope.get(name);
      const m = this.indexSet(base, target.idx.map(i => this.eval(i, scope)), value, own);
      scope.vars.set(name, m);
      return m;
    }
    if (target.k === 'col' && target.a.k === 'id') {
      const name = target.a.name;
      const j = toInt(this.eval(target.j, scope), 'Spaltenindex') - this.opts.origin;
      const base = scope.get(name);
      const colRows = isMatrix(value) ? matrixRows(value as Matrix) : [[value]];
      let m: Matrix = base !== undefined && isMatrix(base) ? (base as Matrix).clone() : makeMatrix([[0]]);
      const [r, c] = m.size();
      m.resize([Math.max(r, colRows.length), Math.max(c, j + 1)], 0);
      colRows.forEach((row, i) => m.set([i, j], row[0] as number));
      scope.vars.set(name, m);
      return m;
    }
    throw new CalcError('Ungültiges Zuweisungsziel');
  }
}

function hasNested(m: Matrix): boolean {
  const data = m.valueOf() as unknown as unknown[][];
  for (const row of data) {
    if (Array.isArray(row)) { for (const x of row) if (isMatrix(x)) return true; } else if (isMatrix(row)) return true;
  }
  return false;
}

export function cross3(a: Val, b: Val): Val {
  if (!isMatrix(a) || !isMatrix(b)) throw new CalcError('Kreuzprodukt benötigt zwei Vektoren');
  const x = (a as Matrix).toArray().flat() as number[], y = (b as Matrix).toArray().flat() as number[];
  if (x.length !== 3 || y.length !== 3) throw new CalcError('Kreuzprodukt nur für 3-elementige Vektoren');
  const m = (p: number, q: number) => math.multiply(p, q) as number;
  const s = (p: number, q: number) => math.subtract(p, q) as number;
  return makeMatrix([[s(m(x[1], y[2]), m(x[2], y[1]))], [s(m(x[2], y[0]), m(x[0], y[2]))], [s(m(x[0], y[1]), m(x[1], y[0]))]]);
}

export function unitTemplate(u: Unit): Unit {
  if (!hasOffset(u)) return mkQ(1, (u as unknown as { dimensions: number[] }).dimensions) as Unit;
  const t = u.clone();
  (t as unknown as { value: number }).value = 1;
  return t;
}

const ERROR_MAP: [RegExp, string][] = [
  [/Units do not match/i, 'Einheiten passen nicht zusammen'],
  [/Unit .* not found/i, 'Unbekannte Einheit'],
  [/Dimension mismatch/i, 'Dimensionen passen nicht zusammen'],
  [/Index out of range/i, 'Index außerhalb des Bereichs'],
  [/Cannot calculate inverse, determinant is zero/i, 'Matrix ist singulär (Determinante 0)'],
  [/Matrix must be square/i, 'Matrix muss quadratisch sein'],
  [/Unexpected type of argument/i, 'Unpassender Argumenttyp'],
  [/Too few arguments/i, 'Zu wenige Argumente'],
  [/Too many arguments/i, 'Zu viele Argumente'],
  [/Cannot convert/i, 'Umrechnung nicht möglich'],
  [/Parameter .* must be a unitless/i, 'Argument muss einheitenlos sein'],
  [/singular|Linear system cannot be solved/i, 'Matrix ist singulär – Gleichungssystem nicht eindeutig lösbar'],
  [/Expected a column vector/i, 'Vektor (Spalte) erwartet'],
  [/failed to converge/i, 'Berechnung konvergiert nicht'],
  [/Unit in function .* is no angle/i, 'Argument muss einheitenlos sein'],
];

export function translateError(e: unknown): Error {
  if (e instanceof CalcError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  for (const [re, de] of ERROR_MAP) if (re.test(msg)) return new CalcError(de);
  return new CalcError(msg);
}

export { BUILTINS };
export type { Val };
// Re-export for consumers
export { Scope, CalcError, isMatrix, isUnit, isFn, isRange, isComplex };
export { math };
export { toNumber };
export type { Unit, Matrix };
export function unitOf(v: Val): Val { return isUnit(v) ? unitTemplate(v as Unit) : 1; }
