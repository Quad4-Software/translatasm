/**
 * On-device language detection for catalog languages.
 * Prefers native LanguageDetector, then optional cld3 WASM, then compact heuristics.
 */

/** @type {Map<string, string>} */
const ALIASES = new Map([
  ['no', 'nb'],
  ['nb-no', 'nb'],
  ['nn', 'nb'],
  ['iw', 'he'],
  ['zh-cn', 'zh'],
  ['zh-tw', 'zh'],
  ['zh-hans', 'zh'],
  ['zh-hant', 'zh'],
  ['pt-br', 'pt'],
  ['pt-pt', 'pt'],
  ['en-us', 'en'],
  ['en-gb', 'en'],
]);

const MIN_CONFIDENCE = 0.7;
const DETECT_DEBOUNCE_MIN_MS = 250;
const DETECT_DEBOUNCE_MAX_MS = 400;

/** @type {Promise<any> | null} */
let cld3Promise = null;
/** @type {any} */
let cld3Id = null;
/** @type {any} */
let nativeDetector = null;

/**
 * @param {number} len
 * @returns {number}
 */
export function detectDebounceMs(len) {
  if (len < 40) {
    return DETECT_DEBOUNCE_MIN_MS;
  }
  if (len > 400) {
    return DETECT_DEBOUNCE_MAX_MS;
  }
  return Math.round(
    DETECT_DEBOUNCE_MIN_MS + ((len - 40) / 360) * (DETECT_DEBOUNCE_MAX_MS - DETECT_DEBOUNCE_MIN_MS),
  );
}

/**
 * @param {string} code
 * @param {Set<string> | string[]} catalog
 * @returns {string | null}
 */
export function mapToCatalogLang(code, catalog) {
  if (!code) {
    return null;
  }
  const allow = catalog instanceof Set ? catalog : new Set(catalog);
  let c = String(code).trim().toLowerCase().replace(/_/g, '-');
  if (ALIASES.has(c)) {
    c = /** @type {string} */ (ALIASES.get(c));
  }
  const base = c.split('-')[0];
  if (ALIASES.has(base)) {
    const mapped = /** @type {string} */ (ALIASES.get(base));
    if (allow.has(mapped)) {
      return mapped;
    }
  }
  if (allow.has(c)) {
    return c;
  }
  if (allow.has(base)) {
    return base;
  }
  return null;
}

/**
 * @param {{language: string, confidence: number}} hit
 * @param {Set<string> | string[]} catalog
 * @param {number} [minConfidence]
 * @returns {string | null}
 */
export function gateDetection(hit, catalog, minConfidence = MIN_CONFIDENCE) {
  if (!hit || typeof hit.confidence !== 'number' || hit.confidence < minConfidence) {
    return null;
  }
  return mapToCatalogLang(hit.language, catalog);
}

/**
 * @typedef {{language: string, confidence: number, backend: string}} DetectHit
 */

/**
 * @param {string} text
 * @param {Set<string> | string[]} catalog
 * @param {{signal?: AbortSignal, minConfidence?: number}} [opts]
 * @returns {Promise<string | null>}
 */
export async function detectLanguage(text, catalog, opts = {}) {
  const trimmed = String(text || '').trim();
  if (trimmed.length < 8) {
    return null;
  }
  if (opts.signal?.aborted) {
    return null;
  }

  const hit = await detectRaw(trimmed, opts.signal);
  if (!hit) {
    return null;
  }
  return gateDetection(hit, catalog, opts.minConfidence);
}

/**
 * Warm detectors in the background after the app is ready.
 * @returns {Promise<void>}
 */
export async function warmDetector() {
  try {
    if (typeof LanguageDetector !== 'undefined') {
      const availability =
        typeof LanguageDetector.availability === 'function'
          ? await LanguageDetector.availability()
          : 'available';
      if (availability !== 'unavailable') {
        nativeDetector = await LanguageDetector.create();
        return;
      }
    }
  } catch {
    // fall through
  }
  try {
    await ensureCld3();
  } catch {
    // heuristic only
  }
}

/**
 * @param {string} text
 * @param {AbortSignal} [signal]
 * @returns {Promise<DetectHit | null>}
 */
async function detectRaw(text, signal) {
  if (signal?.aborted) {
    return null;
  }

  const native = await tryNative(text);
  if (native) {
    return native;
  }
  if (signal?.aborted) {
    return null;
  }

  const cld = await tryCld3(text);
  if (cld) {
    return cld;
  }
  if (signal?.aborted) {
    return null;
  }

  return heuristicDetect(text);
}

/**
 * @param {string} text
 * @returns {Promise<DetectHit | null>}
 */
async function tryNative(text) {
  try {
    if (typeof LanguageDetector === 'undefined') {
      return null;
    }
    if (!nativeDetector) {
      const availability =
        typeof LanguageDetector.availability === 'function'
          ? await LanguageDetector.availability()
          : 'available';
      if (availability === 'unavailable') {
        return null;
      }
      nativeDetector = await LanguageDetector.create();
    }
    const results = await nativeDetector.detect(text);
    if (!Array.isArray(results) || !results.length) {
      return null;
    }
    const top = results[0];
    const language = String(top.detectedLanguage || top.language || '');
    const confidence = Number(top.confidence ?? 0);
    if (!language) {
      return null;
    }
    return { language, confidence, backend: 'native' };
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<any>}
 */
async function ensureCld3() {
  if (cld3Id) {
    return cld3Id;
  }
  if (cld3Promise) {
    return cld3Promise;
  }
  cld3Promise = (async () => {
    const modUrl = '/vendor/cld3/cld3.js';
    const res = await fetch(modUrl, { method: 'HEAD' }).catch(() => null);
    if (!res || !res.ok) {
      throw new Error('cld3 not available');
    }
    const mod = await import(modUrl);
    const loadModule = mod.loadModule || mod.default?.loadModule || mod.default;
    if (typeof loadModule !== 'function') {
      throw new Error('cld3 loadModule missing');
    }
    const factory = await loadModule();
    cld3Id = factory.create?.(0, 1000) || factory;
    return cld3Id;
  })();
  try {
    return await cld3Promise;
  } catch (err) {
    cld3Promise = null;
    throw err;
  }
}

/**
 * @param {string} text
 * @returns {Promise<DetectHit | null>}
 */
async function tryCld3(text) {
  try {
    const id = await ensureCld3();
    const result = id.findLanguage?.(text) || id.findLanguage(text);
    if (!result || !result.language) {
      return null;
    }
    return {
      language: String(result.language),
      confidence: Number(result.probability ?? result.confidence ?? 0),
      backend: 'cld3',
    };
  } catch {
    return null;
  }
}

/** Stopword / marker lists for compact offline detection among catalog langs. */
const MARKERS = {
  en: ['the', 'and', 'is', 'are', 'you', 'that', 'with', 'this', 'have', 'from'],
  es: ['el', 'la', 'de', 'que', 'y', 'en', 'los', 'del', 'una', 'por'],
  fr: ['le', 'la', 'de', 'et', 'les', 'des', 'une', 'est', 'que', 'dans'],
  de: ['der', 'die', 'und', 'das', 'ist', 'nicht', 'ein', 'ich', 'mit', 'auf'],
  it: ['di', 'che', 'la', 'il', 'e', 'per', 'una', 'sono', 'con', 'non'],
  pt: ['de', 'que', 'o', 'a', 'e', 'do', 'da', 'em', 'um', 'para'],
  nl: ['de', 'het', 'een', 'van', 'en', 'is', 'op', 'te', 'dat', 'niet'],
  pl: ['się', 'nie', 'jest', 'to', 'na', 'do', 'że', 'jak', 'ale', 'czy'],
  ru: ['и', 'в', 'не', 'на', 'что', 'с', 'это', 'как', 'по', 'но'],
  uk: ['і', 'в', 'не', 'на', 'що', 'з', 'це', 'як', 'по', 'та'],
  bg: ['и', 'на', 'се', 'за', 'от', 'е', 'да', 'с', 'това', 'ще'],
  cs: ['a', 'se', 'na', 'je', 'to', 'že', 'v', 'do', 's', 'o'],
  sk: ['a', 'sa', 'na', 'je', 'to', 'že', 'v', 'do', 's', 'o'],
  sl: ['in', 'je', 'se', 'na', 'za', 'da', 'so', 'ki', 'pa', 'ne'],
  hr: ['i', 'je', 'se', 'na', 'za', 'da', 'su', 'koji', 'ne', 'od'],
  ro: ['și', 'de', 'în', 'la', 'cu', 'nu', 'este', 'o', 'care', 'din'],
  hu: ['a', 'az', 'és', 'hogy', 'nem', 'van', 'egy', 'el', 'meg', 'is'],
  fi: ['ja', 'on', 'ei', 'että', 'se', 'olen', 'kuin', 'jos', 'tai', 'hän'],
  sv: ['och', 'är', 'att', 'det', 'en', 'som', 'på', 'av', 'för', 'med'],
  da: ['og', 'er', 'at', 'det', 'en', 'på', 'til', 'af', 'for', 'med'],
  nb: ['og', 'er', 'det', 'en', 'på', 'til', 'av', 'for', 'med', 'ikke'],
  el: ['και', 'το', 'να', 'του', 'της', 'που', 'με', 'για', 'από', 'είναι'],
  tr: ['ve', 'bir', 'bu', 'için', 'de', 'da', 'ile', 'çok', 'ama', 'gibi'],
  vi: ['và', 'của', 'là', 'có', 'trong', 'các', 'được', 'không', 'một', 'người'],
  id: ['dan', 'yang', 'di', 'dengan', 'untuk', 'tidak', 'ini', 'dari', 'pada', 'adalah'],
  ca: ['de', 'la', 'i', 'que', 'el', 'els', 'les', 'un', 'una', 'per'],
  et: ['ja', 'on', 'ei', 'et', 'see', 'kui', 'ka', 'ning', 'või', 'aga'],
  zh: [],
  ja: [],
};

/**
 * Compact offline detector using script + stopword scoring.
 * @param {string} text
 * @returns {DetectHit | null}
 */
export function heuristicDetect(text) {
  const sample = text.slice(0, 2000);
  const script = dominantScript(sample);
  if (script === 'cjk') {
    const jaHits = (sample.match(/[\u3040-\u30ff]/g) || []).length;
    if (jaHits > 2) {
      return { language: 'ja', confidence: 0.85, backend: 'heuristic' };
    }
    return { language: 'zh', confidence: 0.8, backend: 'heuristic' };
  }
  if (script === 'cyrillic') {
    return scoreMarkers(sample, ['ru', 'uk', 'bg'], 0.75);
  }
  if (script === 'greek') {
    return { language: 'el', confidence: 0.9, backend: 'heuristic' };
  }

  const latinLangs = Object.keys(MARKERS).filter((c) => !['ru', 'uk', 'bg', 'el', 'zh', 'ja'].includes(c));
  return scoreMarkers(sample, latinLangs, 0.55);
}

/**
 * @param {string} text
 * @returns {'latin' | 'cyrillic' | 'greek' | 'cjk' | 'other'}
 */
function dominantScript(text) {
  let latin = 0;
  let cyr = 0;
  let greek = 0;
  let cjk = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) || 0;
    if ((cp >= 0x41 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x024f)) {
      latin += 1;
    } else if (cp >= 0x0400 && cp <= 0x04ff) {
      cyr += 1;
    } else if (cp >= 0x0370 && cp <= 0x03ff) {
      greek += 1;
    } else if (cp >= 0x3000 && cp <= 0x9fff) {
      cjk += 1;
    }
  }
  const max = Math.max(latin, cyr, greek, cjk);
  if (max === 0) {
    return 'other';
  }
  if (max === cjk) {
    return 'cjk';
  }
  if (max === cyr) {
    return 'cyrillic';
  }
  if (max === greek) {
    return 'greek';
  }
  return 'latin';
}

/**
 * @param {string} text
 * @param {string[]} langs
 * @param {number} floor
 * @returns {DetectHit | null}
 */
function scoreMarkers(text, langs, floor) {
  const tokens = text
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
  if (tokens.length < 3) {
    return null;
  }
  /** @type {Record<string, number>} */
  const scores = {};
  for (const lang of langs) {
    const markers = MARKERS[lang] || [];
    let hits = 0;
    for (const t of tokens) {
      if (markers.includes(t)) {
        hits += 1;
      }
    }
    scores[lang] = hits / tokens.length;
  }
  let best = '';
  let bestScore = 0;
  for (const [lang, score] of Object.entries(scores)) {
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  if (!best || bestScore < 0.02) {
    return null;
  }
  const confidence = Math.min(0.95, floor + bestScore * 4);
  return { language: best, confidence, backend: 'heuristic' };
}
