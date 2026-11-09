/** Helpers for the formula editor. */
export const GREEK_NAMES: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω', infty: '∞', inf: '∞', deg: '°', sqrt: '√', sum: '∑', prod: '∏', int: '∫',
  le: '≤', ge: '≥', ne: '≠', in: '∈', and: '∧', or: '∨', not: '¬', larr: '←', cdot: '·', times: '×',
};

/** Mathcad's Ctrl+G mapping (Symbol font). */
const CTRL_G = 'abgdezhqiklmnxoprstufcyw';
const CTRL_G_GREEK = 'αβγδεζηθικλμνξοπρστυφχψω';
export function toGreek(ch: string): string | null {
  const lower = ch.toLowerCase();
  const i = CTRL_G.indexOf(lower);
  if (i < 0) {
    const j = CTRL_G_GREEK.indexOf(lower);
    if (j >= 0) return ch === lower ? CTRL_G[j] : CTRL_G[j].toUpperCase();
    return null;
  }
  const g = CTRL_G_GREEK[i];
  return ch === lower ? g : g.toUpperCase();
}

export interface ActiveEditor {
  insert(text: string): void;
}
let active: ActiveEditor | null = null;
export function setActiveEditor(e: ActiveEditor | null) { active = e; }
export function getActiveEditor() { return active; }

/**
 * Insert a snippet into a textarea. "?" marks placeholders: the first one is selected afterwards.
 * If text is selected, it replaces the first placeholder.
 */
export function insertSnippet(ta: HTMLTextAreaElement, snippet: string): string {
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const selected = value.slice(s, e);
  let text = snippet;
  if (selected && text.includes('?')) text = text.replace('?', selected);
  const next = value.slice(0, s) + text + value.slice(e);
  const ph = text.indexOf('?');
  const caret = ph >= 0 ? s + ph : s + text.length;
  requestAnimationFrame(() => {
    ta.focus();
    ta.setSelectionRange(caret, ph >= 0 ? caret + 1 : caret);
  });
  return next;
}

export const IDENT_RE = /[\p{L}\p{N}_°'∞\\.]+$/u;
