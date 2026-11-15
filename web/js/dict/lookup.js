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

/** [lo, hi, shard] Unicode ranges for non-Latin first characters. */
const SHARD_RANGES = [
  [0x0400, 0x04ff, 'cyr'],
  [0x0500, 0x052f, 'cyr'],
  [0x0370, 0x03ff, 'el'],
  [0x1f00, 0x1fff, 'el'],
  [0x0600, 0x06ff, 'arab'],
  [0x0750, 0x077f, 'arab'],
  [0x08a0, 0x08ff, 'arab'],
  [0xfb50, 0xfdff, 'arab'],
  [0xfe70, 0xfeff, 'arab'],
  [0x0590, 0x05ff, 'hebr'],
  [0x0900, 0x097f, 'deva'],
  [0x0980, 0x09ff, 'beng'],
  [0x0a80, 0x0aff, 'gujr'],
  [0x0b80, 0x0bff, 'taml'],
  [0x0c00, 0x0c7f, 'telu'],
  [0x0c80, 0x0cff, 'knda'],
  [0x0d00, 0x0d7f, 'mlym'],
  [0x0e00, 0x0e7f, 'thai'],
  [0x1100, 0x11ff, 'hangul'],
  [0x3130, 0x318f, 'hangul'],
  [0xac00, 0xd7af, 'hangul'],
  [0x3040, 0x30ff, 'kana'],
  [0x31f0, 0x31ff, 'kana'],
  [0x3400, 0x4dbf, 'hani'],
  [0x4e00, 0x9fff, 'hani'],
  [0xf900, 0xfaff, 'hani'],
];

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
  for (const [lo, hi, key] of SHARD_RANGES) {
    if (code >= lo && code <= hi) {
      return key;
    }
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
      const biHit = await loadGlossesWithPivot(registry, opts.lang, glossLang, normalized);
      if (biHit) {
        result.glosses = biHit.glosses;
        result.matched = biHit.matched;
        result.stemmed = biHit.stemmed;
        if (biHit.viaPivot) {
          result.status = result.status || 'Gloss via English pivot';
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
 * Direct bi pack, else English-pivot gloss when both legs exist.
 * @param {import('./registry.js').DictRegistry} registry
 * @param {string} lang
 * @param {string} glossLang
 * @param {string} normalized
 * @returns {Promise<{glosses: string[], matched: string, stemmed: boolean, viaPivot?: boolean} | null>}
 */
async function loadGlossesWithPivot(registry, lang, glossLang, normalized) {
  const direct = await loadBiForPair(registry, lang, glossLang);
  if (direct) {
    const hit = findGlosses(direct.entries || {}, normalized);
    if (hit) {
      return hit;
    }
  }

  if (lang === 'en' || glossLang === 'en') {
    return null;
  }

  const toEn = await loadBiForPair(registry, lang, 'en');
  if (!toEn) {
    return null;
  }
  const enHit = findGlosses(toEn.entries || {}, normalized);
  if (!enHit || !enHit.glosses?.length) {
    return null;
  }

  const enWord = normalizeWord(enHit.glosses[0]);
  const enToTarget = await loadBiForPair(registry, 'en', glossLang);
  if (enToTarget && enWord) {
    const pivoted = findGlosses(enToTarget.entries || {}, enWord);
    if (pivoted) {
      return {
        glosses: pivoted.glosses,
        matched: enHit.matched,
        stemmed: enHit.stemmed || pivoted.stemmed,
        viaPivot: true,
      };
    }
  }

  return {
    glosses: enHit.glosses.map((g) => `${g} (en)`),
    matched: enHit.matched,
    stemmed: enHit.stemmed,
    viaPivot: true,
  };
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
