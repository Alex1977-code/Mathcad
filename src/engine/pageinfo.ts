/**
 * Page header and footer (print, PDF, Word): three parts each (left, centre, right) with placeholders
 *   {titel} {datei} {projekt} {bearbeiter} {datum} {seite} {seiten}
 */
import type { PageInfo, Worksheet } from './model';

export const DEFAULT_PAGE_INFO: Required<Pick<PageInfo, 'header' | 'footer'>> = {
  header: ['', '', ''],
  footer: ['{titel} · {datum}', '', 'Seite {seite} von {seiten}'],
};

export const PLACEHOLDERS: [string, string][] = [
  ['{titel}', 'Titel des Arbeitsblatts'], ['{datei}', 'Dateiname'], ['{projekt}', 'Projekt'], ['{bearbeiter}', 'Bearbeiter'],
  ['{datum}', 'heutiges Datum'], ['{seite}', 'Seitenzahl'], ['{seiten}', 'Anzahl der Seiten'],
];

export interface PageVars { title: string; file: string; project: string; author: string; date: string }

export function pageVars(ws: Worksheet, fileName?: string | null, now = new Date()): PageVars {
  const p = ws.settings.page ?? {};
  return { title: ws.title || fileName || 'Arbeitsblatt', file: fileName ?? '', project: p.project ?? '', author: p.author ?? '', date: now.toLocaleDateString('de-DE') };
}

export function headerFooter(ws: Worksheet): { header: string[]; footer: string[] } {
  const p = ws.settings.page;
  return { header: p?.header ?? DEFAULT_PAGE_INFO.header, footer: p?.footer ?? DEFAULT_PAGE_INFO.footer };
}

/** Split a template into text and page-number fields (for Word, which numbers the pages itself). */
export function templateParts(tpl: string, v: PageVars): ({ text: string } | { field: 'PAGE' | 'NUMPAGES' })[] {
  const out: ({ text: string } | { field: 'PAGE' | 'NUMPAGES' })[] = [];
  const re = /\{(seite|seiten|titel|datei|projekt|bearbeiter|datum)\}/g;
  let last = 0, m: RegExpExecArray | null;
  const push = (t: string) => { if (t) { const l = out[out.length - 1]; if (l && 'text' in l) l.text += t; else out.push({ text: t }); } };
  while ((m = re.exec(tpl))) {
    push(tpl.slice(last, m.index));
    const k = m[1];
    if (k === 'seite') out.push({ field: 'PAGE' });
    else if (k === 'seiten') out.push({ field: 'NUMPAGES' });
    else push({ titel: v.title, datei: v.file, projekt: v.project, bearbeiter: v.author, datum: v.date }[k]!);
    last = m.index + m[0].length;
  }
  push(tpl.slice(last));
  return out;
}

/** A template filled for one page. */
export function fillTemplate(tpl: string, v: PageVars, page: number, pages: number): string {
  return templateParts(tpl, v).map(p => ('text' in p ? p.text : p.field === 'PAGE' ? String(page) : String(pages))).join('');
}
