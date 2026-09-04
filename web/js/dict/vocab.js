/**
 * Personal vocabulary notebook with SM-2-lite spaced review.
 */

const DB_NAME = 'translatasm.vocab.v1';
const STORE = 'entries';
const DB_VERSION = 2;

/**
 * @typedef {{
 *   id?: number,
 *   word: string,
 *   from: string,
 *   to: string,
 *   gloss?: string,
 *   note?: string,
 *   createdAt: number,
 *   updatedAt?: number,
 *   dueAt?: number,
 *   intervalDays?: number,
 *   ease?: number,
 *   reps?: number,
 *   lapses?: number,
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
      const old = req.oldVersion;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('word', 'word', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('dueAt', 'dueAt', { unique: false });
        store.createIndex('pairWord', ['from', 'to', 'word'], { unique: false });
      } else if (old < 2) {
        const store = req.transaction.objectStore(STORE);
        if (![...store.indexNames].includes('dueAt')) {
          store.createIndex('dueAt', 'dueAt', { unique: false });
        }
        if (![...store.indexNames].includes('pairWord')) {
          store.createIndex('pairWord', ['from', 'to', 'word'], { unique: false });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
}

/**
 * Upsert by (word, from, to).
 * @param {Omit<VocabEntry, 'id' | 'createdAt'> & {createdAt?: number, id?: number}} entry
 * @returns {Promise<VocabEntry>}
 */
export async function saveVocab(entry) {
  const existing = await findVocab(entry.word, entry.from, entry.to);
  const now = Date.now();
  /** @type {VocabEntry} */
  const row = {
    word: entry.word,
    from: entry.from,
    to: entry.to,
    gloss: entry.gloss || '',
    note: entry.note ?? existing?.note ?? '',
    createdAt: existing?.createdAt || entry.createdAt || now,
    updatedAt: now,
    dueAt: entry.dueAt ?? existing?.dueAt ?? now,
    intervalDays: entry.intervalDays ?? existing?.intervalDays ?? 0,
    ease: entry.ease ?? existing?.ease ?? 2.5,
    reps: entry.reps ?? existing?.reps ?? 0,
    lapses: entry.lapses ?? existing?.lapses ?? 0,
  };
  if (existing?.id != null) {
    row.id = existing.id;
  } else if (entry.id != null) {
    row.id = entry.id;
  }

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = row.id != null ? store.put(row) : store.add(row);
    req.onsuccess = () => {
      if (row.id == null) {
        row.id = /** @type {number} */ (req.result);
      }
      resolve(row);
    };
    req.onerror = () => reject(req.error || new Error('vocab save failed'));
  });
}

/**
 * @param {string} word
 * @param {string} from
 * @param {string} to
 * @returns {Promise<VocabEntry | null>}
 */
export async function findVocab(word, from, to) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    if (![...store.indexNames].includes('pairWord')) {
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = /** @type {VocabEntry[]} */ (req.result || []);
        resolve(rows.find((r) => r.word === word && r.from === from && r.to === to) || null);
      };
      req.onerror = () => reject(req.error || new Error('vocab find failed'));
      return;
    }
    const index = store.index('pairWord');
    const req = index.getAll([from, to, word]);
    req.onsuccess = () => {
      const rows = /** @type {VocabEntry[]} */ (req.result || []);
      resolve(rows[0] || null);
    };
    req.onerror = () => reject(req.error || new Error('vocab find failed'));
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
 * @param {number} [limit]
 * @returns {Promise<VocabEntry[]>}
 */
export async function listDueVocab(limit = 20) {
  const now = Date.now();
  const all = await listVocab(500);
  return all
    .filter((r) => (r.dueAt == null ? true : r.dueAt <= now))
    .sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0))
    .slice(0, limit);
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
    req.onerror = () => reject(req.error || new Error('vocab delete failed'));
  });
}

/**
 * @returns {Promise<VocabEntry[]>}
 */
export async function exportVocab() {
  return listVocab(10000);
}

/**
 * @param {VocabEntry[]} rows
 * @returns {Promise<number>}
 */
export async function importVocab(rows) {
  if (!Array.isArray(rows)) {
    throw new Error('Vocab import must be an array.');
  }
  let n = 0;
  for (const row of rows) {
    if (!row || !row.word || !row.from || !row.to) {
      continue;
    }
    await saveVocab(row);
    n += 1;
  }
  return n;
}

/**
 * @param {VocabEntry[]} rows
 * @returns {string}
 */
export function vocabToCsv(rows) {
  const header = 'word,from,to,gloss,note,dueAt,intervalDays,ease,reps,lapses';
  const lines = rows.map((r) =>
    [r.word, r.from, r.to, r.gloss || '', r.note || '', r.dueAt || '', r.intervalDays || '', r.ease || '', r.reps || '', r.lapses || '']
      .map(csvEscape)
      .join(','),
  );
  return [header, ...lines].join('\n');
}

/**
 * SM-2-lite: grade 0 = Again, 1 = Good.
 * @param {VocabEntry} entry
 * @param {0 | 1} grade
 * @returns {VocabEntry}
 */
export function scheduleReview(entry, grade) {
  const now = Date.now();
  let ease = entry.ease ?? 2.5;
  let reps = entry.reps ?? 0;
  let lapses = entry.lapses ?? 0;
  let intervalDays = entry.intervalDays ?? 0;

  if (grade === 0) {
    reps = 0;
    lapses += 1;
    intervalDays = 0;
    ease = Math.max(1.3, ease - 0.2);
  } else {
    if (reps === 0) {
      intervalDays = 1;
    } else if (reps === 1) {
      intervalDays = 3;
    } else {
      intervalDays = Math.max(1, Math.round(intervalDays * ease));
    }
    reps += 1;
    ease = Math.min(3.0, ease + 0.05);
  }

  return {
    ...entry,
    ease,
    reps,
    lapses,
    intervalDays,
    dueAt: now + intervalDays * 24 * 60 * 60 * 1000,
    updatedAt: now,
  };
}

/**
 * @param {string | number} v
 */
function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
