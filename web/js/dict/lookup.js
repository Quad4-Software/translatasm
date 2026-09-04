/**
 * Word normalize, light stemming, and merged dictionary lookup.
 */

import { getBiPack, getMonoPack } from './registry.js';
import { ensureMonoMeta, loadBiPack, loadMonoShard } from './packs.js';

const SUFFIXES = [
  'ingly',
  'edly',
  'ness',
  'ment',
  'tions',
  'tion',
  'ings',
  'ies',
  'ing',
  'ers',
  'est',
  'ed',
  'es',
  'ly',
  'er',
  's',
];

/**
 * @param {string} raw
 * @returns {string}
 */
export function normalizeWord(raw) {
  return String(raw || '')
    .normalize('NFKC')
    .trim()
    .replace(/^[\s"'“”‘’([{<]+/, '')
    .replace(/[\s"'“”‘’)\]}>.,;:!?…]+$/u, '')
    .toLowerCase();
}

/**
 * @param {string} word
 * @returns {string}
 */
export function shardKey(word) {
  if (!word) {
    return '_';
  }
  const ch = word[0];
  if (ch >= 'a' && ch <= 'z') {
    return ch;
  }
  const code = ch.codePointAt(0) || 0;
  if (code >= 0x0400 && code <= 0x04ff) {
    return 'cyr';
  }
  if (code >= 0x0370 && code <= 0x03ff) {
    return 'el';
  }
  return '_';
}

/**
 * @param {string} word
 * @returns {string[]}
 */
export function stemCandidates(word) {
  const out = [word];
  const seen = new Set(out);
  for (const suf of SUFFIXES) {
    if (word.length > suf.length + 2 && word.endsWith(suf)) {
      const stem = word.slice(0, -suf.length);
      if (!seen.has(stem)) {
        out.push(stem);
        seen.add(stem);
      }
      if (suf === 'ies' && stem.length) {
        const y = `${stem}y`;
        if (!seen.has(y)) {
          out.push(y);
          seen.add(y);
        }
      }
    }
  }
  return out;
}

/**
 * @param {Record<string, any>} entries
 * @param {string} word
 * @returns {{entry: any, matched: string, stemmed: boolean} | null}
 */
export function findInEntries(entries, word) {
  const candidates = stemCandidates(word);
  for (let i = 0; i < candidates.length; i += 1) {
    const key = candidates[i];
    let entry = entries[key];
    if (!entry) {
      continue;
    }
    if (entry.points_to) {
      const lemmaKey = String(entry.points_to).toLowerCase();
      const lemma = entries[lemmaKey];
      if (lemma) {
        return { entry: lemma, matched: key, stemmed: i > 0 || key !== word };
      }
    }
    return { entry, matched: key, stemmed: i > 0 };
  }
  return null;
}

/**
 * @param {Record<string, string[]>} entries
 * @param {string} word
 * @returns {{glosses: string[], matched: string, stemmed: boolean} | null}
 */
export function findGlosses(entries, word) {
  const candidates = stemCandidates(word);
  for (let i = 0; i < candidates.length; i += 1) {
    const key = candidates[i];
    const glosses = entries[key];
    if (glosses && glosses.length) {
      return { glosses, matched: key, stemmed: i > 0 };
    }
  }
  return null;
}

/**
 * @typedef {{
 *   word: string,
 *   lang: string,
 *   glossLang?: string,
 *   ipa?: string,
 *   pos?: string,
 *   senses?: Array<{g: string, e?: string, s?: string[]}>,
 *   glosses?: string[],
 *   matched?: string,
 *   stemmed?: boolean,
 *   packMissing?: boolean,
 *   status?: string,
 * }} DictResult
 */

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isPackMissing(err) {
  return Boolean(err && typeof err === 'object' && 'name' in err && err.name === 'DictPackMissing');
}

/**
 * @returns {Error}
 */
function missingPackError() {
  const err = new Error('Dictionary pack not downloaded yet');
  err.name = 'DictPackMissing';
  return err;
}

/**
 * @param {import('./registry.js').DictRegistry} registry
 * @param {string} word
 * @param {{lang: string, glossLang?: string}} opts
 * @returns {Promise<DictResult>}
 */
export async function lookupWord(registry, word, opts) {
  const normalized = normalizeWord(word);
  /** @type {DictResult} */
  const result = {
    word: normalized,
    lang: opts.lang,
    glossLang: opts.glossLang,
    senses: [],
    glosses: [],
  };
  if (!normalized) {
    result.status = 'Empty lookup.';
    return result;
  }

  const glossLang = opts.glossLang || '';
  if (glossLang && glossLang !== opts.lang) {
    try {
      const bi = await loadBiForPair(registry, opts.lang, glossLang);
      if (bi) {
        const hit = findGlosses(bi.entries || {}, normalized);
        if (hit) {
          result.glosses = hit.glosses;
          result.matched = hit.matched;
          result.stemmed = hit.stemmed;
        }
      }
    } catch (err) {
      if (isPackMissing(err)) {
        result.packMissing = true;
      } else {
        throw err;
      }
    }
  }

  try {
    const mono = await loadMonoEntry(registry, opts.lang, normalized);
    if (mono) {
      result.ipa = mono.entry.ipa || result.ipa;
      result.pos = mono.entry.pos || result.pos;
      result.senses = mono.entry.senses || [];
      result.matched = mono.matched;
      result.stemmed = mono.stemmed;
      result.word = mono.entry.w || normalized;
    }
  } catch (err) {
    if (isPackMissing(err)) {
      result.packMissing = true;
      result.status = 'Dictionary pack not downloaded yet';
    } else {
      throw err;
    }
  }

  if (!result.senses?.length && !result.glosses?.length && !result.packMissing) {
    result.status = 'No entry found.';
  }
  return result;
}

/**
 * @param {import('./registry.js').DictRegistry} registry
 * @param {string} from
 * @param {string} to
 */
async function loadBiForPair(registry, from, to) {
  const known = getBiPack(registry, from, to);
  try {
    return await loadBiPack(from, to);
  } catch (err) {
    if (isPackMissing(err)) {
      if (!known) {
        return null;
      }
      throw err;
    }
    throw err;
  }
}

/**
 * @param {import('./registry.js').DictRegistry} registry
 * @param {string} lang
 * @param {string} word
 */
async function loadMonoEntry(registry, lang, word) {
  let pack = getMonoPack(registry, lang);
  if (!pack) {
    throw missingPackError();
  }
  pack = await ensureMonoMeta(pack);
  const tried = new Set();
  for (const cand of stemCandidates(word)) {
    const shard = shardKey(cand);
    if (tried.has(shard)) {
      continue;
    }
    tried.add(shard);
    let data;
    try {
      data = await loadMonoShard(lang, shard);
    } catch (err) {
      if (isPackMissing(err)) {
        throw err;
      }
      continue;
    }
    const hit = findInEntries(data.entries || {}, word);
    if (hit) {
      return hit;
    }
  }
  return null;
}
