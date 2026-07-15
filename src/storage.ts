const DB_NAME = 'vnaviewer';
const DB_VERSION = 1;
const FILES_STORE = 'files';
const MEMORY_STORE = 'memory';

export interface StoredFile {
  name: string;
  text: string;
  /** Mirrors TouchstoneData.full - only meaningful for the memory store. */
  full?: boolean;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILES_STORE)) db.createObjectStore(FILES_STORE, { keyPath: 'name' });
      if (!db.objectStoreNames.contains(MEMORY_STORE)) db.createObjectStore(MEMORY_STORE, { keyPath: 'name' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveFile(name: string, text: string): Promise<void> {
  await withStore(FILES_STORE, 'readwrite', (s) => s.put({ name, text }));
}

export async function deleteFile(name: string): Promise<void> {
  await withStore(FILES_STORE, 'readwrite', (s) => s.delete(name));
}

export async function renameFile(oldName: string, newName: string, text: string): Promise<void> {
  await deleteFile(oldName);
  await saveFile(newName, text);
}

export async function clearFiles(): Promise<void> {
  await withStore(FILES_STORE, 'readwrite', (s) => s.clear());
}

export async function loadFiles(): Promise<StoredFile[]> {
  return withStore(FILES_STORE, 'readonly', (s) => s.getAll());
}

export async function saveMemory(name: string, text: string, full?: boolean): Promise<void> {
  await clearMemory();
  await withStore(MEMORY_STORE, 'readwrite', (s) => s.put({ name, text, full }));
}

export async function clearMemory(): Promise<void> {
  await withStore(MEMORY_STORE, 'readwrite', (s) => s.clear());
}

export async function loadMemory(): Promise<StoredFile | null> {
  const all = await withStore<StoredFile[]>(MEMORY_STORE, 'readonly', (s) => s.getAll());
  return all[0] ?? null;
}
