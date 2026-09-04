/**
 * Bergamot / Marian WASM translation engine.
 * Keeps one worker alive, pivots through English, chunks long input.
 */

import {
  LatencyOptimisedTranslator,
  TranslatorBacking,
  SupersededError,
  CancelledError,
} from '/vendor/bergamot/translator.js';
import { splitChunks } from './pairs.js';
import { sharedMemory, translateIncremental } from './incremental.js';

/**
 * Loads models from the local static registry at /models/registry.json.
 */
class LocalBacking extends TranslatorBacking {
  /**
   * @param {object} [options]
   */
  constructor(options = {}) {
    const { onerror, ...safe } = options;
    super({
      ...safe,
      registryUrl: safe.registryUrl || '/models/registry.json',
      downloadTimeout: safe.downloadTimeout ?? 180000,
      pivotLanguage: safe.pivotLanguage ?? 'en',
      // Must live on backing options. LatencyOptimisedTranslator does not
      // forward its own options into initialize() when a custom backing is used.
      // Marian docs: 2^14 is a solid interactive default. Real use is ~1/3 of this.
      cacheSize: safe.cacheSize ?? 16384,
      useNativeIntGemm: safe.useNativeIntGemm !== false,
    });
    if (typeof onerror === 'function') {
      this.onerror = onerror;
    }
  }

  /**
   * Prefer explicit from/to fields so registry keys stay stable.
   * @returns {Promise<{from:string,to:string,files:object}[]>}
   */
  async loadModelRegistery() {
    const response = await fetch(this.registryUrl, { credentials: 'omit' });
    const registry = await response.json();
    return Object.entries(registry).map(([key, files]) => {
      const from = typeof files.from === 'string' ? files.from : key.substring(0, 2);
      const to = typeof files.to === 'string' ? files.to : key.substring(2, 4);
      const rest = { ...files };
      delete rest.from;
      delete rest.to;
      return { from, to, files: rest };
    });
  }

  /**
   * Skip SRI when the registry leaves hashes empty.
   * @param {string} url
   * @param {string} [checksum]
   * @param {{signal?: AbortSignal}} [extra]
   * @returns {Promise<ArrayBuffer>}
   */
  async fetch(url, checksum, extra) {
    const clean = checksum && String(checksum).trim() ? checksum : undefined;
    return super.fetch(url, clean, extra);
  }
}

/**
 * @returns {boolean}
 */
export function hasNativeIntGemm() {
  try {
    return typeof WebAssembly !== 'undefined' && typeof WebAssembly.mozIntGemm === 'function';
  } catch {
    return false;
  }
}

/**
 * @returns {import('./types.js').Engine}
 */
export function createBergamotEngine() {
  /** @type {LatencyOptimisedTranslator | null} */
  let translator = null;
  /** @type {Promise<LatencyOptimisedTranslator> | null} */
  let boot = null;
  /** @type {string} */
  let lastFrom = '';
  /** @type {string} */
  let lastTo = '';
  /** @type {Set<string>} */
  const loadedPairs = new Set();

  /**
   * @param {(ev: import('./types.js').ProgressEvent) => void} [onProgress]
   * @returns {Promise<LatencyOptimisedTranslator>}
   */
  async function ensureTranslator(onProgress) {
    if (translator) {
      return translator;
    }
    if (boot) {
      return boot;
    }

    boot = (async () => {
      onProgress?.({ status: 'loading', progress: 0.05, file: 'bergamot-wasm' });
      const backing = new LocalBacking({
        onerror: (err) => console.error('bergamot worker', err),
        cacheSize: 16384,
        useNativeIntGemm: true,
      });
      const t = new LatencyOptimisedTranslator({}, backing);
      await t.worker;
      onProgress?.({ status: 'ready', progress: 0.2, file: 'bergamot-wasm' });
      translator = t;
      return t;
    })();

    try {
      return await boot;
    } finally {
      boot = null;
    }
  }

  /**
   * @param {string} from
   * @param {string} to
   */
  function pairKey(from, to) {
    return `${from}|${to}`;
  }

  /**
   * @param {string} from
   * @param {string} to
   */
  function bufferKey(from, to) {
    return JSON.stringify({ from, to });
  }

  /**
   * Drop main-thread ArrayBuffers for a pair (~20MB each) after WASM copy.
   * Service worker cacheFirst still makes the next fetch fast.
   * @param {LatencyOptimisedTranslator} t
   * @param {string} from
   * @param {string} to
   */
  function dropPairBuffers(t, from, to) {
    try {
      t.backing?.buffers?.delete(bufferKey(from, to));
    } catch {
      // ignore
    }
  }

  /**
   * Free one WASM model and its JS ArrayBuffers.
   * @param {LatencyOptimisedTranslator} t
   * @param {string} from
   * @param {string} to
   */
  async function releasePair(t, from, to) {
    const key = pairKey(from, to);
    const worker = await t.worker;
    const exports = worker?.exports;
    if (exports && typeof exports.freeTranslationModel === 'function') {
      try {
        await exports.freeTranslationModel({ from, to });
      } catch {
        // ignore prune failures
      }
    }
    loadedPairs.delete(key);
    dropPairBuffers(t, from, to);
  }

  /**
   * Fetch model files so the service worker caches them, without loading WASM.
   * @param {LatencyOptimisedTranslator} t
   * @param {string} from
   * @param {string} to
   */
  async function warmPairCache(t, from, to) {
    const registry = await t.backing.registry;
    const entry = registry.find((m) => m.from === from && m.to === to);
    if (!entry?.files) {
      return;
    }
    // Sequential to avoid holding every file buffer at once.
    for (const file of Object.values(entry.files)) {
      if (!file || typeof file.name !== 'string') {
        continue;
      }
      try {
        await t.backing.fetch(file.name, file.expectedSha256Hash);
      } catch {
        // ignore warm failures
      }
    }
  }

  /**
   * True when every keep pair is loaded and nothing else needs freeing.
   * @param {string[]} keep
   * @returns {boolean}
   */
  function pruneNeeded(keep) {
    const keepSet = new Set(keep);
    for (const key of loadedPairs) {
      if (!keepSet.has(key)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Drop WASM models and JS buffers that are not the active route.
   * @param {LatencyOptimisedTranslator} t
   * @param {string[]} keep
   */
  async function pruneModels(t, keep) {
    if (!pruneNeeded(keep)) {
      return;
    }
    const keepSet = new Set(keep);
    for (const key of [...loadedPairs]) {
      if (keepSet.has(key)) {
        continue;
      }
      const [from, to] = key.split('|');
      await releasePair(t, from, to);
    }
    const buffers = t.backing?.buffers;
    if (!buffers || typeof buffers.keys !== 'function') {
      return;
    }
    for (const bufKey of [...buffers.keys()]) {
      try {
        const parsed = JSON.parse(String(bufKey));
        const from = parsed?.from;
        const to = parsed?.to;
        if (typeof from !== 'string' || typeof to !== 'string') {
          continue;
        }
        if (!keepSet.has(pairKey(from, to))) {
          buffers.delete(bufKey);
        }
      } catch {
        // ignore malformed keys
      }
    }
  }

  /**
   * @param {LatencyOptimisedTranslator} t
   * @param {string} from
   * @param {string} to
   * @param {string} text
   * @param {boolean} html
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  async function translateRaw(t, from, to, text, html, signal) {
    const result = await t.translate(
      {
        from,
        to,
        text,
        html,
      },
      { signal },
    );
    return result?.target?.text ?? '';
  }

  /**
   * @param {LatencyOptimisedTranslator} t
   * @param {string} from
   * @param {string} to
   * @param {string[]} sentences
   * @param {AbortSignal} [signal]
   * @returns {Promise<string[]>}
   */
  async function translateBatch(t, from, to, sentences, signal) {
    if (!sentences.length) {
      return [];
    }
    if (sentences.length === 1) {
      return [await translateRaw(t, from, to, sentences[0], false, signal)];
    }
    const joined = await translateRaw(t, from, to, sentences.join('\n'), false, signal);
    const parts = joined.split('\n');
    if (parts.length === sentences.length) {
      return parts;
    }
    /** @type {string[]} */
    const out = [];
    for (const sentence of sentences) {
      if (signal?.aborted) {
        const err = new Error('Translation cancelled');
        err.name = 'CancelledError';
        throw err;
      }
      out.push(await translateRaw(t, from, to, sentence, false, signal));
    }
    return out;
  }

  /**
   * @param {string} from
   * @param {string} to
   * @param {string[]} keep
   */
  function markLoaded(from, to, keep) {
    loadedPairs.add(pairKey(from, to));
    if (from !== 'en' && to !== 'en') {
      loadedPairs.add(pairKey(from, 'en'));
      loadedPairs.add(pairKey('en', to));
    }
    for (const key of keep) {
      loadedPairs.add(key);
    }
  }

  return {
    id: 'bergamot',

    /**
     * Warm the WASM runtime. Language packs load lazily on translate.
     * @param {import('./types.js').ModelInfo} [_model]
     * @param {(ev: import('./types.js').ProgressEvent) => void} [onProgress]
     */
    async load(_model, onProgress) {
      await ensureTranslator(onProgress);
      onProgress?.({ status: 'ready', progress: 1 });
    },

    /**
     * @param {string} text
     * @param {import('./types.js').TranslateOptions} [opts]
     */
    async translate(text, opts = {}) {
      const from = opts.from;
      const to = opts.to;
      if (!from || !to) {
        throw new Error('Source and target languages are required.');
      }
      if (from === to) {
        return { text: String(text ?? ''), from, to };
      }

      const t = await ensureTranslator(opts.onProgress);
      const raw = String(text ?? '');
      const trimmed = raw.trim();
      if (!trimmed) {
        return { text: '', from, to };
      }

      const keep = [pairKey(from, to)];
      if (from !== 'en' && to !== 'en') {
        keep.push(pairKey(from, 'en'), pairKey('en', to));
      }
      await pruneModels(t, keep);

      if (lastFrom && lastTo && (lastFrom !== from || lastTo !== to)) {
        sharedMemory.clearPair(lastFrom, lastTo);
      }
      lastFrom = from;
      lastTo = to;

      const html = Boolean(opts.html);

      /**
       * @param {string} chunk
       * @param {AbortSignal} [signal]
       */
      async function runChunk(chunk, signal) {
        try {
          const out = await translateRaw(t, from, to, chunk, html, signal);
          markLoaded(from, to, keep);
          for (const key of keep) {
            const [kf, kt] = key.split('|');
            dropPairBuffers(t, kf, kt);
          }
          return out;
        } catch (err) {
          if (err instanceof SupersededError || err instanceof CancelledError) {
            throw err;
          }
          if (err && typeof err === 'object' && 'name' in err) {
            const name = String(err.name);
            if (name === 'SupersededError' || name === 'CancelledError') {
              throw err;
            }
          }
          throw err;
        }
      }

      if (html || opts.incremental === false) {
        const chunks = splitChunks(raw, opts.chunkChars ?? 1100, {
          html,
          lang: from,
        });
        /** @type {string[]} */
        const parts = [];
        const total = chunks.length;
        for (let i = 0; i < total; i += 1) {
          opts.onProgress?.({
            status: 'translating',
            progress: 0.2 + (0.75 * i) / Math.max(total, 1),
            file: `${from}${to}`,
          });
          parts.push(await runChunk(chunks[i], opts.signal));
          if (opts.onPartial) {
            opts.onPartial({ text: parts.join(html ? '\n\n' : '\n'), from, to });
          }
        }
        opts.onProgress?.({ status: 'done', progress: 1 });
        return { text: parts.join(html ? '\n\n' : '\n'), from, to };
      }

      /**
       * @param {string[]} sentences
       * @param {AbortSignal} [signal]
       */
      async function batchFn(sentences, signal) {
        const out = await translateBatch(t, from, to, sentences, signal);
        markLoaded(from, to, keep);
        for (const key of keep) {
          const [kf, kt] = key.split('|');
          dropPairBuffers(t, kf, kt);
        }
        return out;
      }

      try {
        const result = await translateIncremental(raw, {
          from,
          to,
          html: false,
          signal: opts.signal,
          tm: sharedMemory,
          batchSize: 12,
          translateBatch: batchFn,
          onPartial: opts.onPartial,
          onProgress: opts.onProgress,
        });
        return {
          text: result.text,
          from,
          to,
          sentences: result.sentences,
        };
      } catch (err) {
        if (err instanceof SupersededError || err instanceof CancelledError) {
          throw err;
        }
        if (err && typeof err === 'object' && 'name' in err) {
          const name = String(err.name);
          if (name === 'SupersededError' || name === 'CancelledError' || name === 'AbortError') {
            throw err;
          }
        }
        throw err;
      }
    },

    /**
     * Prefetch a language pair into memory without showing output.
     * @param {string} from
     * @param {string} to
     * @param {(ev: import('./types.js').ProgressEvent) => void} [onProgress]
     */
    async prefetch(from, to, onProgress) {
      const t = await ensureTranslator(onProgress);
      onProgress?.({ status: 'loading', progress: 0.4, file: `${from}${to}` });
      const keep = [pairKey(from, to)];
      if (from !== 'en' && to !== 'en') {
        keep.push(pairKey(from, 'en'), pairKey('en', to));
      }
      await pruneModels(t, keep);
      await t.translate({ from, to, text: '.', html: false });
      loadedPairs.add(pairKey(from, to));
      if (from !== 'en' && to !== 'en') {
        loadedPairs.add(pairKey(from, 'en'));
        loadedPairs.add(pairKey('en', to));
      }
      for (const key of keep) {
        const [kf, kt] = key.split('|');
        dropPairBuffers(t, kf, kt);
      }
      // Prefetch swap direction into Cache Storage only (no second WASM model).
      if (from !== to) {
        warmPairCache(t, to, from).catch(() => {});
      }
      lastFrom = from;
      lastTo = to;
      onProgress?.({ status: 'ready', progress: 1, file: `${from}${to}` });
    },

    /**
     * @returns {{from:string,to:string}}
     */
    lastPair() {
      return { from: lastFrom, to: lastTo };
    },

    dispose() {
      const t = translator;
      translator = null;
      boot = null;
      lastFrom = '';
      lastTo = '';
      loadedPairs.clear();
      sharedMemory.clear();
      if (t) {
        t.delete().catch(() => {});
      }
    },
  };
}
