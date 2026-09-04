/**
 * Lazy pack/shard fetches. Relies on the service worker cacheFirst for /dicts/.
 */

/** @type {Map<string, Promise<any>>} */
const inflight = new Map();
/** @type {Map<string, any>} */
const cache = new Map();

/**
 * @param {string} path relative under /dicts/ or absolute /dicts/...
 * @returns {Promise<any>}
 */
export async function fetchDictJSON(path) {
  const url = path.startsWith('/') ? path : `/dicts/${path}`;
  if (cache.has(url)) {
    return cache.get(url);
  }
  if (inflight.has(url)) {
    return inflight.get(url);
  }
  const pending = (async () => {
    const res = await fetch(url, { credentials: 'omit' });
    if (res.status === 404) {
      const err = new Error('Dictionary pack not downloaded yet');
      err.name = 'DictPackMissing';
      throw err;
    }
    if (!res.ok) {
      throw new Error(`Dictionary fetch failed (${res.status})`);
    }
    const data = await res.json();
    cache.set(url, data);
    return data;
  })();
  inflight.set(url, pending);
  try {
    return await pending;
  } finally {
    inflight.delete(url);
  }
}

/**
 * @param {string} lang
 * @param {string} shardId
 * @returns {Promise<{lang: string, shard: string, entries: Record<string, any>}>}
 */
export async function loadMonoShard(lang, shardId) {
  return fetchDictJSON(`mono/${lang}/${shardId}.json`);
}

/**
 * @param {import('./registry.js').MonoPack} pack
 * @returns {Promise<import('./registry.js').MonoPack>}
 */
export async function ensureMonoMeta(pack) {
  if (pack.shards && pack.shards.length) {
    return pack;
  }
  const meta = await fetchDictJSON(pack.path);
  pack.shards = meta.shards || [];
  pack.entries = meta.entries || pack.entries;
  pack.size_hint_mb = meta.size_hint_mb || pack.size_hint_mb;
  return pack;
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {Promise<{from: string, to: string, entries: Record<string, string[]>}>}
 */
export async function loadBiPack(from, to) {
  return fetchDictJSON(`bi/${from}${to}.json`);
}

export function clearDictCache() {
  cache.clear();
}
