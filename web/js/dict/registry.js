/**
 * Dictionary registry loader for offline packs under /dicts/.
 */

/**
 * @typedef {{
 *   id: string,
 *   path: string,
 *   entries?: number,
 *   bytes?: number,
 * }} DictShard
 */

/**
 * @typedef {{
 *   lang: string,
 *   path: string,
 *   entries: number,
 *   size_hint_mb: number,
 *   shards: DictShard[],
 *   attribution?: string,
 * }} MonoPack
 */

/**
 * @typedef {{
 *   id: string,
 *   from: string,
 *   to: string,
 *   path: string,
 *   entries: number,
 *   size_hint_mb: number,
 *   attribution?: string,
 * }} BiPack
 */

/**
 * @typedef {{
 *   version: number,
 *   pivot: string,
 *   attribution: string[],
 *   mono: Record<string, MonoPack>,
 *   bi: Record<string, BiPack>,
 * }} DictRegistry
 */

/**
 * @param {string} [url]
 * @returns {Promise<DictRegistry>}
 */
export async function loadDictRegistry(url = '/dicts/registry.json') {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) {
    throw new Error(`Dictionary registry unavailable (${res.status})`);
  }
  return /** @type {DictRegistry} */ (await res.json());
}

/**
 * @param {DictRegistry | null | undefined} registry
 * @param {string} lang
 * @returns {MonoPack | null}
 */
export function getMonoPack(registry, lang) {
  if (!registry || !lang) {
    return null;
  }
  return registry.mono?.[lang] || null;
}

/**
 * @param {DictRegistry | null | undefined} registry
 * @param {string} from
 * @param {string} to
 * @returns {BiPack | null}
 */
export function getBiPack(registry, from, to) {
  if (!registry || !from || !to) {
    return null;
  }
  const id = `${from}${to}`;
  return registry.bi?.[id] || null;
}
