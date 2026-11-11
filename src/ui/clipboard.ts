/**
 * System clipboard: copying regions puts plain text (formula sources) and HTML on the clipboard – the HTML
 * carries formulas in the form Word uses for equations (OMML in conditional comments) with a readable
 * fallback for other programs. Pasting from other programs creates formulas, text or picture regions.
 */
import { newId, sliderSrc, type MathRegion, type Region } from '../engine/model';
import { parseMathRegion } from '../engine/parser';
import { latexToOmml } from '../export/omml';
import { composeLatex } from './regions/MathRegionView';
import { resultOf } from './smart';
import { store } from './store';
import { MARGIN, snap } from './layout';

const parseMathRegionSafe = (t: string) => { try { const st = parseMathRegion(t); return st.kind !== 'empty'; } catch { return false; } };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Text of a text region (for the plain-text clipboard). */
export function htmlToText(html: string): string {
  const d = new DOMParser().parseFromString(`<div>${html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n')}</div>`, 'text/html');
  return (d.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Plain-text form of a math region including its shown result. */
function mathText(r: MathRegion): string {
  const res = resultOf(r.id);
  const shown = res && !res.error && res.src === r.src ? (res.resultText ?? '') : '';
  if (!shown || /=\s*\S/.test(r.src.split(/:=|≡/).pop() ?? '')) return r.src;
  return /[=→]\s*$/.test(r.src) ? `${r.src} ${shown}` : r.src;
}

/** A data table as tab-separated text (pastes into Excel as cells). */
function tableText(r: Region & { type: 'table' }): string {
  const head = r.columns.map((c, j) => `${c.name ?? `Spalte ${j + 1}`}${c.unit ? ` [${c.unit}]` : ''}`).join('\t');
  return [head, ...r.rows.filter(row => row.some(c => c?.trim())).map(row => r.columns.map((_, j) => row[j] ?? '').join('\t'))].join('\n');
}

export function regionsPlainText(regs: Region[]): string {
  return regs.map(r => (r.type === 'math' ? mathText(r) : r.type === 'text' ? htmlToText(r.html) : r.type === 'table' ? tableText(r) : r.type === 'slider' ? sliderSrc(r) : '')).filter(Boolean).join('\n');
}

/** HTML for the clipboard: Word equations (OMML) with a text fallback, text with formatting, pictures. */
export function regionsHtml(regs: Region[]): string {
  const parts: string[] = [];
  for (const r0 of regs) {
    const r: Region = r0.type === 'slider' ? { id: r0.id, type: 'math', x: r0.x, y: r0.y, src: sliderSrc(r0) } : r0;
    if (r.type === 'math') {
      const res = resultOf(r.id);
      const latex = composeLatex(r.src, res && res.src === r.src ? res : { id: r.id }).latex;
      // Word reads the equation from the conditional comment; other programs show the fallback
      const omml = latexToOmml(latex).replace(/<w:rPr>.*?<\/w:rPr>/g, '');
      parts.push(`<p class=MsoNormal><!--[if gte msEquation 12]><m:oMathPara>${omml}</m:oMathPara><![endif]--><![if !msEquation]><span style="font-family:'Cambria Math',serif">${esc(mathText(r))}</span><![endif]></p>`);
    } else if (r.type === 'text') parts.push(`<div>${r.html}</div>`);
    else if (r.type === 'table') {
      const head = r.columns.map((c, j) => `<th>${esc(`${c.name ?? `Spalte ${j + 1}`}${c.unit ? ` [${c.unit}]` : ''}`)}</th>`).join('');
      const body = r.rows.filter(row => row.some(c => c?.trim())).map(row => `<tr>${r.columns.map((_, j) => `<td>${esc(row[j] ?? '')}</td>`).join('')}</tr>`).join('');
      parts.push(`<p><i>${esc(r.name)} :=</i></p><table border="1" cellspacing="0" cellpadding="3"><tr>${head}</tr>${body}</table>`);
    }
    else if (r.type === 'image' && /^data:image\//.test(r.src)) parts.push(`<p><img src="${r.src}" width="${r.w ?? ''}" alt="${esc(r.alt ?? '')}"></p>`);
  }
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns:m="http://schemas.microsoft.com/office/2004/12/omml" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"></head><body>${parts.join('\n')}</body></html>`;
}

/* --------------------------------- pasting --------------------------------- */

/** Does a line of foreign text look like a formula (rather than prose)? */
export function looksLikeFormula(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 300) return false;
  // prose: three or more words in a row without operators
  if (/^[\p{L}][\p{L}'’-]*(\s+[\p{L}][\p{L}'’,.-]*){2,}[.!?:]?$/u.test(t)) return false;
  if (!/[=:+\-*/^()[\]≔≡→]|\d/.test(t)) return false;
  return parseMathRegionSafe(t.replace(/\s*:\s*=\s*/g, ' := ').replace(/≔/g, ':='));
}

/** Regions for foreign plain text: formula lines become formulas, the rest text regions. */
export function regionsFromText(text: string, at: { x: number; y: number }): Region[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: Region[] = [];
  let y = at.y;
  let prose: string[] = [];
  const flushProse = () => {
    if (!prose.length) return;
    const html = prose.map(l => esc(l)).join('<br>');
    out.push({ id: newId(), type: 'text', x: at.x, y, w: 520, html });
    y += 24 * prose.length + 12;
    prose = [];
  };
  for (const line of lines) {
    if (!line.trim()) { flushProse(); continue; }
    if (looksLikeFormula(line)) {
      flushProse();
      out.push({ id: newId(), type: 'math', x: at.x, y, src: line.trim().replace(/\s*:\s*=\s*/g, ' := ').replace(/≔/g, ':=') });
      y += 36;
    } else prose.push(line.trim());
  }
  flushProse();
  return out.map(r => ({ ...r, y: snap(r.y) }));
}

/** Picture file from the clipboard → image region. */
export function imageRegionFromFile(file: File, at: { x: number; y: number }): Promise<Region> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      const img = new Image();
      img.onload = () => resolve({ id: newId(), type: 'image', x: at.x, y: at.y, w: Math.min(img.width, 600), src, alt: file.name || 'Eingefügtes Bild' });
      img.onerror = () => reject(new Error('Bild nicht lesbar'));
      img.src = src;
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Insert foreign regions at the cursor as one undo step and select them. */
export function insertForeign(regs: Region[]) {
  if (!regs.length) return;
  store.updateWs(ws => ({ ...ws, regions: [...ws.regions, ...regs] }));
  const last = regs[regs.length - 1];
  store.set({ selection: regs.map(r => r.id), cursor: { x: regs[0].x, y: snap(last.y + 40) } });
}

export const cursorOrDefault = () => store.get().cursor ?? { x: MARGIN, y: MARGIN };
