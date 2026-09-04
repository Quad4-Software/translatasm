/**
 * Personal vocabulary notebook backed by IndexedDB.
 */

const DB_NAME = 'translatasm.vocab.v1';
const STORE = 'entries';
const DB_VERSION = 1;

/**
 * @typedef {{
 *   id?: number,
 *   word: string,
 *   from: string,
 *   to: string,
 *   gloss?: string,
 *   note?: string,
 *   createdAt: number,
 * }} VocabEntry
 */

/**
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('word', 'word', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
}

/**
 * @param {Omit<VocabEntry, 'id' | 'createdAt'> & {createdAt?: number}} entry
 * @returns {Promise<VocabEntry>}
 */
export async function saveVocab(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    /** @type {VocabEntry} */
    const row = {
      word: entry.word,
      from: entry.from,
      to: entry.to,
      gloss: entry.gloss || '',
      note: entry.note || '',
      createdAt: entry.createdAt || Date.now(),
    };
    const req = store.add(row);
    req.onsuccess = () => {
      row.id = /** @type {number} */ (req.result);
      resolve(row);
    };
    req.onerror = () => reject(req.error || new Error('vocab save failed'));
  });
}

/**
 * @param {number} [limit]
 * @returns {Promise<VocabEntry[]>}
 */
export async function listVocab(limit = 50) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const index = store.index('createdAt');
    /** @type {VocabEntry[]} */
    const rows = [];
    const req = index.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || rows.length >= limit) {
        resolve(rows);
        return;
      }
      rows.push(/** @type {VocabEntry} */ (cursor.value));
      cursor.continue();
    };
    req.onerror = () => reject(req.error || new Error('vocab list failed'));
  });
}

/**
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function removeVocab(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error('vocab remove failed'));
  });
}
