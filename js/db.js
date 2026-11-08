// Speicher der App: IndexedDB direkt auf dem iPhone – keine Dateien, kein Server

const DB_NAME = 'regal';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('wishes')) d.createObjectStore('wishes', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  all: (store) => run(store, 'readonly', (s) => s.getAll()),
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  put: (store, value) => run(store, 'readwrite', (s) => s.put(value)),
  del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => run(store, 'readwrite', (s) => s.clear()),
  putMany: (store, values) => run(store, 'readwrite', (s) => { values.forEach((v) => s.put(v)); }),
};

export async function getSetting(key, fallback = null) {
  const r = await db.get('settings', key);
  return r ? r.value : fallback;
}

export function setSetting(key, value) {
  return db.put('settings', { key, value });
}

// Zwischenspeicher für Daten aus dem Internet (Diskografien, Filmreihen …)
export async function getCache(key) {
  return db.get('cache', key);
}

export function setCache(key, data) {
  return db.put('cache', { key, data, at: Date.now() });
}
