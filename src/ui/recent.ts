/**
 * "Zuletzt verwendet": the last opened or saved documents, kept in the browser (IndexedDB). Each entry
 * stores the document as it was then and – where the browser offers it – the file handle, so the file
 * itself can be reopened (and saved back with Ctrl+S) later.
 */
import { normalizeWorksheet, type Worksheet } from '../engine/model';

export interface RecentEntry { key: string; name: string; when: number; kind: 'fwk' | 'xmcd' | 'mcdx' | 'other'; ws: Worksheet; handle?: FileSystemFileHandleLike }
export interface RecentInfo { key: string; name: string; when: number; kind: RecentEntry['kind']; hasFile: boolean }

/** The subset of FileSystemFileHandle used here. */
export interface FileSystemFileHandleLike {
  name: string;
  kind?: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }>;
  queryPermission?(o: { mode: 'read' | 'readwrite' }): Promise<string>;
  requestPermission?(o: { mode: 'read' | 'readwrite' }): Promise<string>;
  isSameEntry?(o: unknown): Promise<boolean>;
}

const DB = 'formelwerk', STORE = 'recent', MAX = 12, MAX_BYTES = 15e6;
const listeners = new Set<() => void>();
export function onRecentChange(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
const changed = () => listeners.forEach(l => l());

function open(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(DB, 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then(db => new Promise<T | undefined>(resolve => {
    if (!db) { resolve(undefined); return; }
    try {
      const t = db.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => { resolve(r ? r.result : undefined); db.close(); };
      t.onerror = t.onabort = () => { resolve(undefined); db.close(); };
    } catch { resolve(undefined); db.close(); }
  }));
}

const kindOf = (name: string): RecentEntry['kind'] => (/\.fwk$|\.json$/i.test(name) ? 'fwk' : /\.xmcd$/i.test(name) ? 'xmcd' : /\.mcdx$/i.test(name) ? 'mcdx' : 'other');

async function all(): Promise<RecentEntry[]> {
  return ((await tx<RecentEntry[]>('readonly', s => s.getAll())) ?? []).sort((a, b) => b.when - a.when);
}

export async function listRecent(): Promise<RecentInfo[]> {
  return (await all()).map(e => ({ key: e.key, name: e.name, when: e.when, kind: e.kind, hasFile: !!e.handle }));
}

/** Remember a document (after opening or saving). The same file replaces its older entry. */
export async function addRecent(name: string, ws: Worksheet, handle?: FileSystemFileHandleLike | null) {
  let json: string;
  try { json = JSON.stringify(ws); } catch { return; }
  if (json.length > MAX_BYTES) return;
  const list = await all();
  let key = `${name}`;
  for (const e of list) {
    const same = handle && e.handle?.isSameEntry ? await e.handle.isSameEntry(handle).catch(() => false) : !handle && !e.handle && e.name === name;
    if (same) { key = e.key; break; }
  }
  if (handle && key === name && list.some(e => e.key === key && !e.handle)) key = `${name}\u0000${Date.now()}`;
  const entry: RecentEntry = { key, name, when: Date.now(), kind: kindOf(name), ws: JSON.parse(json), ...(handle ? { handle } : {}) };
  await tx('readwrite', s => s.put(entry));
  // keep the newest MAX entries
  const after = await all();
  for (const e of after.slice(MAX)) await tx('readwrite', s => s.delete(e.key));
  changed();
}

export async function removeRecent(key: string) { await tx('readwrite', s => s.delete(key)); changed(); }
export async function clearRecent() { await tx('readwrite', s => s.clear()); changed(); }

/**
 * Open an entry: the file itself if its handle is still allowed (latest content), otherwise the stored
 * state. `fromFile` tells which one it was.
 */
export async function openRecent(key: string, read: (f: File) => Promise<Worksheet>): Promise<{ ws: Worksheet; name: string; handle?: FileSystemFileHandleLike; fromFile: boolean; when: number } | null> {
  const e = (await all()).find(x => x.key === key);
  if (!e) return null;
  if (e.handle) {
    try {
      let perm = (await e.handle.queryPermission?.({ mode: 'read' })) ?? 'granted';
      if (perm !== 'granted') perm = (await e.handle.requestPermission?.({ mode: 'read' })) ?? 'denied';
      if (perm === 'granted') {
        const ws = await read(await e.handle.getFile());
        return { ws, name: e.name, handle: e.handle, fromFile: true, when: e.when };
      }
    } catch { /* moved or deleted: use the stored state */ }
  }
  return { ws: normalizeWorksheet(e.ws), name: e.name, fromFile: false, when: e.when };
}

export function relativeTime(t: number, now = Date.now()): string {
  const d = Math.round((now - t) / 60000);
  if (d < 1) return 'gerade eben';
  if (d < 60) return `vor ${d} min`;
  if (d < 60 * 24) return `vor ${Math.round(d / 60)} h`;
  if (d < 60 * 24 * 7) return `vor ${Math.round(d / 1440)} Tagen`;
  return new Date(t).toLocaleDateString('de-DE');
}
