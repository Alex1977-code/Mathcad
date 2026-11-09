import { normalizeWorksheet, type Worksheet } from '../engine/model';
// the Mathcad importers (with JSZip) are loaded only when a file is opened
const ACCEPTED_EXTENSIONS = '.fwk,.json,.xmcd,.mcdx,.mcd';
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

/** Export the rendered worksheet as a standalone HTML page (light theme, formula fonts embedded). */
export async function exportHtml(ws: Worksheet) {
  const page = document.querySelector('.page') as HTMLElement | null;
  if (!page) return;
  const clone = page.cloneNode(true) as HTMLElement;
  clone.style.transform = 'none';
  clone.querySelectorAll('.grip,.check-badge,.crosshair,.welcome,.page-break-line,.page-margin,.plot-edit-btn,.error-chip').forEach(e => e.remove());
  clone.querySelectorAll('.region').forEach(e => e.classList.remove('selected', 'editing'));
  const fontCache = new Map<string, string>();
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRule[];
    try { rules = Array.from(sheet.cssRules); } catch { continue; }
    for (const r of rules) {
      // the export is always light: drop the dark variants
      if (r instanceof CSSMediaRule && /prefers-color-scheme/.test(r.conditionText)) continue;
      if (/\[data-theme="?dark"?\]/.test(r.cssText)) continue;
      if (r instanceof CSSFontFaceRule) {
        // embed the woff2 font so formulas look right offline
        const m = /url\(["']?([^"')]+\.woff2)["']?\)/.exec(r.cssText);
        if (!m) continue;
        const url = new URL(m[1], sheet.href ?? location.href).href;
        let data = fontCache.get(url);
        if (data === undefined) {
          try { data = `data:font/woff2;base64,${bytesToB64(new Uint8Array(await (await fetch(url)).arrayBuffer()))}`; } catch { data = ''; }
          fontCache.set(url, data);
        }
        if (!data) continue;
        const desc = r.cssText.replace(/src:[^;]+;/, `src: url(${data}) format("woff2");`);
        parts.push(desc);
        continue;
      }
      parts.push(r.cssText);
    }
  }
  const title = String(ws.title ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = `<!doctype html><html lang="de" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>${parts.join('\n')}
:root{color-scheme:light}body{overflow:auto;background:#eef0f4;color:#1d2330}.page{margin:24px auto;background:#fff;background-image:none}.region{border-color:transparent!important;background:transparent!important}</style></head>
<body><div class="page" style="${(clone.getAttribute('style') ?? '').replace(/"/g, '&quot;')}">${clone.innerHTML}</div></body></html>`;
  download(safeName(String(ws.title ?? '')) + '.html', new Blob([html], { type: 'text/html' }));
  void regionElements;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
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
