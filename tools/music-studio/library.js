/* IndexedDB-backed local library for the music studio.
 *
 * Schema (one store "tracks"):
 *   {
 *     id:       string  // crypto.randomUUID()
 *     name:     string  // user-edited display name
 *     bus:      "bgm" | "sfx"
 *     loop:     boolean
 *     volume:   number 0..1
 *     duration: number  // post-trim seconds
 *     bitrate:  number  // kbps (0 for url-only entries)
 *     bytes:    number  // blob size; 0 for url-only
 *     mime:     string
 *     // EITHER blob OR url (mutually exclusive):
 *     blob?:    Blob    // present for compressed/encoded local entries
 *     url?:     string  // present for external URL entries
 *     // Origin metadata:
 *     origName: string  // original filename or URL
 *     trim?:    { start: number, end: number }  // seconds; only for blob entries
 *     ts:       number  // creation timestamp
 *   }
 *
 * Why IndexedDB: localStorage tops out at ~5 MB; a single 64 kbps OPUS
 * BGM clip is ~500 KB and we want to keep dozens. IDB blob storage is
 * the only path that scales without re-encoding on every read.
 */

const DB_NAME = "obr-music-studio";
const DB_VER  = 1;
const STORE   = "tracks";

let _dbPromise = null;
function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "id" });
        s.createIndex("ts", "ts", { unique: false });
        s.createIndex("bus", "bus", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  // Don't poison the cache on a one-off failure (private mode, corrupted db).
  _dbPromise.catch(() => { _dbPromise = null; });
  return _dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error);
  });
}

export async function addTrack(track) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(track);
  await txDone(tx);
  return track;
}

export async function updateTrack(id, patch) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const cur = await reqOnce(store.get(id));
  if (!cur) { await txDone(tx); return null; }
  const next = { ...cur, ...patch };
  store.put(next);
  await txDone(tx);
  return next;
}

export async function deleteTrack(id) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  await txDone(tx);
}

export async function listTracks() {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const store = tx.objectStore(STORE);
  const all = await reqOnce(store.getAll());
  await txDone(tx);
  // Newest first.
  return (all || []).sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

export async function getTrack(id) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const v = await reqOnce(tx.objectStore(STORE).get(id));
  await txDone(tx);
  return v || null;
}

function reqOnce(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Total stored blob bytes — for the library's footer "X tracks, Y MB" stat. */
export async function libraryStats() {
  const tracks = await listTracks();
  let bytes = 0;
  for (const t of tracks) bytes += (t.bytes || 0);
  return { count: tracks.length, bytes };
}
