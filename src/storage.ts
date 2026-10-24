import type { Doc, Settings } from './types';

/** IndexedDB に作品を保存する。使えない環境ではメモリ上にだけ持つ。 */
const DB_NAME = 'personal-svg-maker';
const STORE = 'projects';

let dbPromise: Promise<IDBDatabase | null> | null = null;
const memory = new Map<string, Doc>();

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(null);
        try {
          const req = fn(db.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export async function saveProject(doc: Doc) {
  memory.set(doc.id, structuredClone(doc));
  await tx('readwrite', (s) => s.put(doc));
}

export async function loadProject(id: string): Promise<Doc | null> {
  return (await tx<Doc>('readonly', (s) => s.get(id))) ?? memory.get(id) ?? null;
}

export async function deleteProject(id: string) {
  memory.delete(id);
  await tx('readwrite', (s) => s.delete(id));
}

export async function listProjects(): Promise<Doc[]> {
  const all = (await tx<Doc[]>('readonly', (s) => s.getAll())) ?? [...memory.values()];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

const LAST_KEY = 'psm:lastProject';
const SETTINGS_KEY = 'psm:settings';

export function getLastProjectId(): string | null {
  try { return localStorage.getItem(LAST_KEY); } catch { return null; }
}
export function setLastProjectId(id: string) {
  try { localStorage.setItem(LAST_KEY, id); } catch { /* 保存できない環境 */ }
}

export const defaultSettings: Settings = {
  snapGrid: true,
  snapPoints: true,
  snapIntersections: true,
  snapOnLine: true,
  snapPerp: true,
  snapExtensions: true,
  loupe: true,
  showLines: true,
  snapScope: 'layer',
};

export function loadSettings(): Settings {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { ...defaultSettings };
  }
}
export function saveSettings(s: Settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* 保存できない環境 */ }
}
