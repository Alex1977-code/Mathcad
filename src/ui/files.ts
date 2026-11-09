import { normalizeWorksheet, type Worksheet } from '../engine/model';
import { loadWorksheetFile, ACCEPTED_EXTENSIONS } from '../import';
import { regionElements } from './layout';

type FileHandle = { name: string; createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }> };
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

export async function readWorksheet(file: File): Promise<Worksheet> {
  const buf = await file.arrayBuffer();
  const ws = await loadWorksheetFile(file.name, buf);
  if (/\.(fwk|json)$/i.test(file.name)) currentHandle = null;
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

/** Save as .fwk – uses the File System Access API when available. */
export async function saveWorksheet(ws: Worksheet, saveAs = false): Promise<string | null> {
  const blob = new Blob([serialize({ ...ws, source: ws.source ? { ...ws.source } : undefined })], { type: 'application/json' });
  const w = window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileHandle> };
  if (w.showSaveFilePicker && window.isSecureContext) {
    try {
      if (!currentHandle || saveAs) {
        currentHandle = await w.showSaveFilePicker({
          suggestedName: safeName(ws.title) + '.fwk',
          types: [{ description: 'FormelWerk-Arbeitsblatt', accept: { 'application/json': ['.fwk'] } }],
        });
      }
      const wr = await currentHandle!.createWritable();
      await wr.write(blob);
      await wr.close();
      return currentHandle!.name;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
    }
  }
  const name = safeName(ws.title) + '.fwk';
  download(name, blob);
  return name;
}

export function resetFileHandle() { currentHandle = null; }

/** Export the rendered worksheet as a standalone HTML page. */
export function exportHtml(ws: Worksheet) {
  const page = document.querySelector('.page') as HTMLElement | null;
  if (!page) return;
  const clone = page.cloneNode(true) as HTMLElement;
  clone.style.transform = 'none';
  clone.querySelectorAll('.grip,.check-badge,.crosshair,.welcome,.page-break-line,.page-margin,.plot-edit-btn,.error-chip').forEach(e => e.remove());
  clone.querySelectorAll('.region').forEach(e => e.classList.remove('selected', 'editing'));
  const css = Array.from(document.styleSheets).map(s => { try { return Array.from(s.cssRules).map(r => r.cssText).join('\n'); } catch { return ''; } }).join('\n');
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${ws.title.replace(/</g, '&lt;')}</title>
<style>${css}
body{overflow:auto;background:#eef0f4}.page{margin:24px auto;background-image:none}.region{border-color:transparent!important;background:transparent!important}</style></head>
<body><div class="page" style="${clone.getAttribute('style')}">${clone.innerHTML}</div></body></html>`;
  download(safeName(ws.title) + '.html', new Blob([html], { type: 'text/html' }));
  void regionElements;
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
