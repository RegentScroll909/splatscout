// Local storage of buildings, captures and keyframes (IndexedDB). Photos are stored as Blobs,
// so nothing is lost if the browser tab is closed mid-capture.

const DB_NAME = 'splatscout';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('buildings')) db.createObjectStore('buildings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('captures')) {
        const s = db.createObjectStore('captures', { keyPath: 'id' });
        s.createIndex('buildingId', 'buildingId');
      }
      if (!db.objectStoreNames.contains('frames')) {
        const s = db.createObjectStore('frames', { keyPath: 'id' });
        s.createIndex('captureId', 'captureId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        Promise.resolve(fn(s, (r) => (result = r))).catch(reject);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Transaction aborted'));
      }),
  );
}

const req2p = (r) => new Promise((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---- buildings
export const listBuildings = () => tx('buildings', 'readonly', (s, set) => req2p(s.getAll()).then(set));
export const putBuilding = (b) => tx('buildings', 'readwrite', (s) => s.put(b));
export const getBuilding = (id) => tx('buildings', 'readonly', (s, set) => req2p(s.get(id)).then(set));

export async function findOrCreateBuilding(name) {
  const clean = name.trim() || 'Unnamed building';
  const all = await listBuildings();
  const hit = all.find((b) => b.name.toLowerCase() === clean.toLowerCase());
  if (hit) return hit;
  const b = { id: uid(), name: clean, createdAt: Date.now() };
  await putBuilding(b);
  return b;
}

// ---- captures
export const listCaptures = () => tx('captures', 'readonly', (s, set) => req2p(s.getAll()).then(set));
export const getCapture = (id) => tx('captures', 'readonly', (s, set) => req2p(s.get(id)).then(set));
export const putCapture = (c) => tx('captures', 'readwrite', (s) => s.put({ ...c, updatedAt: Date.now() }));

export async function deleteCapture(id) {
  const ids = await tx('frames', 'readonly', (s, set) => req2p(s.index('captureId').getAllKeys(id)).then(set));
  await tx('frames', 'readwrite', (s) => {
    for (const k of ids) s.delete(k);
  });
  await tx('captures', 'readwrite', (s) => s.delete(id));
}

// ---- frames
export const putFrame = (f) => tx('frames', 'readwrite', (s) => s.put(f));
export const getFrame = (id) => tx('frames', 'readonly', (s, set) => req2p(s.get(id)).then(set));
export const deleteFrame = (id) => tx('frames', 'readwrite', (s) => s.delete(id));

/** All frames of a capture, ordered by sequence number. Blobs are lazy handles (cheap). */
export async function getFrames(captureId) {
  const all = await tx('frames', 'readonly', (s, set) => req2p(s.index('captureId').getAll(captureId)).then(set));
  return all.sort((a, b) => a.seq - b.seq);
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usage: e.usage || 0, quota: e.quota || 0 };
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) return await navigator.storage.persist();
    return true;
  } catch {
    return false;
  }
}

export async function clearAll() {
  for (const s of ['frames', 'captures', 'buildings']) await tx(s, 'readwrite', (st) => st.clear());
}
