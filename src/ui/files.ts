import { normalizeWorksheet, type Worksheet } from '../engine/model';
// the Mathcad importers (with JSZip) are loaded only when a file is opened
const ACCEPTED_EXTENSIONS = '.fwk,.json,.xmcd,.mcdx,.mcd';
import { collectCss, withLightTheme } from './exporters';

export type FileHandle = { name: string; createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }> };
let currentHandle: FileHandle | null = null;

export function pickFile(accept = ACCEPTED_EXTENSIONS): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Open dialog; with the File System Access API the file handle comes along (Ctrl+S then writes back). */
export async function pickFileForOpen(): Promise<{ file: File; handle?: FileHandle } | null> {
  const w = window as unknown as { showOpenFilePicker?: (o: unknown) => Promise<FileHandle[]> };
  // automated browsers (tests) keep the classic file input
  if (w.showOpenFilePicker && window.isSecureContext && !navigator.webdriver) {
    try {
      const [h] = await w.showOpenFilePicker({ types: [{ description: 'FormelWerk- und Mathcad-Dateien', accept: { 'application/octet-stream': ACCEPTED_EXTENSIONS.split(',') } }] });
      return { file: await (h as unknown as { getFile(): Promise<File> }).getFile(), handle: h };
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
    }
  }
  const f = await pickFile();
  return f ? { file: f } : null;
}

/** The file Ctrl+S writes to (only FormelWerk files; imported Mathcad files are saved as new .fwk). */
export function setFileHandle(h: FileHandle | null) { currentHandle = h; }

export async function readWorksheet(file: File): Promise<Worksheet> {
  const buf = await file.arrayBuffer();
  const { loadWorksheetFile } = await import('../import');
  const ws = await loadWorksheetFile(file.name, buf);
  // a document opened this way has no file handle: Ctrl+S must ask for a file name (never overwrite another file)
  currentHandle = null;
  return ws;
}

export function serialize(ws: Worksheet): string {
  return JSON.stringify(ws, null, 1);
}

function download(name: string, data: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function safeName(title: string) {
  return (title || 'Arbeitsblatt').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Arbeitsblatt';
}

export interface SaveResult { name: string; /** true: written in another format (the document itself stays unsaved). */ exported: boolean; handle?: FileHandle }

/** Producers of the export formats offered in "Speichern unter". */
export interface ExportMakers { docx: () => Promise<Blob>; html: () => Promise<Blob>; mcdx: () => Promise<Blob> }

const SAVE_TYPES = [
  { description: 'FormelWerk-Arbeitsblatt', accept: { 'application/json': ['.fwk'] } },
  { description: 'Word-Dokument', accept: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] } },
  { description: 'Webseite (HTML)', accept: { 'text/html': ['.html'] } },
  { description: 'Mathcad Prime', accept: { 'application/octet-stream': ['.mcdx'] } },
];

type Fmt = 'fwk' | 'docx' | 'html' | 'mcdx';
const formatOf = (name: string): Fmt => (/\.docx$/i.test(name) ? 'docx' : /\.html?$/i.test(name) ? 'html' : /\.mcdx$/i.test(name) ? 'mcdx' : 'fwk');

/**
 * Save (Ctrl+S) or "Speichern unter" with a choice of file type: .fwk, .docx or .html. Uses the File System
 * Access API when available; otherwise the browser downloads the file, and "Speichern unter" asks for the name.
 */
export async function saveWorksheet(ws: Worksheet, saveAs = false, makers?: ExportMakers): Promise<SaveResult | null> {
  const fwkBlob = () => new Blob([serialize({ ...ws, source: ws.source ? { ...ws.source } : undefined })], { type: 'application/json' });
  const blobFor = async (fmt: Fmt) => (fmt === 'fwk' || !makers ? fwkBlob() : fmt === 'docx' ? makers.docx() : fmt === 'mcdx' ? makers.mcdx() : makers.html());
  const w = window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileHandle> };
  if (w.showSaveFilePicker && window.isSecureContext) {
    try {
      let handle = currentHandle;
      if (!handle || saveAs) {
        handle = await w.showSaveFilePicker({ suggestedName: safeName(ws.title) + '.fwk', types: makers && saveAs ? SAVE_TYPES : SAVE_TYPES.slice(0, 1) });
      }
      const fmt = formatOf(handle!.name);
      const blob = await blobFor(fmt);
      const wr = await handle!.createWritable();
      await wr.write(blob);
      await wr.close();
      // only the own format becomes the document's file; an export leaves it as it was
      if (fmt === 'fwk') currentHandle = handle;
      return { name: handle!.name, exported: fmt !== 'fwk', handle: handle! };
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
    }
  }
  let name = safeName(ws.title) + '.fwk';
  if (saveAs) {
    const answer = window.prompt('Dateiname (Endung .fwk, .docx, .html oder .mcdx bestimmt das Format):', name);
    if (answer === null || !answer.trim()) return null;
    name = safeName(answer.trim());
    if (!/\.(fwk|docx|html?|mcdx)$/i.test(name)) name += '.fwk';
  }
  const fmt = formatOf(name);
  download(name, await blobFor(fmt));
  return { name, exported: fmt !== 'fwk' };
}

export function resetFileHandle() { currentHandle = null; }

/** Download a finished export. */
export function downloadBlob(name: string, data: Blob) { download(name, data); }

/** The rendered worksheet as a standalone HTML page (light theme, formula fonts embedded). */
export async function htmlBlob(ws: Worksheet): Promise<Blob> {
  const page = document.querySelector('.page') as HTMLElement | null;
  if (!page) throw new Error('Kein Arbeitsblatt');
  const clone = page.cloneNode(true) as HTMLElement;
  clone.style.transform = 'none';
  clone.querySelectorAll('.grip,.check-badge,.crosshair,.welcome,.page-break-line,.page-margin,.plot-edit-btn,.error-chip,.print-footer').forEach(e => e.remove());
  clone.querySelectorAll('.region').forEach(e => e.classList.remove('selected', 'editing'));
  const css = await collectCss();
  const title = String(ws.title ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = `<!doctype html><html lang="de" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>${css}
:root{color-scheme:light}body{overflow:auto;background:#eef0f4;color:#1d2330}.page{margin:24px auto;background:#fff;background-image:none}.region{border-color:transparent!important;background:transparent!important}</style></head>
<body><div class="page" style="${(clone.getAttribute('style') ?? '').replace(/"/g, '&quot;')}">${clone.innerHTML}</div></body></html>`;
  return new Blob([html], { type: 'text/html' });
}

/** Export the rendered worksheet as a standalone HTML page. */
export async function exportHtml(ws: Worksheet) {
  download(safeName(String(ws.title ?? '')) + '.html', await withLightTheme(() => htmlBlob(ws)));
}

export const AUTOSAVE = 'formelwerk.autosave.v1';
export function autosave(ws: Worksheet) {
  try { localStorage.setItem(AUTOSAVE, JSON.stringify(ws)); } catch { /* quota or private mode */ }
}
export function loadAutosave(): Worksheet | null {
  try {
    const s = localStorage.getItem(AUTOSAVE);
    if (!s) return null;
    return normalizeWorksheet(JSON.parse(s));
  } catch { return null; }
}
