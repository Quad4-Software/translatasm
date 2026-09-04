/**
 * Term glossary: protect brand names / do-not-translate before MT, restore after.
 */

const DB_NAME = 'translatasm.glossary.v1';
const STORE = 'entries';
const DB_VERSION = 1;

/**
 * @typedef {{
 *   id?: number,
 *   from: string,
 *   to: string,
 *   source: string,
 *   target: string,
 *   caseSensitive?: boolean,
 * }} GlossaryEntry
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
        store.createIndex('pair', ['from', 'to'], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('glossary DB open failed'));
  });
}

/**
 * @param {GlossaryEntry} entry
 * @returns {Promise<GlossaryEntry>}
 */
export async function saveGlossary(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    /** @type {GlossaryEntry} */
    const row = {
      from: entry.from,
      to: entry.to,
      source: String(entry.source || '').trim(),
      target: String(entry.target || '').trim(),
      caseSensitive: Boolean(entry.caseSensitive),
    };
    if (!row.source || !row.target) {
      reject(new Error('Glossary needs source and target.'));
      return;
    }
    if (entry.id != null) {
      row.id = entry.id;
      const req = store.put(row);
      req.onsuccess = () => resolve(row);
      req.onerror = () => reject(req.error || new Error('glossary put failed'));
      return;
    }
    const req = store.add(row);
    req.onsuccess = () => {
      row.id = /** @type {number} */ (req.result);
      resolve(row);
    };
    req.onerror = () => reject(req.error || new Error('glossary add failed'));
  });
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {Promise<GlossaryEntry[]>}
 */
export async function listGlossary(from, to) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const index = store.index('pair');
    const req = index.getAll([from, to]);
    req.onsuccess = () => resolve(/** @type {GlossaryEntry[]} */ (req.result || []));
    req.onerror = () => reject(req.error || new Error('glossary list failed'));
  });
}

/**
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function removeGlossary(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error('glossary delete failed'));
  });
}

/**
 * @returns {Promise<GlossaryEntry[]>}
 */
export async function exportGlossary() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(/** @type {GlossaryEntry[]} */ (req.result || []));
    req.onerror = () => reject(req.error || new Error('glossary export failed'));
  });
}

/**
 * @param {GlossaryEntry[]} rows
 * @returns {Promise<number>}
 */
export async function importGlossary(rows) {
  if (!Array.isArray(rows)) {
    throw new Error('Glossary import must be an array.');
  }
  let n = 0;
  for (const row of rows) {
    if (!row || !row.source || !row.target || !row.from || !row.to) {
      continue;
    }
    await saveGlossary({
      from: row.from,
      to: row.to,
      source: row.source,
      target: row.target,
      caseSensitive: Boolean(row.caseSensitive),
    });
    n += 1;
  }
  return n;
}

/**
 * @param {string} text
 * @param {GlossaryEntry[]} entries
 * @param {{html?: boolean}} [opts]
 * @returns {{text: string, map: string[]}}
 */
export function protectTerms(text, entries, opts = {}) {
  const map = [];
  if (!text || !entries?.length) {
    return { text: String(text || ''), map };
  }
  const sorted = [...entries].sort((a, b) => b.source.length - a.source.length);
  let out = String(text);
  for (const entry of sorted) {
    const src = entry.source;
    if (!src) {
      continue;
    }
    const token = `__T${map.length}__`;
    map.push(entry.target);
    if (opts.html) {
      out = replaceOutsideTags(out, src, token, entry.caseSensitive);
    } else {
      out = replaceAll(out, src, token, entry.caseSensitive);
    }
  }
  return { text: out, map };
}

/**
 * @param {string} text
 * @param {string[]} map
 * @returns {string}
 */
export function restoreTerms(text, map) {
  let out = String(text || '');
  if (!map?.length) {
    return out;
  }
  for (let i = 0; i < map.length; i += 1) {
    const token = `__T${i}__`;
    out = out.split(token).join(map[i]);
  }
  return out;
}

/**
 * @param {string} hay
 * @param {string} needle
 * @param {string} replacement
 * @param {boolean} [caseSensitive]
 */
function replaceAll(hay, needle, replacement, caseSensitive) {
  if (!needle) {
    return hay;
  }
  if (caseSensitive) {
    return hay.split(needle).join(replacement);
  }
  const re = new RegExp(escapeRegExp(needle), 'gi');
  return hay.replace(re, replacement);
}

/**
 * Replace needle only in text nodes outside HTML tags.
 * @param {string} hay
 * @param {string} needle
 * @param {string} replacement
 * @param {boolean} [caseSensitive]
 */
function replaceOutsideTags(hay, needle, replacement, caseSensitive) {
  const parts = hay.split(/(<[^>]*>)/);
  return parts
    .map((part) => {
      if (part.startsWith('<') && part.endsWith('>')) {
        return part;
      }
      return replaceAll(part, needle, replacement, caseSensitive);
    })
    .join('');
}

/**
 * @param {string} s
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
