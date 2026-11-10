/**
 * Central command registry: used by the ribbon, the context menu, the command palette and the
 * keyboard shortcuts, so every function is reachable in the same way everywhere.
 */
import { newId, sortRegions, type MathRegion, type Region } from '../engine/model';
import { store, writePref } from './store';
import { getActiveEditor } from './editing';
import { MARGIN, regionElements, separateRegions, snap } from './layout';
import { pickFile } from './files';
import { quickPlotAtCursor } from './smart';
import { cursorOrDefault, imageRegionFromFile, insertForeign, regionsFromText, regionsHtml, regionsPlainText } from './clipboard';

export function newMathRegion(x: number, y: number, src = ''): Region {
  return { id: newId(), type: 'math', x, y, src };
}

/* --------------------------- insertion --------------------------- */

/** Insert a snippet into the active formula or start a new formula with it. */
export function insertSnippet(snippet: string) {
  const ed = getActiveEditor();
  if (ed) { ed.insert(snippet); return; }
  const s = store.get();
  if (s.editing) return;
  const cur = s.cursor ?? { x: MARGIN, y: MARGIN };
  // a program statement (return, break, try …) on its own becomes the body of a new program
  if (snippet.startsWith('\n')) snippet = 'f(x) :=\n' + snippet.slice(1).split('\n').map(l => '  ' + l).join('\n');
  store.addRegion(newMathRegion(cur.x, cur.y, snippet), true);
  store.set({ editOriginal: '' });
}

export function insertRegion(kind: 'math' | 'text' | 'plot' | 'pagebreak', at?: { x: number; y: number }) {
  const s = store.get();
  const cur = at ?? s.cursor ?? { x: MARGIN, y: MARGIN };
  if (kind === 'math') store.addRegion(newMathRegion(cur.x, cur.y), true);
  else if (kind === 'text') store.addRegion({ id: newId(), type: 'text', x: cur.x, y: cur.y, w: 380, html: '' }, true);
  else if (kind === 'plot') {
    const r: Region = { id: newId(), type: 'plot', x: cur.x, y: cur.y, w: 440, h: 270, traces: [{ x: 'x', y: '' }], xmin: '-10', xmax: '10' };
    store.addRegion(r);
    store.set({ plotEditor: r.id, cursor: { x: cur.x, y: snap(cur.y + 290) } });
  } else {
    store.addRegion({ id: newId(), type: 'pagebreak', x: 0, y: cur.y });
    store.set({ cursor: { x: cur.x, y: cur.y + 30 } });
  }
}

/** Insert a matrix template with the given size. */
export function insertMatrix(rows: number, cols: number) {
  const r = Array.from({ length: rows }, () => Array.from({ length: cols }, () => '?').join(', ')).join('; ');
  insertSnippet(`[${r}]`);
}

export async function insertImage() {
  const f = await pickFile('image/*');
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    const s = store.get();
    const cur = s.cursor ?? { x: MARGIN, y: MARGIN };
    const img = new Image();
    img.onload = () => {
      const w = Math.min(img.width, 600);
      store.addRegion({ id: newId(), type: 'image', x: cur.x, y: cur.y, w, src: String(reader.result), alt: f.name });
    };
    img.src = String(reader.result);
  };
  reader.readAsDataURL(f);
}

/* ---------------------------- arrange ---------------------------- */

export function alignSelection(dir: 'left' | 'top') {
  const s = store.get();
  const sel = s.ws.regions.filter(r => s.selection.includes(r.id));
  if (sel.length < 2) return;
  const v = dir === 'left' ? Math.min(...sel.map(r => r.x)) : Math.min(...sel.map(r => r.y));
  store.updateWs(ws => ({ ...ws, regions: ws.regions.map(r => (s.selection.includes(r.id) ? { ...r, [dir === 'left' ? 'x' : 'y']: v } as Region : r)) }));
}

export function separateAll(history = true) {
  const s = store.get();
  const next = separateRegions(sortRegions(s.ws.regions), (r) => {
    const el = regionElements.get(r.id);
    return el ? { x: r.x, y: r.y, w: el.offsetWidth, h: el.offsetHeight } : null;
  });
  const byId = new Map(next.map(r => [r.id, r]));
  store.updateWs(ws => ({ ...ws, regions: ws.regions.map(r => byId.get(r.id) ?? r) }), history);
}

/* --------------------------- clipboard --------------------------- */

let clip: Region[] = [];
const CLIP_KEY = 'formelwerk.clipboard';

/** Plain text this app last put on the system clipboard (to recognise its own regions when pasting). */
let lastCopiedText: string | null = null;

function remember(regs: Region[]) {
  clip = regs;
  try { sessionStorage.setItem(CLIP_KEY, JSON.stringify(regs)); } catch { /* ignore */ }
}

/** copy / cut event: plain text and HTML (Word equations) on the system clipboard, regions internally. */
export function handleCopyEvent(e: ClipboardEvent, cut: boolean): boolean {
  const s = store.get();
  const regs = s.ws.regions.filter(r => s.selection.includes(r.id));
  if (!regs.length || !e.clipboardData) return false;
  remember(regs);
  const text = regionsPlainText(regs);
  lastCopiedText = text;
  e.clipboardData.setData('text/plain', text);
  try { e.clipboardData.setData('text/html', regionsHtml(regs)); } catch { /* plain text is enough */ }
  e.preventDefault();
  if (cut) store.deleteRegions(s.selection);
  return true;
}

export function copySelection(cut = false) {
  // through the browser's copy command: fills the clipboard in the copy event (no permission needed)
  let ok = false;
  try { ok = document.execCommand(cut ? 'cut' : 'copy'); } catch { ok = false; }
  if (ok) return;
  const s = store.get();
  const regs = s.ws.regions.filter(r => s.selection.includes(r.id));
  if (!regs.length) return;
  remember(regs);
  lastCopiedText = regionsPlainText(regs);
  navigator.clipboard?.writeText(lastCopiedText).catch(() => undefined);
  if (cut) store.deleteRegions(s.selection);
}

/** paste event: own regions, or text / pictures from other programs. */
export function handlePasteEvent(e: ClipboardEvent): boolean {
  const dt = e.clipboardData;
  const at = cursorOrDefault();
  const text = dt?.getData('text/plain') ?? '';
  const files = Array.from(dt?.files ?? []).filter(f => f.type.startsWith('image/'));
  if (text && text === lastCopiedText && canPaste()) { e.preventDefault(); paste(); return true; }
  if (files.length) {
    e.preventDefault();
    Promise.all(files.map((f, i) => imageRegionFromFile(f, { x: at.x, y: at.y + i * 24 }))).then(insertForeign).catch(() => undefined);
    return true;
  }
  if (text.trim()) { e.preventDefault(); insertForeign(regionsFromText(text, at)); return true; }
  if (canPaste()) { e.preventDefault(); paste(); return true; }
  return false;
}

export function copyImageWithToast() {
  copyAsImage().then(ok => app.notify(ok ? 'Als Bild in die Zwischenablage kopiert' : 'Bild-Kopieren wird von diesem Browser nicht unterstützt', !ok))
    .catch(e => app.notify('Kopieren fehlgeschlagen: ' + (e as Error).message, true));
}

/** Selected regions as a picture on the clipboard (for Word, PowerPoint, e-mail …). */
export async function copyAsImage(): Promise<boolean> {
  const s = store.get();
  if (!s.selection.length) return false;
  const { regionsToPng } = await import('./exporters');
  const png = regionsToPng(s.selection).then(p => { if (!p) throw new Error('Bild konnte nicht erzeugt werden'); return p.blob; });
  const C = (window as unknown as { ClipboardItem?: new (d: Record<string, Promise<Blob> | Blob>) => unknown }).ClipboardItem;
  if (!C || !navigator.clipboard?.write) return false;
  await navigator.clipboard.write([new C({ 'image/png': png }) as ClipboardItem]);
  return true;
}

export function canPaste() {
  if (clip.length) return true;
  try { return !!sessionStorage.getItem(CLIP_KEY); } catch { return false; }
}

export function paste(at?: { x: number; y: number }) {
  if (!clip.length) { try { clip = JSON.parse(sessionStorage.getItem(CLIP_KEY) ?? '[]'); } catch { clip = []; } }
  if (!clip.length) return;
  const s = store.get();
  const minX = Math.min(...clip.map(r => r.x)), minY = Math.min(...clip.map(r => r.y));
  const cur = at ?? s.cursor ?? { x: minX + 24, y: minY + 24 };
  const copies = store.cloneRegions(clip, cur.x - minX, cur.y - minY);
  store.updateWs(w => ({ ...w, regions: [...w.regions, ...copies] }));
  // the next paste lands offset, not exactly on top of this one
  store.set({ selection: copies.map(r => r.id), cursor: { x: cur.x + 24, y: cur.y + 24 } });
}

export function duplicateSelection() {
  const s = store.get();
  const regs = s.ws.regions.filter(r => s.selection.includes(r.id));
  if (!regs.length) return;
  const h = Math.max(...regs.map(r => r.y + (regionElements.get(r.id)?.offsetHeight ?? 24))) - Math.min(...regs.map(r => r.y));
  const copies = store.cloneRegions(regs, 0, h + 12);
  store.updateWs(w => ({ ...w, regions: [...w.regions, ...copies] }));
  store.set({ selection: copies.map(r => r.id) });
}

export function selectAll() { store.set({ selection: store.get().ws.regions.map(r => r.id) }); }
export function deleteSelection() { store.deleteRegions(store.get().selection); }

/** Mathcad "Auswertung deaktivieren": the region stays visible but is not calculated. */
export function toggleDisabled() {
  const s = store.get();
  const sel = s.ws.regions.filter(r => s.selection.includes(r.id) && r.type === 'math') as MathRegion[];
  if (!sel.length) return;
  const off = !sel.every(r => r.disabled);
  store.updateWs(ws => ({ ...ws, regions: ws.regions.map(r => (s.selection.includes(r.id) && r.type === 'math' ? { ...r, disabled: off || undefined } : r)) }));
}

export function editSelection() {
  const s = store.get();
  if (s.selection.length !== 1) return;
  const r = s.ws.regions.find(x => x.id === s.selection[0]);
  if (!r) return;
  if (r.type === 'plot') { store.set({ plotEditor: r.id }); return; }
  if (r.type !== 'math' && r.type !== 'text') return;
  store.beginEdit(r.id);
  store.set({ editing: r.id, editOriginal: r.type === 'math' ? r.src : null });
}

/* ----------------------------- view ------------------------------ */

export function setZoom(z: number) { store.set({ zoom: Math.max(0.5, Math.min(2, +z.toFixed(2))) }); }
export function zoomBy(d: number) { setZoom(store.get().zoom + d); }
export function zoomPageWidth() {
  const sc = document.querySelector('.scroller') as HTMLElement | null;
  if (!sc) return;
  // page plus side padding of .page-outer must fit exactly (round down, no horizontal scrollbar)
  const pad = parseFloat(getComputedStyle(sc.querySelector('.page-outer') ?? sc).paddingLeft || '40') * 2;
  setZoom(Math.floor(((sc.clientWidth - pad - 2) / 794) * 100) / 100);
}
export function toggleDefValues() { const v = !store.get().showDefValues; store.set({ showDefValues: v }); writePref('defValues', v); }
export function toggleGrid() { const v = !store.get().showGrid; store.set({ showGrid: v }); writePref('grid', v); }
export function showSide(tab: ReturnType<typeof store.get>['sideTab']) { store.set({ sideOpen: true, sideTab: tab, plotEditor: null }); }
export function toggleSide() { store.set({ sideOpen: !store.get().sideOpen }); }
export function recalcNow() { store.set({ recalcTick: store.get().recalcTick + 1 }); }
export function toggleAutoCalc() { store.set({ autoCalc: !store.get().autoCalc }); }

/* ------------------------- format settings ----------------------- */

export function changeDecimals(d: number) {
  const s = store.get().ws.settings;
  store.setSettings({ decimals: Math.max(0, Math.min(12, s.decimals + d)) });
}

/* --------------------------- app handlers ------------------------ */

export interface AppHandlers {
  openFile: () => void; save: (as?: boolean) => void; newDoc: () => void; openExample: () => void;
  exportHtml: () => void; exportDocx: () => void; print: () => void; toggleTheme: () => void; showReport: () => void;
  notify: (text: string, err?: boolean) => void;
  openRecent: (key: string) => void;
  exportMcdx: () => void;
}
let handlers: AppHandlers | null = null;
export function setAppHandlers(h: AppHandlers) { handlers = h; }
export const app = new Proxy({} as AppHandlers, { get: (_t, k) => (handlers as unknown as Record<string, unknown>)?.[k as string] ?? (() => undefined) });

/* ---------------------------- commands --------------------------- */

export interface Command { id: string; label: string; group: string; keys?: string; run: () => void; when?: () => boolean; /** Additional search words. */ tags?: string }

const hasSel = () => store.get().selection.length > 0;

export function commands(): Command[] {
  return [
    { id: 'new', group: 'Datei', label: 'Neues Arbeitsblatt', run: () => app.newDoc() },
    { id: 'open', group: 'Datei', label: 'Öffnen / Mathcad-Datei importieren …', keys: 'Strg+O', run: () => app.openFile() },
    { id: 'save', group: 'Datei', label: 'Speichern', keys: 'Strg+S', run: () => app.save() },
    { id: 'saveas', group: 'Datei', label: 'Speichern unter …', keys: 'Strg+Umschalt+S', run: () => app.save(true) },
    { id: 'docx', group: 'Datei', label: 'Als Word-Dokument (.docx) exportieren', run: () => app.exportDocx(), tags: 'word docx office export' },
    { id: 'mcdx', group: 'Datei', label: 'Als Mathcad-Prime-Datei (.mcdx) exportieren', run: () => app.exportMcdx(), tags: 'mathcad prime export speichern' },
    { id: 'html', group: 'Datei', label: 'Als HTML exportieren', run: () => app.exportHtml() },
    { id: 'pagesetup', group: 'Datei', label: 'Kopf- und Fußzeile, Projekt, Bearbeiter …', run: () => store.set({ pageSetup: true }), tags: 'seite einrichten kopfzeile fußzeile seitenzahl' },
    { id: 'print', group: 'Datei', label: 'Drucken / als PDF speichern', keys: 'Strg+P', run: () => app.print() },
    { id: 'example', group: 'Datei', label: 'Beispiel öffnen', run: () => app.openExample() },
    { id: 'undo', group: 'Bearbeiten', label: 'Rückgängig', keys: 'Strg+Z', run: () => store.undo() },
    { id: 'redo', group: 'Bearbeiten', label: 'Wiederholen', keys: 'Strg+Y', run: () => store.redo() },
    { id: 'cut', group: 'Bearbeiten', label: 'Ausschneiden', keys: 'Strg+X', run: () => copySelection(true), when: hasSel },
    { id: 'copy', group: 'Bearbeiten', label: 'Kopieren', keys: 'Strg+C', run: () => copySelection(false), when: hasSel },
    { id: 'paste', group: 'Bearbeiten', label: 'Einfügen', keys: 'Strg+V', run: () => paste(), when: canPaste },
    { id: 'copyimg', group: 'Bearbeiten', label: 'Als Bild kopieren', run: () => copyImageWithToast(), when: hasSel, tags: 'png bild zwischenablage word' },
    { id: 'dup', group: 'Bearbeiten', label: 'Duplizieren', keys: 'Strg+D', run: duplicateSelection, when: hasSel },
    { id: 'del', group: 'Bearbeiten', label: 'Löschen', keys: 'Entf', run: deleteSelection, when: hasSel },
    { id: 'find', group: 'Bearbeiten', label: 'Suchen …', keys: 'Strg+F', run: () => store.set({ find: { replace: false } }), tags: 'finden suche' },
    { id: 'replace', group: 'Bearbeiten', label: 'Ersetzen …', keys: 'Strg+H', run: () => store.set({ find: { replace: true } }), tags: 'suchen ersetzen umbenennen' },
    { id: 'all', group: 'Bearbeiten', label: 'Alles auswählen', keys: 'Strg+A', run: selectAll },
    { id: 'disable', group: 'Bearbeiten', label: 'Auswertung deaktivieren / aktivieren', run: toggleDisabled, when: hasSel },
    { id: 'math', group: 'Einfügen', label: 'Formel', keys: 'Tippen', run: () => insertRegion('math') },
    { id: 'text', group: 'Einfügen', label: 'Textbereich', keys: '"', run: () => insertRegion('text'), tags: 'notiz beschreibung' },
    { id: 'plot', group: 'Einfügen', label: 'X-Y-Diagramm', keys: '@', run: () => quickPlotAtCursor(), tags: 'diagramm plot graph kurve' },
    { id: 'image', group: 'Einfügen', label: 'Bild …', run: () => insertImage() },
    { id: 'pagebreak', group: 'Einfügen', label: 'Seitenumbruch', run: () => insertRegion('pagebreak') },
    { id: 'matrix', group: 'Einfügen', label: 'Matrix 3×3', keys: 'Strg+M', run: () => insertMatrix(3, 3) },
    { id: 'sumt', group: 'Einfügen', label: 'Summe Σ', keys: '$', run: () => insertSnippet('sum(?, i, 1, n)') },
    { id: 'intt', group: 'Einfügen', label: 'Integral ∫', keys: '&', run: () => insertSnippet('int(?, x, a, b)') },
    { id: 'given', group: 'Einfügen', label: 'Solve-Block (Given … Find)', run: () => insertSnippet('Given') },
    { id: 'alignl', group: 'Anordnen', label: 'Links ausrichten', run: () => alignSelection('left'), when: () => store.get().selection.length > 1 },
    { id: 'alignt', group: 'Anordnen', label: 'Oben ausrichten', run: () => alignSelection('top'), when: () => store.get().selection.length > 1 },
    { id: 'separate', group: 'Anordnen', label: 'Bereiche trennen', run: () => separateAll() },
    { id: 'recalc', group: 'Berechnung', label: 'Jetzt berechnen', keys: 'F9', run: recalcNow },
    { id: 'auto', group: 'Berechnung', label: 'Automatische Berechnung ein/aus', run: toggleAutoCalc },
    { id: 'decp', group: 'Berechnung', label: 'Mehr Nachkommastellen', run: () => changeDecimals(1) },
    { id: 'decm', group: 'Berechnung', label: 'Weniger Nachkommastellen', run: () => changeDecimals(-1) },
    { id: 'comma', group: 'Berechnung', label: 'Dezimalkomma ein/aus', run: () => store.setSettings({ decimalComma: !store.get().ws.settings.decimalComma }) },
    { id: 'report', group: 'Berechnung', label: 'Mathcad-Importbericht anzeigen', run: () => app.showReport(), when: () => !!store.get().ws.source },
    { id: 'problems', group: 'Ansicht', label: 'Probleme anzeigen', run: () => showSide('problems') },
    { id: 'vars', group: 'Ansicht', label: 'Variablen anzeigen', run: () => showSide('vars') },
    { id: 'outline', group: 'Ansicht', label: 'Gliederung anzeigen', run: () => showSide('outline') },
    { id: 'help', group: 'Ansicht', label: 'Kurzreferenz', keys: 'F1', run: () => showSide('help') },
    { id: 'side', group: 'Ansicht', label: 'Seitenleiste ein/aus', run: toggleSide },
    { id: 'grid', group: 'Ansicht', label: 'Raster ein/aus', run: toggleGrid },
    { id: 'defvals', group: 'Ansicht', label: 'Werte von Definitionen anzeigen ein/aus', run: toggleDefValues, tags: 'wert zeigen variablen' },
    { id: 'theme', group: 'Ansicht', label: 'Hell / Dunkel umschalten', run: () => app.toggleTheme() },
    { id: 'zin', group: 'Ansicht', label: 'Vergrößern', keys: 'Strg++', run: () => zoomBy(0.1), tags: 'zoom größer' },
    { id: 'zout', group: 'Ansicht', label: 'Verkleinern', keys: 'Strg+-', run: () => zoomBy(-0.1), tags: 'zoom kleiner' },
    { id: 'z100', group: 'Ansicht', label: 'Zoom 100 %', keys: 'Strg+0', run: () => setZoom(1) },
    { id: 'zfit', group: 'Ansicht', label: 'Seitenbreite', run: zoomPageWidth, tags: 'zoom anpassen breite' },
  ];
}
