/**
 * Sentence-level translation memory and dirty-set translate.
 * Retranslates only changed sentences for near-instant live typing.
 */

import { splitSentences } from './pairs.js';
import { needsCjkSegmentation, segmentSentences } from './segment.js';

const DEFAULT_CAP = 2048;
const SENTENCE_END_RE = /[.!?…。！？]["')\]]*\s*$/u;

/**
 * @typedef {{
 *   get: (from: string, to: string, html: boolean, source: string) => string | undefined,
 *   set: (from: string, to: string, html: boolean, source: string, target: string) => void,
 *   clearPair: (from: string, to: string) => void,
 *   clear: () => void,
 *   size: () => number,
 * }} TranslationMemory
 */

/**
 * @param {number} [cap]
 * @returns {TranslationMemory}
 */
export function createTranslationMemory(cap = DEFAULT_CAP) {
  /** @type {Map<string, string>} */
  const map = new Map();

  /**
   * @param {string} from
   * @param {string} to
   * @param {boolean} html
   * @param {string} source
   */
  function key(from, to, html, source) {
    return `${from}|${to}|${html ? 1 : 0}|${source}`;
  }

  return {
    get(from, to, html, source) {
      return map.get(key(from, to, html, source));
    },
    set(from, to, html, source, target) {
      const k = key(from, to, html, source);
      if (map.has(k)) {
        map.delete(k);
      }
      map.set(k, target);
      while (map.size > cap) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        map.delete(oldest);
      }
    },
    clearPair(from, to) {
      const prefix = `${from}|${to}|`;
      for (const k of [...map.keys()]) {
        if (k.startsWith(prefix)) {
          map.delete(k);
        }
      }
    },
    clear() {
      map.clear();
    },
    size() {
      return map.size;
    },
  };
}

/** @type {TranslationMemory} */
export const sharedMemory = createTranslationMemory();

/**
 * @param {string} sentence
 * @returns {boolean}
 */
export function isFinishedSentence(sentence) {
  const s = String(sentence ?? '').trim();
  if (!s) {
    return false;
  }
  return SENTENCE_END_RE.test(s);
}

/**
 * Split source into sentences using the same rules as align / CJK paths.
 * @param {string} text
 * @param {string} [lang]
 * @returns {string[]}
 */
export function splitForIncremental(text, lang) {
  const raw = String(text ?? '');
  if (!raw.trim()) {
    return [];
  }
  if (lang && needsCjkSegmentation(lang)) {
    return segmentSentences(raw, lang);
  }
  return splitSentences(raw, { lang });
}

/**
 * Classify whether finished sentences and/or the open trailing sentence changed.
 * @param {string} text
 * @param {string} prevText
 * @param {string} [lang]
 * @returns {{sources: string[], finishedChanged: boolean, openChanged: boolean, openIndex: number}}
 */
export function classifyLiveChange(text, prevText, lang) {
  const sources = splitForIncremental(text, lang);
  const prev = splitForIncremental(prevText, lang);
  const openIndex = sources.length ? sources.length - 1 : -1;
  const prevOpen = prev.length ? prev.length - 1 : -1;

  let finishedChanged = sources.length !== prev.length;
  if (!finishedChanged) {
    for (let i = 0; i < sources.length - 1; i += 1) {
      if (sources[i] !== prev[i]) {
        finishedChanged = true;
        break;
      }
    }
    if (!finishedChanged && sources.length > 0 && prev.length > 0) {
      const curFinished = isFinishedSentence(sources[openIndex]);
      const prevFinished = isFinishedSentence(prev[prevOpen]);
      if (curFinished !== prevFinished || (curFinished && sources[openIndex] !== prev[prevOpen])) {
        finishedChanged = true;
      }
    }
  }

  const openChanged =
    openIndex < 0
      ? prevOpen >= 0
      : prevOpen < 0 || sources[openIndex] !== prev[prevOpen] || sources.length !== prev.length;

  return { sources, finishedChanged, openChanged, openIndex };
}

/**
 * Open-sentence debounce: shorter than full-document debounce.
 * @param {number} openLen
 * @returns {number}
 */
export function openSentenceDebounceMs(openLen) {
  if (openLen < 40) {
    return 40;
  }
  if (openLen > 200) {
    return 80;
  }
  return Math.round(40 + ((openLen - 40) / 160) * 40);
}

/**
 * Translate only dirty sentences via translateBatch, stitch with TM hits.
 * @param {string} text
 * @param {{
 *   from: string,
 *   to: string,
 *   html?: boolean,
 *   signal?: AbortSignal,
 *   tm?: TranslationMemory,
 *   batchSize?: number,
 *   translateBatch: (sentences: string[], signal?: AbortSignal) => Promise<string[]>,
 *   onPartial?: (partial: {text: string, from: string, to: string, sentences?: {source:string,target:string}[]}) => void,
 *   onProgress?: (ev: {status?: string, progress?: number, file?: string}) => void,
 * }} opts
 * @returns {Promise<{text: string, from: string, to: string, sentences: {source:string,target:string}[], dirtyCount: number}>}
 */
export async function translateIncremental(text, opts) {
  const from = opts.from;
  const to = opts.to;
  const html = Boolean(opts.html);
  const tm = opts.tm || sharedMemory;
  const batchSize = Math.max(1, opts.batchSize ?? 12);

  if (html) {
    opts.onProgress?.({ status: 'translating', progress: 0.3, file: `${from}${to}` });
    const [out] = await opts.translateBatch([String(text ?? '')], opts.signal);
    const target = out ?? '';
    opts.onPartial?.({ text: target, from, to });
    opts.onProgress?.({ status: 'done', progress: 1 });
    return {
      text: target,
      from,
      to,
      sentences: [{ source: String(text ?? ''), target }],
      dirtyCount: 1,
    };
  }

  const sources = splitForIncremental(text, from);
  if (!sources.length) {
    return { text: '', from, to, sentences: [], dirtyCount: 0 };
  }

  /** @type {(string | null)[]} */
  const targets = sources.map((source) => tm.get(from, to, false, source) ?? null);
  /** @type {number[]} */
  const dirty = [];
  for (let i = 0; i < sources.length; i += 1) {
    if (targets[i] == null) {
      dirty.push(i);
    }
  }

  if (!dirty.length) {
    const sentences = sources.map((source, i) => ({ source, target: /** @type {string} */ (targets[i]) }));
    const joined = sentences.map((s) => s.target).join(' ');
    opts.onPartial?.({ text: joined, from, to, sentences });
    opts.onProgress?.({ status: 'done', progress: 1 });
    return { text: joined, from, to, sentences, dirtyCount: 0 };
  }

  const totalBatches = Math.ceil(dirty.length / batchSize);
  let batchIndex = 0;

  for (let offset = 0; offset < dirty.length; offset += batchSize) {
    if (opts.signal?.aborted) {
      const err = new Error('Translation cancelled');
      err.name = 'CancelledError';
      throw err;
    }
    const slice = dirty.slice(offset, offset + batchSize);
    const batchSources = slice.map((i) => sources[i]);
    opts.onProgress?.({
      status: 'translating',
      progress: 0.2 + (0.75 * batchIndex) / Math.max(totalBatches, 1),
      file: `${from}${to}`,
    });
    const batchTargets = await translateBatchSafe(batchSources, opts.translateBatch, opts.signal);
    for (let j = 0; j < slice.length; j += 1) {
      const idx = slice[j];
      const target = batchTargets[j] ?? '';
      targets[idx] = target;
      tm.set(from, to, false, sources[idx], target);
    }
    const sentences = sources.map((source, i) => ({
      source,
      target: targets[i] == null ? '' : /** @type {string} */ (targets[i]),
    }));
    opts.onPartial?.({
      text: sentences.map((s) => s.target).join(' '),
      from,
      to,
      sentences,
    });
    batchIndex += 1;
  }

  const sentences = sources.map((source, i) => ({
    source,
    target: /** @type {string} */ (targets[i] ?? ''),
  }));
  const joined = sentences.map((s) => s.target).join(' ');
  opts.onProgress?.({ status: 'done', progress: 1 });
  return { text: joined, from, to, sentences, dirtyCount: dirty.length };
}

/**
 * Prefer one batched call; fall back to per-sentence if line counts diverge.
 * @param {string[]} sources
 * @param {(sentences: string[], signal?: AbortSignal) => Promise<string[]>} translateBatch
 * @param {AbortSignal} [signal]
 * @returns {Promise<string[]>}
 */
async function translateBatchSafe(sources, translateBatch, signal) {
  if (sources.length === 1) {
    return translateBatch(sources, signal);
  }
  try {
    const joined = await translateBatch([sources.join('\n')], signal);
    const line = joined[0] ?? '';
    const parts = line.split('\n');
    if (parts.length === sources.length) {
      return parts;
    }
  } catch (err) {
    if (err && typeof err === 'object' && 'name' in err) {
      const name = String(err.name);
      if (name === 'CancelledError' || name === 'SupersededError' || name === 'AbortError') {
        throw err;
      }
    }
  }
  return translateBatch(sources, signal);
}
