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
}

const HISTORY_LIMIT = 200;

class Store {
  state: AppState = {
    ws: emptyWorksheet(),
    selection: [], editing: null, editOriginal: null, cursor: { x: 48, y: 48 },
    fileName: null, dirty: false, zoom: 1, showChecks: true, plotEditor: null, focusRegion: null, docId: 0,
  };
  past: Worksheet[] = [];
  future: Worksheet[] = [];
  listeners = new Set<() => void>();

  subscribe = (l: () => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  get = () => this.state;
  set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(l => l());
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

  deleteRegions(ids: string[]) {
    if (!ids.length) return;
    const set = new Set(ids);
    this.updateWs(ws => ({ ...ws, regions: ws.regions.filter(r => !set.has(r.id)) }));
    this.set({ selection: [], editing: null, plotEditor: this.state.plotEditor && set.has(this.state.plotEditor) ? null : this.state.plotEditor });
  }

  moveRegions(ids: string[], dx: number, dy: number, history = true) {
    const set = new Set(ids);
    this.updateWs(ws => ({
      ...ws,
      regions: ws.regions.map(r => (set.has(r.id) ? { ...r, x: Math.max(0, r.x + dx), y: Math.max(0, r.y + dy) } : r)),
    }), history);
  }

  setSettings(patch: Partial<WorksheetSettings>) {
    this.updateWs(ws => ({ ...ws, settings: { ...ws.settings, ...patch } }));
  }

  load(ws: Worksheet, fileName: string | null) {
    this.past = []; this.future = [];
    const first = sortRegions(ws.regions)[0];
    this.set({
      ws, fileName, dirty: false, selection: [], editing: null, editOriginal: null, plotEditor: null,
      cursor: { x: 48, y: first ? Math.max(...ws.regions.map(r => r.y)) + 60 : 48 },
      showChecks: true,
      docId: this.state.docId + 1,
    });
  }

  undo() {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.state.ws);
    this.set({ ws: prev, editing: null, dirty: true, selection: this.state.selection.filter(id => prev.regions.some(r => r.id === id)) });
  }

  redo() {
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
