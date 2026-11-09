import type { Matrix, Unit } from 'mathjs';
import { walk, type MathStmt, type Node } from './ast';
import { parseMathRegion, parseExpression, ParseError } from './parser';
import { Evaluator, translateError } from './evaluator';
import { CONSTANTS, getRandomState, isBuiltinFunction, resetRandom } from './builtins';
import { getStatsSeed, setStatsSeed } from './stats';
import { lookupUnit, math } from './units';
import {
  CalcError, Scope, isFn, isMatrix, isRange, isUnit, isComplex, rangeValues, makeMatrix, toNumber,
  type FnVal, type RangeVal, type Val,
} from './values';
import { formatValue, formatReal, type FormatOptions, siUnitFactors, unitFactorsText } from './format';
import { stmtLatex, toLatex, type LatexCtx } from './latex';
import { sortRegions, type MathRegion, type PlotRegion, type Region, type Worksheet } from './model';
import { checkResult, expectedToText, type CheckStatus } from './verify';

export interface RegionError { message: string; culprit?: string; pos?: number; end?: number; kind: 'parse' | 'calc' }

export interface PlotTraceData { x: number[]; y: number[]; label: string; color?: string; style?: string }
export interface PlotData { traces: PlotTraceData[]; xLabel: string; yLabel: string; error?: string; xLim: [number | null, number | null]; yLim: [number | null, number | null] }

export interface RegionResult {
  id: string;
  /** LaTeX of the statement (without result). */
  latex?: string;
  /** LaTeX of the result (after "="). */
  resultLatex?: string;
  resultText?: string;
  /** Explicit display unit used (LaTeX). */
  unitLatex?: string;
  error?: RegionError;
  /** Name defined by this region. */
  defines?: string;
  kind?: MathStmt['kind'];
  global?: boolean;
  plot?: PlotData;
  /** Raw value (only when keepValues is set). */
  value?: Val;
  /** Solve-block role. */
  solve?: 'given' | 'constraint' | 'find';
  /** Comparison with the result stored in an imported Mathcad file. */
  check?: { status: CheckStatus; expected: string };
  /** Symbolic result from Mathcad (LaTeX), shown for symbolic evaluations. */
  symbolicLatex?: string;
}

export interface VariableInfo { name: string; kind: 'Variable' | 'Funktion' | 'Bereich'; text: string; latex: string; regionId: string }

export interface ComputeResult {
  results: Record<string, RegionResult>;
  /** Verification statistics against stored Mathcad results. */
  verification?: { match: number; mismatch: number; total: number };
  variables: VariableInfo[];
  errorCount: number;
  millis: number;
}

export interface ComputeOptions { keepValues?: boolean; maxStepsPerRegion?: number }

/* -------------------------------------------------------------------------- */

/** Free identifiers in an expression that are currently bound to range variables. */
export function freeRangeVars(n: Node, scope: Scope): string[] {
  const found = new Set<string>();
  const visit = (node: Node, bound: Set<string>) => {
    walk(node, (x) => {
      if (x.k === 'id') {
        if (!bound.has(x.name) && isRange(scope.get(x.name))) found.add(x.name);
      } else if (x.k === 'iter' && x.v) {
        const b = new Set(bound); b.add(x.v);
        visit(x.body, b);
        if (x.lo) visit(x.lo, bound);
        if (x.hi) visit(x.hi, bound);
        return false;
      } else if (x.k === 'int' || x.k === 'deriv') {
        const b = new Set(bound); b.add(x.v);
        visit(x.body, b);
        if (x.k === 'int') { visit(x.lo, bound); visit(x.hi, bound); }
        return false;
      } else if (x.k === 'program' || x.k === 'range') {
        return false;
      } else if (x.k === 'call' && (x.name === 'root' || x.name === 'Find' || x.name === 'Minerr')) {
        return false;
      }
    });
  };
  visit(n, new Set());
  return [...found];
}

function cartesian(names: string[], scope: Scope): Map<string, Val>[] {
  let combos: Map<string, Val>[] = [new Map()];
  for (const name of names) {
    const vals = rangeValues(scope.get(name) as RangeVal);
    const next: Map<string, Val>[] = [];
    for (const c of combos) for (const v of vals) { const m = new Map(c); m.set(name, v); next.push(m); }
    combos = next;
    if (combos.length > 2e6) throw new CalcError('Zu viele Kombinationen von Bereichsvariablen');
  }
  return combos;
}

/* -------------------------------------------------------------------------- */

export class WorksheetEngine {
  ev: Evaluator;
  fmt: FormatOptions;
  top = new Scope();

  constructor(public ws: Worksheet, public opts: ComputeOptions = {}) {
    this.ev = new Evaluator({ origin: ws.settings.origin ?? 0 });
    this.fmt = { decimals: ws.settings.decimals ?? 3, expThreshold: ws.settings.expThreshold ?? 7, maxMatrix: 12, decimalComma: !!ws.settings.decimalComma };
  }

  latexCtx(scope: Scope, highlight?: string): LatexCtx {
    return {
      isUnit: (name) => name.startsWith("'") || (scope.get(name) === undefined && !(name in CONSTANTS) && lookupUnit(name) !== null),
      isBuiltin: (name) => scope.get(name) === undefined && isBuiltinFunction(name),
      highlight,
    };
  }

  /* ------------------------- resumable state -------------------------- */

  inSolve = false;
  pendingGuesses: { name: string; expr: Node }[] = [];
  definedBy = new Map<string, string>();

  /** Copy of everything a later region can depend on (used to resume an interrupted or partial run). */
  snapshot(): EngineSnapshot {
    return {
      vars: new Map(this.top.vars),
      constraints: this.ev.constraints.slice(),
      guesses: this.ev.guesses.slice(),
      inSolve: this.inSolve,
      pendingGuesses: this.pendingGuesses.slice(),
      randomVars: new Set(this.randomVars),
      iterativeVars: new Set(this.iterativeVars),
      definedBy: new Map(this.definedBy),
      rng: [getRandomState(), getStatsSeed()],
    };
  }

  restore(s: EngineSnapshot) {
    this.top.vars = new Map(s.vars);
    this.ev.constraints = s.constraints.slice();
    this.ev.guesses = s.guesses.slice();
    this.inSolve = s.inSolve;
    this.pendingGuesses = s.pendingGuesses.slice();
    this.randomVars = new Set(s.randomVars);
    this.iterativeVars = new Set(s.iterativeVars);
    this.definedBy = new Map(s.definedBy);
    resetRandom(s.rng[0]);
    setStatsSeed(s.rng[1]);
  }

  /** Pass 1: global definitions (≡) are evaluated before everything else. */
  runGlobals(order: Region[], parsed: (r: MathRegion) => MathStmt | ParseError, results: Record<string, RegionResult>) {
    resetRandom(1);
    setStatsSeed(1);
    for (const r of order) {
      if (r.type !== 'math' || r.disabled) continue;
      const p = parsed(r);
      if (!(p instanceof ParseError) && p.kind === 'define' && p.global) {
        results[r.id] = this.runMath(r, p);
        if (!results[r.id].error) this.definedBy.set(p.target.name, r.id);
      }
    }
  }

  /** Pass 2: evaluate one region in worksheet order. */
  step(r: Region, parsed: (r: MathRegion) => MathStmt | ParseError, globalResults: Record<string, RegionResult>): RegionResult | undefined {
    if (r.type === 'plot') return { id: r.id, plot: this.runPlot(r) };
    if (r.type !== 'math') return undefined;
    const p = parsed(r);
    if (p instanceof ParseError) return { id: r.id, kind: undefined, error: { message: p.message, pos: p.pos, end: p.end, kind: 'parse' } };
    if (p.kind === 'define' && p.global) return globalResults[r.id];
    // solve blocks
    if (p.kind === 'expr' && p.expr.k === 'id' && /^given$/i.test(p.expr.name) && !this.top.get(p.expr.name)) {
      this.inSolve = true;
      this.ev.constraints = [];
      this.ev.guesses = this.pendingGuesses;
      this.pendingGuesses = [];
      return { id: r.id, kind: 'expr', latex: '\\textbf{Given}', solve: 'given' };
    }
    if (this.inSolve && p.kind === 'expr' && isConstraint(p.expr)) {
      this.ev.constraints.push({ node: p.expr });
      return { id: r.id, kind: 'expr', latex: stmtLatex(p, this.latexCtx(this.top)), solve: 'constraint' };
    }
    if (r.disabled) return { id: r.id, kind: p.kind, latex: stmtLatex(p, this.latexCtx(this.top)) };
    const res = this.runMath(r, p);
    if (r.guess && p.kind === 'define' && !p.target.params && !p.target.index && !p.target.multi) {
      this.pendingGuesses.push({ name: p.target.name, expr: p.expr });
      // a guess may depend on arguments of a solver function: not an error at this point
      if (res.error) { res.error = undefined; res.latex = stmtLatex(p, this.latexCtx(this.top)); }
    }
    if (this.inSolve && usesFind(p)) { res.solve = 'find'; this.inSolve = false; }
    if (p.kind === 'define' && !res.error) this.definedBy.set(p.target.name, r.id);
    return res;
  }

  /** Assemble the final result (variable table, statistics). */
  finish(results: Record<string, RegionResult>, t0: number): ComputeResult {
    const variables: VariableInfo[] = [];
    for (const [name, v] of this.top.vars) {
      const regionId = this.definedBy.get(name) ?? '';
      let info: VariableInfo;
      try {
        if (isFn(v)) {
          const f = v as FnVal;
          info = { name, kind: 'Funktion', text: `${name}(${f.params.join(', ')})`, latex: '', regionId };
        } else if (isRange(v)) {
          const rv = v as RangeVal;
          const vals = rangeValues(rv);
          const a = formatValue(rv.start, this.fmt).text, b = formatValue(rv.end, this.fmt).text;
          info = { name, kind: 'Bereich', text: `${a} … ${b} (${vals.length} Werte)`, latex: '', regionId };
        } else {
          const f = formatValue(v, { ...this.fmt, maxMatrix: 4 });
          info = { name, kind: 'Variable', text: f.text, latex: f.latex, regionId };
        }
      } catch { info = { name, kind: 'Variable', text: '?', latex: '', regionId }; }
      variables.push(info);
    }
    variables.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    const errorCount = Object.values(results).filter(r => r.error || r.plot?.error).length;
    const checks = Object.values(results).filter(r => r.check);
    const verification = checks.length ? {
      match: checks.filter(r => r.check!.status === 'match').length,
      mismatch: checks.filter(r => r.check!.status === 'mismatch').length,
      total: checks.length,
    } : undefined;
    return { results, variables, errorCount, millis: Date.now() - t0, verification };
  }

  compute(): ComputeResult {
    return new ComputeSession(this.opts).runToEnd(this.ws);
  }

  /* ------------------------------ math -------------------------------- */

  runMath(r: MathRegion, p: MathStmt): RegionResult {
    const res: RegionResult = { id: r.id, kind: p.kind };
    if (p.kind === 'define') { res.defines = p.target.name; res.global = p.global; }
    this.ev.steps = 0;
    const scope = this.top;
    try {
      switch (p.kind) {
        case 'empty': break;
        case 'expr': break;
        case 'eval': {
          const v = this.evalWithRanges(p.expr, scope);
          this.formatResult(res, v, p.unit, scope);
          break;
        }
        case 'define': {
          const t = p.target;
          if (t.params) {
            const dup = t.params.find((x, i) => t.params!.indexOf(x) !== i);
            if (dup) throw new CalcError(`Parameter „${dup}“ doppelt`);
            const fn: FnVal = { kind: 'fn', name: t.name, params: t.params, body: p.expr };
            if (usesFind(p)) { fn.constraints = this.ev.constraints.slice(); fn.guesses = this.ev.guesses.slice(); }
            const snap = scope.snapshot();
            fn.scope = snap;
            snap.set(t.name, fn);
            scope.set(t.name, fn);
            this.checkFunction(fn);
            if (p.show) res.resultLatex = '\\text{Funktion}';
          } else if (t.multi) {
            const targets = t.multi;
            const rangeNames = [...new Set([...targets.flatMap(x => freeRangeVars(x, scope)), ...freeRangeVars(p.expr, scope)])];
            const combos = rangeNames.length ? cartesian(rangeNames, scope) : [new Map<string, Val>()];
            let last: Val | undefined;
            for (const c of combos) {
              const local = new Scope(scope);
              for (const [k, v] of c) local.set(k, v);
              const v = this.ev.eval(p.expr, local);
              // Mathcad distributes matrix elements column by column
              const els = isMatrix(v) ? (math.transpose(v as Matrix).toArray() as unknown as Val[][]).flat() as Val[] : [v];
              if (els.length !== targets.length) throw new CalcError(`Mehrfachzuweisung: ${targets.length} Ziele, aber ${els.length} Werte`);
              targets.forEach((tn, i) => {
                if (tn.k === 'id') scope.set(tn.name, els[i]);
                else if (tn.k === 'index' && tn.a.k === 'id') {
                  const name = tn.a.name;
                  let cur = scope.get(name);
                  if (cur !== undefined && (isFn(cur) || isRange(cur))) cur = undefined;
                  scope.set(name, this.ev.indexSet(cur, tn.idx.map(ix => this.ev.eval(ix, local)), els[i], false));
                }
              });
              last = v;
            }
            res.defines = targets.map(x => (x.k === 'id' ? x.name : x.k === 'index' && x.a.k === 'id' ? x.a.name : '')).join(', ');
            if (p.show && last !== undefined) this.formatResult(res, last, p.show.unit, scope);
          } else if (t.index) {
            const rangeNames = [...new Set([...t.index.flatMap(i => freeRangeVars(i, scope)), ...freeRangeVars(p.expr, scope)])];
            const combos = rangeNames.length ? cartesian(rangeNames, scope) : [new Map<string, Val>()];
            let cur = scope.get(t.name);
            if (cur !== undefined && (isFn(cur) || isRange(cur))) cur = undefined;
            let first = true;
            const shown: Val[] = [];
            const local = new Scope(scope);
            for (const c of combos) {
              local.vars.clear();
              for (const [k, v] of c) local.set(k, v);
              // Mathcad assigns element by element: later elements see the earlier ones (x[i] := x[i-1]*2)
              if (cur !== undefined && !c.has(t.name)) local.set(t.name, cur);
              const value = this.ev.eval(p.expr, local);
              const idx = t.index.map(i => this.ev.eval(i, local));
              cur = this.ev.indexSet(cur, idx, value, !first);
              shown.push(value);
              first = false;
            }
            if (cur !== undefined) scope.set(t.name, cur);
            // Mathcad shows the right-hand side values (one per range value, a matrix for two ranges)
            if (p.show && shown.length) {
              let disp: Val;
              if (shown.length === 1) disp = shown[0];
              else if (rangeNames.length === 2) {
                const nj = rangeValues(scope.get(rangeNames[1]) as RangeVal).length;
                const rows: Val[][] = [];
                for (let k = 0; k < shown.length; k += nj) rows.push(shown.slice(k, k + nj));
                disp = makeMatrix(rows);
              } else disp = makeMatrix(shown.map(x => [x]));
              this.formatResult(res, disp, p.show.unit, scope);
            }
          } else {
            let v: Val;
            if (p.expr.k === 'range') v = this.ev.eval(p.expr, scope);
            else v = this.evalWithRanges(p.expr, scope);
            scope.set(t.name, v);
            if (p.show) this.formatResult(res, v, p.show.unit, scope);
          }
          break;
        }
      }
    } catch (e) {
      const err = translateError(e) as CalcError;
      res.error = { message: err.message, culprit: (err as CalcError).culprit, kind: 'calc' };
    }
    res.latex = stmtLatex(p, this.latexCtx(scope, res.error?.culprit));
    const exp = r.imported?.expected;
    if (usesIterative(p, this.iterativeVars) && p.kind === 'define') for (const n of definedNames(p)) this.iterativeVars.add(n);
    const random = usesRandom(p) || refsAny(p, this.randomVars);
    if (random && p.kind === 'define') for (const n of definedNames(p)) this.randomVars.add(n);
    const shows = (p.kind === 'eval' || (p.kind === 'define' && !!p.show)) && !random;
    if (exp && shows) {
      const val = this.lastValue;
      const ignoreDims = (p.kind === 'eval' && !!p.unit) || (p.kind === 'define' && !!p.show?.unit);
      res.check = { status: res.error || val === undefined ? 'mismatch' : checkResult(val, exp, ignoreDims, usesIterative(p, this.iterativeVars)), expected: expectedToText(exp, this.fmt.decimals + 1) };
    }
    if (r.imported?.symbolic) {
      try { res.symbolicLatex = toLatex(parseExpression(r.imported.symbolic), this.latexCtx(scope)); } catch { /* ignore */ }
    }
    this.lastValue = undefined;
    if (!this.opts.keepValues) delete res.value;
    else if (p.kind === 'define' && !res.error && !p.target.params && res.value === undefined) res.value = scope.get(p.target.name);
    return res;
  }

  /** Light static check: report undefined names inside a function body early (like Mathcad's red marking). */
  checkFunction(fn: FnVal) {
    const bound = new Set(fn.params);
    const missing: string[] = [];
    const visit = (n: Node, b: Set<string>) => walk(n, (x) => {
      if (x.k === 'program') return false;
      if (x.k === 'iter' && x.v) { const nb = new Set(b); nb.add(x.v); visit(x.body, nb); if (x.lo) visit(x.lo, b); if (x.hi) visit(x.hi, b); return false; }
      if (x.k === 'int' || x.k === 'deriv') { const nb = new Set(b); nb.add(x.v); visit(x.body, nb); if (x.k === 'int') { visit(x.lo, b); visit(x.hi, b); } return false; }
      if (x.k === 'call' && ['root', 'Find', 'Minerr', 'find'].includes(x.name)) return false;
      if (x.k === 'id' && !b.has(x.name) && fn.scope!.get(x.name) === undefined && !(x.name in CONSTANTS) && x.name !== 'ORIGIN' && lookupUnit(x.name) === null && !isBuiltinFunction(x.name)) missing.push(x.name);
      if (x.k === 'call' && !b.has(x.name) && fn.scope!.get(x.name) === undefined && !isBuiltinFunction(x.name) && lookupUnit(x.name) === null) missing.push(x.name);
    });
    visit(fn.body!, bound);
    if (missing.length) throw new CalcError(`„${missing[0]}“ ist nicht definiert`, missing[0]);
  }

  /** Evaluate an expression, iterating implicitly over range variables. */
  evalWithRanges(expr: Node, scope: Scope): Val {
    const names = freeRangeVars(expr, scope);
    if (!names.length) return this.ev.eval(expr, scope);
    const combos = cartesian(names, scope);
    const vals: Val[] = [];
    for (const c of combos) {
      const local = new Scope(scope);
      for (const [k, v] of c) local.set(k, v);
      const v = this.ev.eval(expr, local);
      if (isMatrix(v)) throw new CalcError('Bereichsvariable liefert Matrizen – Ergebnis nicht darstellbar');
      vals.push(v);
    }
    return makeMatrix(vals.map(v => [v]));
  }

  lastValue: Val | undefined;
  lastConverted: Val | undefined;
  /** Variables depending on random numbers (excluded from verification). */
  randomVars = new Set<string>();
  /** Variables computed by iterative numerical methods (compared with Mathcad's TOL). */
  iterativeVars = new Set<string>();

  formatResult(res: RegionResult, v: Val, unitNode: Node | undefined, scope: Scope) {
    this.lastValue = v;
    if (this.opts.keepValues) res.value = v;
    if (unitNode && unitNode.k !== 'placeholder') {
      const shown = this.convertToUnit(v, unitNode, scope);
      this.lastValue = this.lastConverted;
      const ulatex = toLatex(unitNode, { ...this.latexCtx(scope), isUnit: () => true });
      res.unitLatex = ulatex;
      res.resultLatex = `${shown.latex}\\ ${ulatex}`;
      res.resultText = `${shown.text}`;
      return;
    }
    const f = formatValue(v, this.fmt);
    res.resultLatex = f.latex;
    res.resultText = f.text;
  }

  convertToUnit(v: Val, unitNode: Node, scope: Scope): { latex: string; text: string } {
    // offset temperature units need special treatment
    if (unitNode.k === 'id' && scope.get(unitNode.name) === undefined) {
      const u = lookupUnit(unitNode.name);
      if (u && typeof u !== 'number' && (u as Unit).units[0]?.unit?.offset) {
        const conv = (x: Val) => {
          if (!isUnit(x)) throw new CalcError('Wert hat keine Temperatureinheit');
          return (x as Unit).toNumber((u as Unit).formatUnits());
        };
        const out = isMatrix(v) ? math.map(v as Matrix, (x: unknown) => conv(x as Val)) as Matrix : conv(v);
        this.lastConverted = out;
        return formatValue(out, this.fmt);
      }
    }
    const uv = this.ev.eval(unitNode, scope);
    if (isFn(uv) || isRange(uv) || typeof uv === 'string' || isMatrix(uv)) throw new CalcError('Ungültige Anzeigeeinheit');
    // 0 is compatible with every unit
    if (v === 0) { this.lastConverted = 0; return formatValue(0, this.fmt); }
    const ratio = isMatrix(v) ? math.map(v as Matrix, (x: unknown) => this.ev.divide(x as Val, uv, false) as never) as Matrix : this.ev.divide(v, uv, false);
    this.lastConverted = ratio;
    return formatValue(ratio, this.fmt);
  }

  /* ------------------------------ plots -------------------------------- */

  runPlot(r: PlotRegion): PlotData {
    const out: PlotData = { traces: [], xLabel: '', yLabel: '', xLim: [null, null], yLim: [null, null] };
    const scope = this.top;
    const errors: string[] = [];
    let xUnitVal: Val | undefined, yUnitVal: Val | undefined;
    try {
      if (r.xUnit?.trim()) xUnitVal = this.ev.eval(parseExpression(r.xUnit), scope);
      if (r.yUnit?.trim()) yUnitVal = this.ev.eval(parseExpression(r.yUnit), scope);
    } catch (e) { errors.push('Achseneinheit: ' + (e as Error).message); }
    /** Axis limit in display units (divided by the axis unit if one is set). */
    const limit = (s: string | undefined, unit: Val | undefined) => {
      if (!s || !s.trim()) return undefined;
      let v = this.ev.eval(parseExpression(s), scope);
      // a plain number is already in display units; a quantity is converted into them
      if (unit !== undefined && isUnit(v)) v = this.ev.divide(v, unit, false);
      return isUnit(v) ? (v as Unit).value as number : toNumber(v);
    };
    let xmin: number | undefined, xmax: number | undefined;
    try { xmin = limit(r.xmin, xUnitVal); xmax = limit(r.xmax, xUnitVal); } catch (e) { errors.push('x-Grenzen: ' + (e as Error).message); }
    try { out.yLim = [limit(r.ymin, yUnitVal) ?? null, limit(r.ymax, yUnitVal) ?? null]; } catch (e) { errors.push('y-Grenzen: ' + (e as Error).message); }
    out.xLim = [xmin ?? null, xmax ?? null];
    const xLabels: string[] = [], yLabels: string[] = [];
    const scalar = (v: Val, unit: Val | undefined, dimsOut: { d?: number[] }): number => {
      let x = v;
      if (unit !== undefined) x = this.ev.divide(v, unit, false);
      if (isUnit(x)) { dimsOut.d = (x as Unit).dimensions; return (x as Unit).value as number; }
      if (isComplex(x)) return (x as { re: number }).re;
      if (typeof x === 'number') return x;
      return toNumber(x);
    };
    for (const tr of r.traces) {
      if (!tr.y.trim()) continue;
      try {
        const xNode = parseExpression(tr.x || 'x');
        const yNode = parseExpression(tr.y);
        const xs: number[] = [], ys: number[] = [];
        const xd: { d?: number[] } = {}, yd: { d?: number[] } = {};
        const ranges = [...new Set([...freeRangeVars(xNode, scope), ...freeRangeVars(yNode, scope)])];
        const quickVar = xNode.k === 'id' && scope.get(xNode.name) === undefined && !(xNode.name in CONSTANTS) && lookupUnit(xNode.name) === null ? xNode.name : null;
        if (ranges.length) {
          for (const c of cartesian(ranges, scope)) {
            const local = new Scope(scope);
            for (const [k, v] of c) local.set(k, v);
            try {
              const xv = this.ev.eval(xNode, local), yv = this.ev.eval(yNode, local);
              xs.push(scalar(xv, xUnitVal, xd)); ys.push(scalar(yv, yUnitVal, yd));
            } catch (e) { xs.push(NaN); ys.push(NaN); if (xs.length === 1) throw e; }
          }
        } else if (quickVar) {
          // QuickPlot: sample the free variable over the axis limits
          const a = xmin ?? -10, b = xmax ?? 10;
          const N = 400;
          const local = new Scope(scope);
          let firstErr: unknown;
          for (let i = 0; i <= N; i++) {
            const t = a + (b - a) * i / N;
            // t is in display units: x = t · (axis unit)
            local.set(quickVar, xUnitVal !== undefined ? this.ev.multiply(t, xUnitVal, false) : t);
            try {
              const yv = this.ev.eval(yNode, local);
              xs.push(t); ys.push(scalar(yv, yUnitVal, yd));
            } catch (e) { firstErr = firstErr ?? e; xs.push(t); ys.push(NaN); }
          }
          if (ys.every(y => Number.isNaN(y)) && firstErr) throw firstErr;
        } else {
          const xv = this.ev.eval(xNode, scope);
          let yv: Val;
          try { yv = this.ev.eval(yNode, scope); } catch (e) {
            if (!isMatrix(xv)) throw e;
            yv = this.ev.eval(yNode, scope, true);
          }
          const xa = isMatrix(xv) ? ((xv as Matrix).toArray().flat() as Val[]) : [xv];
          let ya = isMatrix(yv) ? ((yv as Matrix).toArray().flat() as Val[]) : [yv];
          if (!isMatrix(yv) && isMatrix(xv) && xNode.k === 'id') {
            // y depends on x: evaluate per element
            ya = xa.map(x => { const l = new Scope(scope); l.set(xNode.name, x); return this.ev.eval(yNode, l); });
          }
          if (xa.length !== ya.length) throw new CalcError(`x und y haben unterschiedliche Länge (${xa.length} / ${ya.length})`);
          xa.forEach((x, i) => { xs.push(scalar(x, xUnitVal, xd)); ys.push(scalar(ya[i], yUnitVal, yd)); });
        }
        out.traces.push({ x: xs, y: ys, label: tr.label || tr.y, color: tr.color, style: tr.style });
        xLabels.push((tr.x || 'x') + (xd.d && !r.xUnit ? ` [${unitFactorsText(siUnitFactors(xd.d))}]` : ''));
        yLabels.push(tr.y + (yd.d && !r.yUnit ? ` [${unitFactorsText(siUnitFactors(yd.d))}]` : ''));
      } catch (e) {
        errors.push(`${tr.y}: ${(translateError(e) as Error).message}`);
      }
    }
    out.xLabel = [...new Set(xLabels)].join(', ') + (r.xUnit ? ` [${r.xUnit}]` : '');
    out.yLabel = [...new Set(yLabels)].join(', ') + (r.yUnit ? ` [${r.yUnit}]` : '');
    if (errors.length) out.error = errors.join('\n');
    return out;
  }
}

function isConstraint(n: Node): boolean {
  const x = n.k === 'paren' ? n.a : n;
  return x.k === 'bin' && ['==', '<', '>', '<=', '>='].includes(x.op);
}
const RANDOM = /^(rnd|Seed|r(norm|unif|binom|beta|chisq|t|F|exp|gamma|lnorm|logis|pois|geom|nbinom|weibull|cauchy))$/;
function usesRandom(p: MathStmt): boolean {
  let found = false;
  const e = p.kind === 'define' || p.kind === 'eval' || p.kind === 'expr' ? p.expr : null;
  if (e) walk(e, (x) => { if ((x.k === 'call' && RANDOM.test(x.name)) || (x.k === 'id' && RANDOM.test(x.name))) found = true; });
  return found;
}

function usesIterative(p: MathStmt, vars: Set<string>): boolean {
  let found = false;
  const e = p.kind === 'define' || p.kind === 'eval' || p.kind === 'expr' ? p.expr : null;
  if (e) walk(e, (x) => { if (x.k === 'int' || x.k === 'deriv' || (x.k === 'call' && ['root', 'Find', 'find', 'Minerr', 'polyroots'].includes(x.name))) found = true; });
  return found || refsAny(p, vars);
}

function refsAny(p: MathStmt, names: Set<string>): boolean {
  if (!names.size) return false;
  let found = false;
  const e = p.kind === 'define' || p.kind === 'eval' || p.kind === 'expr' ? p.expr : null;
  if (e) walk(e, (x) => { if ((x.k === 'id' && names.has(x.name)) || (x.k === 'call' && names.has(x.name))) found = true; });
  return found;
}
function definedNames(p: MathStmt): string[] {
  if (p.kind !== 'define') return [];
  if (p.target.multi) return p.target.multi.map(x => (x.k === 'id' ? x.name : x.k === 'index' && x.a.k === 'id' ? x.a.name : '')).filter(Boolean);
  return [p.target.name];
}

function usesFind(p: MathStmt): boolean {
  let found = false;
  const e = p.kind === 'define' || p.kind === 'eval' || p.kind === 'expr' ? p.expr : null;
  if (e) walk(e, (x) => { if (x.k === 'call' && ['Find', 'find', 'Minerr'].includes(x.name)) found = true; });
  return found;
}

export interface EngineSnapshot {
  vars: Map<string, Val>;
  constraints: { node: Node }[];
  guesses: { name: string; expr: Node }[];
  inSolve: boolean;
  pendingGuesses: { name: string; expr: Node }[];
  randomVars: Set<string>;
  iterativeVars: Set<string>;
  definedBy: Map<string, string>;
  rng: [number, number];
}

export interface Progress { done: number; total: number; resumedAt: number }

/** Everything a region's result depends on besides the state before it. */
function signature(r: Region): string {
  const { x: _x, y: _y, oy: _oy, w, h, ...rest } = r as Region & { oy?: number };
  void _x; void _y; void _oy;
  return JSON.stringify(r.type === 'plot' ? { ...rest, w, h } : rest);
}

/**
 * Incremental, interruptible recalculation.
 *
 * The session remembers the result of every region and a snapshot of the state before it. When the
 * worksheet changes, evaluation resumes at the first region whose content or order changed – like
 * Mathcad, only what follows a change is recalculated. `run` is a generator that yields after every
 * region, so a caller (the Web Worker) can interrupt it for a newer request without losing the
 * work already done.
 */
export class ComputeSession {
  private engine: WorksheetEngine | null = null;
  private keys = '';
  private sigs: string[] = [];
  private ids: string[] = [];
  private results: (RegionResult | undefined)[] = [];
  private snaps: (EngineSnapshot | undefined)[] = [];
  private globalResults: Record<string, RegionResult> = {};
  private parseCache = new Map<string, MathStmt | ParseError>();

  constructor(public opts: ComputeOptions = {}) {}

  private parse = (r: MathRegion): MathStmt | ParseError => {
    let p = this.parseCache.get(r.src);
    if (!p) {
      try { p = parseMathRegion(r.src); } catch (e) {
        p = e instanceof ParseError ? e : new ParseError(String((e as Error).message ?? e), 0);
      }
      if (this.parseCache.size > 20000) this.parseCache.clear();
      this.parseCache.set(r.src, p);
    }
    return p;
  };

  *run(ws: Worksheet): Generator<Progress, ComputeResult> {
    const t0 = Date.now();
    const order = sortRegions(ws.regions);
    const sigs = order.map(signature);
    const ids = order.map(r => r.id);
    const globals = order.filter(r => r.type === 'math' && !r.disabled && r.src.includes('≡')).map(signature).join('\n');
    const keys = JSON.stringify(ws.settings) + '\u0000' + globals;

    // first region that differs from the previous run
    let k = 0;
    if (this.engine && keys === this.keys) {
      const n = Math.min(this.sigs.length, sigs.length);
      while (k < n && this.sigs[k] === sigs[k] && this.ids[k] === ids[k]) k++;
    }
    let start = k;
    while (start > 0 && !this.snaps[start]) start--;
    if (!this.engine || keys !== this.keys || !this.snaps[start]) {
      // full recalculation
      this.engine = new WorksheetEngine(ws, this.opts);
      this.keys = keys;
      this.globalResults = {};
      this.engine.runGlobals(order, this.parse, this.globalResults);
      start = 0;
      this.snaps = [this.engine.snapshot()];
    } else {
      this.engine.ws = ws;
      this.engine.restore(this.snaps[start]!);
    }
    // keep the valid prefix only
    this.sigs.length = start; this.ids.length = start; this.results.length = start; this.snaps.length = start + 1;

    const eng = this.engine;
    const stride = order.length <= 400 ? 1 : Math.ceil(order.length / 400);
    for (let i = start; i < order.length; i++) {
      if (i > start && i % stride === 0) this.snaps[i] = eng.snapshot();
      this.results[i] = eng.step(order[i], this.parse, this.globalResults);
      this.sigs[i] = sigs[i];
      this.ids[i] = ids[i];
      yield { done: i + 1, total: order.length, resumedAt: start };
    }
    const results: Record<string, RegionResult> = {};
    for (let i = 0; i < order.length; i++) if (this.results[i]) results[order[i].id] = this.results[i]!;
    for (const [id, r] of Object.entries(this.globalResults)) results[id] = r;
    return eng.finish(results, t0);
  }

  runToEnd(ws: Worksheet): ComputeResult {
    const it = this.run(ws);
    for (;;) {
      const s = it.next();
      if (s.done) return s.value;
    }
  }
}

export function computeWorksheet(ws: Worksheet, opts: ComputeOptions = {}): ComputeResult {
  return new ComputeSession(opts).runToEnd(ws);
}

export { formatReal };
