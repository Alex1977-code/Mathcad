import { useSyncExternalStore } from 'react';
import { emptyWorksheet, newId, sortRegions, type Region, type Worksheet, type WorksheetSettings } from '../engine/model';

export interface Cursor { x: number; y: number }

export interface AppState {
  ws: Worksheet;
  selection: string[];
  /** Region currently in edit mode. */
  editing: string | null;
  /** Source text of the math region at edit start (for Escape). */
  editOriginal: string | null;
  cursor: Cursor | null;
  fileName: string | null;
  dirty: boolean;
  zoom: number;
  showChecks: boolean;
  /** Region whose plot settings are open. */
  plotEditor: string | null;
  /** Region to scroll into view (set by "jump to"). */
  focusRegion: { id: string; n: number } | null;
  /** Incremented whenever another document is loaded. */
  docId: number;
  /** Automatic recalculation (Mathcad: Berechnen → Automatisch). */
  autoCalc: boolean;
  showGrid: boolean;
  sideOpen: boolean;
  sideTab: 'vars' | 'problems' | 'outline' | 'format' | 'help';
  palette: boolean;
  contextMenu: { x: number; y: number; regionId?: string; page?: { x: number; y: number } } | null;
  /** Requests a manual recalculation (incremented). */
  recalcTick: number;
  /** Something to undo / redo (for the state of the buttons). */
  canUndo: boolean;
  canRedo: boolean;
}

const HISTORY_LIMIT = 200;

export function readPref<T>(key: string, def: T): T {
  try { const v = localStorage.getItem('formelwerk.pref.' + key); return v === null ? def : JSON.parse(v) as T; } catch { return def; }
}
export function writePref(key: string, v: unknown) {
  try { localStorage.setItem('formelwerk.pref.' + key, JSON.stringify(v)); } catch { /* ignore */ }
}

class Store {
  state: AppState = {
    ws: emptyWorksheet(),
    selection: [], editing: null, editOriginal: null, cursor: { x: 48, y: 48 },
    fileName: null, dirty: false, zoom: 1, showChecks: true, plotEditor: null, focusRegion: null, docId: 0,
    autoCalc: true, showGrid: readPref('grid', true), sideOpen: typeof window === 'undefined' || window.innerWidth > 900,
    sideTab: 'vars', palette: false, contextMenu: null, recalcTick: 0, canUndo: false, canRedo: false,
  };
  past: Worksheet[] = [];
  future: Worksheet[] = [];
  listeners = new Set<() => void>();

  subscribe = (l: () => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  get = () => this.state;
  set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    // the edited region / plot was left: record the undo step now, if anything changed
    const b = this.editBase;
    if (b && (b.kind === 'region' ? this.state.editing !== b.id : this.state.plotEditor !== b.id)) this.finishEdit();
    // the plot settings collect all their changes into one undo step
    if (this.state.plotEditor && !this.editBase) this.editBase = { id: this.state.plotEditor, ws: this.state.ws, kind: 'plot' };
    const canUndo = this.past.length > 0 || (!!this.editBase && this.editBase.ws !== this.state.ws);
    const canRedo = this.future.length > 0;
    if (canUndo !== this.state.canUndo || canRedo !== this.state.canRedo) this.state = { ...this.state, canUndo, canRedo };
    this.listeners.forEach(l => l());
  }

  /** Document before the current edit; becomes an undo step only if the edit changed something. */
  private editBase: { id: string; ws: Worksheet; kind: 'region' | 'plot' } | null = null;

  /** Start editing a region (no undo step yet: a mere click must neither add one nor clear redo). */
  beginEdit(id: string) {
    if (this.editBase) this.finishEdit();
    this.editBase = { id, ws: this.state.ws, kind: 'region' };
  }

  private finishEdit() {
    const b = this.editBase;
    this.editBase = null;
    if (b && b.ws !== this.state.ws) {
      this.past.push(b.ws);
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
      this.future = [];
    }
  }

  /** Record the current document in the undo history. */
  checkpoint() {
    this.past.push(this.state.ws);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
  }

  /** Change the document. */
  updateWs(fn: (ws: Worksheet) => Worksheet, history = true) {
    if (history) this.checkpoint();
    this.set({ ws: fn(this.state.ws), dirty: true });
  }

  updateRegion(id: string, patch: Partial<Region>, history = true) {
    this.updateWs(ws => ({ ...ws, regions: ws.regions.map(r => (r.id === id ? { ...r, ...patch } as Region : r)) }), history);
  }

  addRegion(r: Region, edit = false) {
    this.updateWs(ws => ({ ...ws, regions: [...ws.regions, r] }));
    this.set({ selection: [r.id], editing: edit ? r.id : null, editOriginal: edit && r.type === 'math' ? r.src : null });
  }

  /** Remove a region that was created and left empty: also drops the undo step of its creation. */
  discardRegion(id: string) {
    this.updateWs(ws => ({ ...ws, regions: ws.regions.filter(r => r.id !== id) }), false);
    const top = this.past[this.past.length - 1];
    const cur = this.state.ws.regions;
    if (top && top.regions.length === cur.length && top.regions.every((r, i) => r === cur[i])) this.past.pop();
    // a region that existed before the edit and was cleared stays an undoable change
    if (this.editBase?.id === id && !this.editBase.ws.regions.some(r => r.id === id)) this.editBase = null;
  }

  deleteRegions(ids: string[]) {
    if (!ids.length) return;
    const set = new Set(ids);
    this.updateWs(ws => ({ ...ws, regions: ws.regions.filter(r => !set.has(r.id)) }));
    this.set({ selection: [], editing: null, plotEditor: this.state.plotEditor && set.has(this.state.plotEditor) ? null : this.state.plotEditor });
  }

  moveRegions(ids: string[], dx: number, dy: number, history = true) {
    const set = new Set(ids);
    // the group moves as a whole: limited by its leftmost/topmost region (no regions on top of each other)
    const moved = this.state.ws.regions.filter(r => set.has(r.id));
    if (!moved.length) return;
    dx = Math.max(dx, -Math.min(...moved.map(r => r.x)));
    dy = Math.max(dy, -Math.min(...moved.map(r => r.y)));
    if (dx === 0 && dy === 0) return;
    this.updateWs(ws => ({
      ...ws,
      regions: ws.regions.map(r => (set.has(r.id) ? { ...r, x: r.x + dx, y: r.y + dy } : r)),
    }), history);
  }

  setSettings(patch: Partial<WorksheetSettings>) {
    this.updateWs(ws => ({ ...ws, settings: { ...ws.settings, ...patch } }));
  }

  load(ws: Worksheet, fileName: string | null) {
    this.past = []; this.future = []; this.editBase = null;
    const first = sortRegions(ws.regions)[0];
    this.set({
      ws, fileName, dirty: false, selection: [], editing: null, editOriginal: null, plotEditor: null,
      cursor: { x: 48, y: first ? Math.max(...ws.regions.map(r => r.y)) + 60 : 48 },
      showChecks: true,
      docId: this.state.docId + 1,
    });
  }

  /** While typing, undo/redo work on the text being edited (like Ctrl+Z in the editor). */
  private textUndo(cmd: 'undo' | 'redo'): boolean {
    if (!this.state.editing || typeof document === 'undefined') return false;
    const a = document.activeElement as HTMLElement | null;
    if (!a || !(a.tagName === 'TEXTAREA' || a.isContentEditable)) return false;
    document.execCommand(cmd);
    return true;
  }

  undo() {
    if (this.textUndo('undo')) return;
    if (this.editBase) this.finishEdit();
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.state.ws);
    this.set({ ws: prev, editing: null, dirty: true, selection: this.state.selection.filter(id => prev.regions.some(r => r.id === id)) });
  }

  redo() {
    if (this.textUndo('redo')) return;
    if (this.editBase) this.finishEdit();
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.state.ws);
    this.set({ ws: next, editing: null, dirty: true });
  }

  /** Copy regions with fresh ids (paste / duplicate). */
  cloneRegions(regions: Region[], dx: number, dy: number): Region[] {
    return regions.map(r => ({ ...r, id: newId(), x: r.x + dx, y: r.y + dy }) as Region);
  }
}

export const store = new Store();

export function useStore<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(store.get()));
}
