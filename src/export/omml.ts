/**
 * LaTeX (the subset FormelWerk itself generates) → Office Math Markup (OMML), so that formulas become
 * real, editable Word equations. Unknown commands degrade to their plain text.
 */

/* --------------------------------- tokens ---------------------------------- */

type Tok = { t: 'cmd'; v: string } | { t: 'ch'; v: string } | { t: 'open' } | { t: 'close' } | { t: 'sup' } | { t: 'sub' } | { t: 'amp' } | { t: 'nl' };

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === '\\') { out.push({ t: 'nl' }); i++; continue; }
      const m = /^[A-Za-z]+/.exec(s.slice(i + 1));
      if (m) { out.push({ t: 'cmd', v: m[0] }); i += m[0].length; continue; }
      out.push({ t: 'cmd', v: n ?? '' }); i++; continue;
    }
    if (c === '{') out.push({ t: 'open' });
    else if (c === '}') out.push({ t: 'close' });
    else if (c === '^') out.push({ t: 'sup' });
    else if (c === '_') out.push({ t: 'sub' });
    else if (c === '&') out.push({ t: 'amp' });
    else if (c === ' ' || c === '\n' || c === '\t') continue;
    else out.push({ t: 'ch', v: c });
  }
  return out;
}

/* ---------------------------------- tree ----------------------------------- */

export type MNode =
  | { k: 'run'; text: string; sty?: 'p' | 'b' | 'i' | 'bi' }
  | { k: 'row'; items: MNode[] }
  | { k: 'frac'; num: MNode; den: MNode }
  | { k: 'rad'; deg?: MNode; e: MNode }
  | { k: 'script'; base: MNode; sup?: MNode; sub?: MNode }
  | { k: 'delim'; open: string; close: string; e: MNode }
  | { k: 'matrix'; rows: MNode[][] }
  | { k: 'nary'; chr: string; sub?: MNode; sup?: MNode; e: MNode }
  | { k: 'limLow'; e: MNode; lim: MNode }
  | { k: 'limUpp'; e: MNode; lim: MNode }
  | { k: 'acc'; chr: string; e: MNode };

const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', varsigma: 'ς', tau: 'τ',
  upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  cdot: '·', times: '×', le: '≤', ge: '≥', leq: '≤', geq: '≥', neq: '≠', ne: '≠', to: '→', rightarrow: '→', leftarrow: '←',
  coloneqq: '≔', equiv: '≡', infty: '∞', in: '∈', wedge: '∧', vee: '∨', neg: '¬', oplus: '⊕', circ: '°', cdots: '⋯', vdots: '⋮',
  langle: '⟨', rangle: '⟩', blacksquare: '■', hbar: 'ℏ', textbackslash: '\\', textasciitilde: '~', textasciicircum: '^',
  approx: '≈', pm: '±', partial: '∂', nabla: '∇', ldots: '…', dots: '…', '{': '{', '}': '}', '%': '%', '$': '$', '#': '#', '&': '&', '_': '_',
  lbrace: '{', rbrace: '}', vert: '|', '|': '‖',
};
const SPACES: Record<string, string> = { ',': ' ', ';': ' ', ':': ' ', ' ': ' ', quad: ' ', qquad: '  ', '!': '' };
const STYLE_CMDS: Record<string, 'p' | 'b' | 'i' | 'bi'> = { mathrm: 'p', text: 'p', textsf: 'p', mathsf: 'p', operatorname: 'p', mathbf: 'b', textbf: 'b', mathit: 'i', textit: 'i', textrm: 'p' };
const NARY: Record<string, string> = { sum: '∑', prod: '∏', int: '∫', iint: '∬', oint: '∮' };
const DELIM: Record<string, string> = { '(': '(', ')': ')', '[': '[', ']': ']', '|': '|', '.': '', '\\{': '{', '\\}': '}', '\\langle': '⟨', '\\rangle': '⟩', '\\|': '‖', '\\vert': '|' };

class Parser {
  i = 0;
  constructor(private toks: Tok[]) {}
  peek() { return this.toks[this.i]; }
  next() { return this.toks[this.i++]; }

  /** Sequence until '}' / \right / \end / & / \\ (not consumed). */
  seq(stopAtCell = false): MNode {
    const items: MNode[] = [];
    for (;;) {
      const t = this.peek();
      if (!t || t.t === 'close') break;
      if (t.t === 'cmd' && (t.v === 'right' || t.v === 'end')) break;
      if (stopAtCell && (t.t === 'amp' || t.t === 'nl')) break;
      if (!stopAtCell && (t.t === 'amp' || t.t === 'nl')) { this.next(); items.push({ k: 'run', text: ' ' }); continue; }
      // n-ary operators take the rest of the sequence as their argument
      if (t.t === 'cmd' && NARY[t.v]) {
        this.next();
        const { sub, sup } = this.scripts();
        const e = this.seq(stopAtCell);
        items.push({ k: 'nary', chr: NARY[t.v], sub, sup, e });
        break;
      }
      let atom = this.atom();
      if (!atom) continue;
      const { sub, sup } = this.scripts();
      if (sub || sup) {
        if (atom.k === 'run' && atom.text === 'lim' && sub && !sup) atom = { k: 'limLow', e: atom, lim: sub };
        else atom = { k: 'script', base: atom, sub, sup };
      }
      items.push(atom);
    }
    return items.length === 1 ? items[0] : { k: 'row', items };
  }

  scripts(): { sub?: MNode; sup?: MNode } {
    let sub: MNode | undefined, sup: MNode | undefined;
    for (;;) {
      const t = this.peek();
      if (t?.t === 'sub' && !sub) { this.next(); sub = this.arg(); }
      else if (t?.t === 'sup' && !sup) { this.next(); sup = this.arg(); }
      else break;
    }
    return { sub, sup };
  }

  /** One argument: a group or a single token. */
  arg(): MNode {
    const t = this.peek();
    if (t?.t === 'open') { this.next(); const s = this.seq(); if (this.peek()?.t === 'close') this.next(); return s; }
    return this.atom() ?? { k: 'row', items: [] };
  }

  /** Raw text of a group (for \text, \mathrm …): nested groups flattened, simple commands mapped. */
  textArg(): string {
    const t = this.peek();
    if (t?.t !== 'open') { const a = this.next(); return a?.t === 'ch' ? a.v : a?.t === 'cmd' ? (SYMBOLS[a.v] ?? SPACES[a.v] ?? '') : ''; }
    this.next();
    let depth = 1, out = '';
    while (this.i < this.toks.length) {
      const x = this.next();
      if (x.t === 'open') { depth++; continue; }
      if (x.t === 'close') { if (--depth === 0) break; continue; }
      if (x.t === 'ch') out += x.v;
      else if (x.t === 'cmd') out += SYMBOLS[x.v] ?? SPACES[x.v] ?? '';
      else if (x.t === 'sup') out += '^';
      else if (x.t === 'sub') out += '_';
    }
    return out;
  }

  delimTok(): string {
    const t = this.next();
    if (!t) return '';
    if (t.t === 'ch') return DELIM[t.v] ?? t.v;
    if (t.t === 'cmd') return DELIM['\\' + t.v] ?? SYMBOLS[t.v] ?? '';
    return '';
  }

  atom(): MNode | null {
    const t = this.next();
    if (!t) return null;
    switch (t.t) {
      case 'ch': {
        // numbers as one run (6.5 rather than 6 · . · 5)
        let text = t.v;
        if (/[0-9.]/.test(text)) while (this.peek()?.t === 'ch' && /[0-9.]/.test((this.peek() as { v: string }).v)) text += (this.next() as { v: string }).v;
        return { k: 'run', text };
      }
      case 'open': { const s = this.seq(); if (this.peek()?.t === 'close') this.next(); return s; }
      case 'close': return null;
      case 'sup': case 'sub': return null;
      case 'amp': case 'nl': return { k: 'run', text: ' ' };
      case 'cmd': break;
    }
    const v = t.v;
    // Greek letters are variables (italic by default); operators and signs upright
    if (SYMBOLS[v] !== undefined) return { k: 'run', text: SYMBOLS[v], sty: /[α-ωΑ-Ωϵϑςϕ]/.test(SYMBOLS[v]) ? undefined : 'p' };
    if (SPACES[v] !== undefined) return SPACES[v] ? { k: 'run', text: SPACES[v], sty: 'p' } : null;
    if (STYLE_CMDS[v]) {
      const sty = STYLE_CMDS[v];
      // \mathrm{…} may contain structure (rare); plain text is the common case
      return { k: 'run', text: this.textArg(), sty };
    }
    switch (v) {
      case 'frac': case 'tfrac': case 'dfrac': return { k: 'frac', num: this.arg(), den: this.arg() };
      case 'sqrt': {
        let deg: MNode | undefined;
        if (this.peek()?.t === 'ch' && (this.peek() as { v: string }).v === '[') {
          this.next();
          const items: MNode[] = [];
          while (this.peek() && !(this.peek()!.t === 'ch' && (this.peek() as { v: string }).v === ']')) { const a = this.atom(); if (a) items.push(a); }
          this.next();
          deg = { k: 'row', items };
        }
        return { k: 'rad', deg, e: this.arg() };
      }
      case 'left': {
        const open = this.delimTok();
        const e = this.seq();
        let close = '';
        if (this.peek()?.t === 'cmd' && (this.peek() as { v: string }).v === 'right') { this.next(); close = this.delimTok(); }
        return { k: 'delim', open, close, e };
      }
      case 'right': return null;
      case 'begin': {
        const env = this.textArg();
        if (env === 'array') this.textArg();   // column spec
        const rows: MNode[][] = [[]];
        for (;;) {
          const p = this.peek();
          if (!p) break;
          if (p.t === 'cmd' && p.v === 'end') { this.next(); this.textArg(); break; }
          if (p.t === 'amp') { this.next(); continue; }
          if (p.t === 'nl') { this.next(); rows.push([]); continue; }
          rows[rows.length - 1].push(this.seq(true));
        }
        const m: MNode = { k: 'matrix', rows: rows.filter(r => r.length) };
        if (env === 'bmatrix') return { k: 'delim', open: '[', close: ']', e: m };
        if (env === 'pmatrix') return { k: 'delim', open: '(', close: ')', e: m };
        if (env === 'vmatrix') return { k: 'delim', open: '|', close: '|', e: m };
        return m;
      }
      case 'htmlClass': case 'class': this.textArg(); return this.arg();
      case 'xrightarrow': return { k: 'limUpp', e: { k: 'run', text: '⟶', sty: 'p' }, lim: this.arg() };
      case 'overrightarrow': case 'vec': return { k: 'acc', chr: '⃗', e: this.arg() };
      case 'hat': return { k: 'acc', chr: '̂', e: this.arg() };
      case 'bar': case 'overline': return { k: 'acc', chr: '̅', e: this.arg() };
      case 'lim': return { k: 'run', text: 'lim', sty: 'p' };
      case 'color': case 'textcolor': this.textArg(); return v === 'textcolor' ? this.arg() : null;
      case 'displaystyle': case 'limits': case 'nolimits': return null;
      default:
        if (NARY[v]) return { k: 'run', text: NARY[v], sty: 'p' };
        return { k: 'run', text: v, sty: 'p' };
    }
  }
}

export function parseLatex(latex: string): MNode {
  const p = new Parser(tokenize(latex));
  const items: MNode[] = [];
  while (p.i < (p as unknown as { toks: Tok[] }).toks.length) {
    items.push(p.seq());
    if (p.peek()) p.next();   // stray '}' or \right
  }
  return items.length === 1 ? items[0] : { k: 'row', items };
}

/* --------------------------------- OMML ------------------------------------ */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function run(text: string, sty?: string): string {
  if (!text) return '';
  // m:nor ("normal text") makes LibreOffice honour upright/bold as well; Word uses m:sty
  const rpr = sty ? `<m:rPr>${sty === 'p' || sty === 'b' ? '<m:nor/>' : ''}<m:sty m:val="${sty}"/></m:rPr>` : '';
  return `<m:r>${rpr}<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr><m:t xml:space="preserve">${esc(text)}</m:t></m:r>`;
}

const e = (n: MNode | undefined) => `<m:e>${n ? omml(n) : ''}</m:e>`;

export function omml(n: MNode): string {
  switch (n.k) {
    case 'run': {
      // digits, operators and punctuation are upright anyway; letters italic unless styled
      return run(n.text, n.sty);
    }
    case 'row': return n.items.map(omml).join('');
    case 'frac': return `<m:f><m:num>${omml(n.num)}</m:num><m:den>${omml(n.den)}</m:den></m:f>`;
    case 'rad': return n.deg
      ? `<m:rad><m:deg>${omml(n.deg)}</m:deg>${e(n.e)}</m:rad>`
      : `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/>${e(n.e)}</m:rad>`;
    case 'script':
      if (n.sub && n.sup) return `<m:sSubSup>${e(n.base)}<m:sub>${omml(n.sub)}</m:sub><m:sup>${omml(n.sup)}</m:sup></m:sSubSup>`;
      if (n.sup) return `<m:sSup>${e(n.base)}<m:sup>${omml(n.sup)}</m:sup></m:sSup>`;
      return `<m:sSub>${e(n.base)}<m:sub>${omml(n.sub!)}</m:sub></m:sSub>`;
    case 'delim':
      return `<m:d><m:dPr><m:begChr m:val="${esc(n.open)}"/><m:endChr m:val="${esc(n.close)}"/></m:dPr>${e(n.e)}</m:d>`;
    case 'matrix': {
      const cols = Math.max(1, ...n.rows.map(r => r.length));
      return `<m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val="${cols}"/><m:mcJc m:val="center"/></m:mcPr></m:mc></m:mcs></m:mPr>${n.rows.map(r => `<m:mr>${Array.from({ length: cols }, (_, j) => e(r[j])).join('')}</m:mr>`).join('')}</m:m>`;
    }
    case 'nary': {
      const pr = `<m:naryPr><m:chr m:val="${n.chr}"/><m:limLoc m:val="${n.chr === '∫' ? 'subSup' : 'undOvr'}"/>${n.sub ? '' : '<m:subHide m:val="1"/>'}${n.sup ? '' : '<m:supHide m:val="1"/>'}</m:naryPr>`;
      return `<m:nary>${pr}<m:sub>${n.sub ? omml(n.sub) : ''}</m:sub><m:sup>${n.sup ? omml(n.sup) : ''}</m:sup>${e(n.e)}</m:nary>`;
    }
    case 'limLow': return `<m:limLow>${e(n.e)}<m:lim>${omml(n.lim)}</m:lim></m:limLow>`;
    case 'limUpp': return `<m:limUpp>${e(n.e)}<m:lim>${omml(n.lim)}</m:lim></m:limUpp>`;
    case 'acc': return `<m:acc><m:accPr><m:chr m:val="${n.chr}"/></m:accPr>${e(n.e)}</m:acc>`;
  }
}

/** LaTeX → <m:oMath> element. */
export function latexToOmml(latex: string): string {
  return `<m:oMath>${omml(parseLatex(latex))}</m:oMath>`;
}
