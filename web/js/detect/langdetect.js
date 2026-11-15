/**
 * On-device language detection for catalog languages.
 * Prefers native LanguageDetector, then optional cld3 WASM, then compact heuristics.
 */

/** @type {Map<string, string>} */
const ALIASES = new Map([
  ['no', 'nb'],
  ['nb-no', 'nb'],
  ['nn', 'nn'],
  ['nn-no', 'nn'],
  ['iw', 'he'],
  ['in', 'id'],
  ['fil', 'tl'],
  ['mo', 'ro'],
  ['sh', 'sr'],
  ['sr-latn', 'sr'],
  ['sr-cyrl', 'sr'],
  ['zh-cn', 'zh'],
  ['zh-sg', 'zh'],
  ['zh-hans', 'zh'],
  ['zh-tw', 'zh-hant'],
  ['zh-hk', 'zh-hant'],
  ['zh-mo', 'zh-hant'],
  ['zh-hant', 'zh-hant'],
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
  af: ['die', 'en', 'van', 'is', 'het', 'op', 'te', 'met', 'vir', 'wat'],
  az: ['və', 'bu', 'üçün', 'ilə', 'də', 'ki', 'mən', 'necə', 'hansı', 'amma'],
  be: ['што', 'гэта', 'яны', 'яе', 'ужо', 'толькі', 'калі', 'таму', 'але', 'ці'],
  bs: ['i', 'je', 'se', 'na', 'za', 'da', 'su', 'koji', 'ne', 'od'],
  eu: ['eta', 'da', 'du', 'bat', 'ez', 'baina', 'ere', 'nire', 'zure', 'guzti'],
  gl: ['unha', 'é', 'son', 'están', 'tamén', 'moi', 'coa', 'súa', 'seu', 'non'],
  is: ['og', 'er', 'að', 'sem', 'á', 'til', 'í', 'en', 'það', 'ekki'],
  lt: ['ir', 'yra', 'kad', 'ne', 'su', 'tai', 'kaip', 'bet', 'labai', 'tik'],
  lv: ['un', 'ir', 'kas', 'ar', 'ne', 'uz', 'lai', 'tā', 'šis', 'tas'],
  ms: ['ialah', 'itu', 'bagi', 'sudah', 'akan', 'dengan', 'tidak', 'ini', 'dari', 'pada'],
  mt: ['u', 'li', 'ta', 'min', 'ma', 'għal', 'fost', 'fil', 'ħlief', 'jew'],
  nn: ['og', 'er', 'det', 'en', 'på', 'til', 'av', 'for', 'med', 'ikkje'],
  sq: ['dhe', 'të', 'një', 'është', 'me', 'në', 'për', 'nga', 'që', 'edhe'],
  sr: ['i', 'je', 'se', 'na', 'za', 'da', 'su', 'koji', 'ne', 'od'],
  tl: ['ang', 'ng', 'sa', 'mga', 'ay', 'ko', 'si', 'ni', 'po', 'ka'],
  ar: ['في', 'من', 'على', 'إلى', 'عن', 'مع', 'هذا', 'هذه', 'ذلك', 'التي'],
  fa: ['را', 'است', 'برای', 'می', 'شود', 'خواهد', 'این', 'آن', 'با', 'از'],
  ur: ['اور', 'کا', 'کی', 'میں', 'سے', 'ہے', 'کو', 'پر', 'ایک', 'یہ'],
  ug: ['بىر', 'بۇ', 'شۇ', 'ئۇ', 'ئى', 'دەپ', 'قىلماق', 'بىلەن', 'ياكى', 'ئۆز'],
  he: ['הוא', 'היא', 'של', 'על', 'עם', 'זה', 'זו', 'לא', 'גם', 'או'],
  hi: ['और', 'का', 'की', 'में', 'से', 'है', 'को', 'पर', 'एक', 'यह'],
  mr: ['आणि', 'आहे', 'मधील', 'पासून', 'ही', 'ला', 'हा', 'यासाठी', 'यावर', 'तो'],
  th: ['และ', 'ของ', 'ใน', 'ที่', 'เป็น', 'ไม่', 'นี้', 'นั้น', 'มี', 'ได้'],
};

/** Catalog languages grouped by dominant script for heuristic fallback. */
const SCRIPT_LANGS = {
  cyrillic: ['ru', 'uk', 'bg', 'sr', 'be'],
  greek: ['el'],
  arabic: ['ar', 'fa', 'ur', 'ug'],
  hebrew: ['he'],
  devanagari: ['hi', 'mr'],
  unique: {
    bengali: 'bn',
    gujarati: 'gu',
    tamil: 'ta',
    telugu: 'te',
    kannada: 'kn',
    malayalam: 'ml',
    thai: 'th',
    hangul: 'ko',
    kana: 'ja',
    han: 'zh',
  },
};

/** Latin-script catalog languages for the marker fallback. */
const LATIN_LANGS = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'sv', 'da', 'nb', 'nn',
  'fi', 'hu', 'ro', 'tr', 'ca', 'hr', 'sk', 'sl', 'id', 'ms', 'vi', 'et',
  'af', 'az', 'bs', 'eu', 'gl', 'is', 'lt', 'lv', 'mt', 'sq', 'sr', 'tl',
];

/**
 * Compact offline detector using script + stopword scoring.
 * @param {string} text
 * @returns {DetectHit | null}
 */
export function heuristicDetect(text) {
  const sample = text.slice(0, 2000);
  const script = dominantScript(sample);
  const unique = SCRIPT_LANGS.unique[script];
  if (unique) {
    return { language: unique, confidence: 0.85, backend: 'heuristic' };
  }
  if (script === 'cyrillic' || script === 'greek' || script === 'arabic' ||
      script === 'hebrew' || script === 'devanagari') {
    return scoreMarkers(sample, SCRIPT_LANGS[script], 0.7) ||
      { language: SCRIPT_LANGS[script][0], confidence: 0.6, backend: 'heuristic' };
  }
  return scoreMarkers(sample, LATIN_LANGS, 0.55);
}

/** Unicode range -> script name, checked in order. */
const SCRIPT_RANGES = [
  ['cyrillic', 0x0400, 0x04ff],
  ['cyrillic', 0x0500, 0x052f],
  ['greek', 0x0370, 0x03ff],
  ['greek', 0x1f00, 0x1fff],
  ['arabic', 0x0600, 0x06ff],
  ['arabic', 0x0750, 0x077f],
  ['arabic', 0x08a0, 0x08ff],
  ['arabic', 0xfb50, 0xfdff],
  ['arabic', 0xfe70, 0xfeff],
  ['hebrew', 0x0590, 0x05ff],
  ['devanagari', 0x0900, 0x097f],
  ['bengali', 0x0980, 0x09ff],
  ['gujarati', 0x0a80, 0x0aff],
  ['tamil', 0x0b80, 0x0bff],
  ['telugu', 0x0c00, 0x0c7f],
  ['kannada', 0x0c80, 0x0cff],
  ['malayalam', 0x0d00, 0x0d7f],
  ['thai', 0x0e00, 0x0e7f],
  ['hangul', 0x1100, 0x11ff],
  ['hangul', 0x3130, 0x318f],
  ['hangul', 0xac00, 0xd7af],
  ['kana', 0x3040, 0x30ff],
  ['kana', 0x31f0, 0x31ff],
  ['han', 0x3400, 0x4dbf],
  ['han', 0x4e00, 0x9fff],
  ['han', 0xf900, 0xfaff],
];

/**
 * @param {string} text
 * @returns {string}
 */
function dominantScript(text) {
  const counts = {};
  for (const ch of text) {
    const cp = ch.codePointAt(0) || 0;
    let name = null;
    if ((cp >= 0x41 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x024f) ||
        (cp >= 0x1e00 && cp <= 0x1eff)) {
      name = 'latin';
    } else {
      for (const [script, lo, hi] of SCRIPT_RANGES) {
        if (cp >= lo && cp <= hi) {
          name = script;
          break;
        }
      }
    }
    if (name) {
      counts[name] = (counts[name] || 0) + 1;
    }
  }
  let best = 'other';
  let bestCount = 0;
  for (const [name, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
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
