// IndexedDB の薄いラッパー
// stores:
//   tracks    : 曲のメタ情報 {id, fileName, size, title, artist, album, art, duration, addedAt}
//   blobs     : 曲ID -> MP3 本体 (Blob)
//   playlists : {id, name, trackIds, createdAt}
//   settings  : 任意のキー -> 値（再生状態の保存など）

const DB_NAME = 'local-player';
const DB_VERSION = 1;

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('tracks', { keyPath: 'id' });
        d.createObjectStore('blobs');
        d.createObjectStore('playlists', { keyPath: 'id' });
        d.createObjectStore('settings');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export async function get(store, key) {
  const d = await open();
  return request(d.transaction(store).objectStore(store).get(key));
}

export async function getAll(store) {
  const d = await open();
  return request(d.transaction(store).objectStore(store).getAll());
}

// [key, value] の配列を返す（keyPath を持たないストア用）
export async function entries(store) {
  const d = await open();
  const s = d.transaction(store).objectStore(store);
  const [keys, values] = await Promise.all([request(s.getAllKeys()), request(s.getAll())]);
  return keys.map((k, i) => [k, values[i]]);
}

export async function put(store, value, key) {
  const d = await open();
  const tx = d.transaction(store, 'readwrite');
  const s = tx.objectStore(store);
  if (key === undefined) s.put(value);
  else s.put(value, key);
  return done(tx);
}

export async function del(store, key) {
  const d = await open();
  const tx = d.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
}

export async function addTrack(meta, blob) {
  const d = await open();
  const tx = d.transaction(['tracks', 'blobs'], 'readwrite');
  tx.objectStore('tracks').put(meta);
  tx.objectStore('blobs').put(blob, meta.id);
  return done(tx);
}

export async function deleteTrack(id) {
  const d = await open();
  const tx = d.transaction(['tracks', 'blobs'], 'readwrite');
  tx.objectStore('tracks').delete(id);
  tx.objectStore('blobs').delete(id);
  return done(tx);
}
