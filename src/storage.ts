import type { Doc, ProjectFolder, Settings } from './types';

/** IndexedDB に作品と作品フォルダーを保存する。使えない環境ではメモリ上にだけ持つ。 */
const DB_NAME = 'personal-svg-maker';
const PROJECTS = 'projects';
const FOLDERS = 'folders';
type StoreName = typeof PROJECTS | typeof FOLDERS;

let dbPromise: Promise<IDBDatabase | null> | null = null;
const memory: Record<StoreName, Map<string, unknown>> = { projects: new Map(), folders: new Map() };

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'id' });
          if (!db.objectStoreNames.contains(FOLDERS)) db.createObjectStore(FOLDERS, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(null);
        try {
          const req = fn(db.transaction(store, mode).objectStore(store));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

async function put<T extends { id: string }>(store: StoreName, v: T) {
  memory[store].set(v.id, structuredClone(v));
  await tx(store, 'readwrite', (s) => s.put(v));
}
async function get<T>(store: StoreName, id: string): Promise<T | null> {
  return (await tx<T>(store, 'readonly', (s) => s.get(id))) ?? (memory[store].get(id) as T | undefined) ?? null;
}
async function del(store: StoreName, id: string) {
  memory[store].delete(id);
  await tx(store, 'readwrite', (s) => s.delete(id));
}
async function all<T>(store: StoreName): Promise<T[]> {
  return (await tx<T[]>(store, 'readonly', (s) => s.getAll())) ?? ([...memory[store].values()] as T[]);
}

export const saveProject = (doc: Doc) => put(PROJECTS, doc);
export const loadProject = (id: string) => get<Doc>(PROJECTS, id);
export const deleteProject = (id: string) => del(PROJECTS, id);
export async function listProjects(): Promise<Doc[]> {
  return (await all<Doc>(PROJECTS)).sort((a, b) => b.updatedAt - a.updatedAt);
}

export const saveFolder = (f: ProjectFolder) => put(FOLDERS, f);
export const deleteFolder = (id: string) => del(FOLDERS, id);
export async function listFolders(): Promise<ProjectFolder[]> {
  return (await all<ProjectFolder>(FOLDERS)).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
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
