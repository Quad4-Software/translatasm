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
      cacheSize: safe.cacheSize ?? 131072,
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
        cacheSize: 131072,
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
   * Drop WASM models that are not the active route to keep heap small.
   * @param {LatencyOptimisedTranslator} t
   * @param {string[]} keep
   */
  async function pruneModels(t, keep) {
    const keepSet = new Set(keep);
    const worker = await t.worker;
    const exports = worker?.exports;
    if (!exports || typeof exports.freeTranslationModel !== 'function') {
      return;
    }
    for (const key of [...loadedPairs]) {
      if (keepSet.has(key)) {
        continue;
      }
      const [from, to] = key.split('|');
      try {
        await exports.freeTranslationModel({ from, to });
        loadedPairs.delete(key);
      } catch {
        // ignore prune failures
      }
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

      lastFrom = from;
      lastTo = to;

      const chunks = splitChunks(raw, opts.chunkChars ?? 1100);
      /** @type {string[]} */
      const parts = [];
      const total = chunks.length;

      for (let i = 0; i < total; i += 1) {
        opts.onProgress?.({
          status: 'translating',
          progress: 0.2 + (0.75 * i) / Math.max(total, 1),
          file: `${from}${to}`,
        });
        try {
          const result = await t.translate(
            {
              from,
              to,
              text: chunks[i],
              html: Boolean(opts.html),
            },
            { signal: opts.signal },
          );
          parts.push(result?.target?.text ?? '');
          loadedPairs.add(pairKey(from, to));
          if (from !== 'en' && to !== 'en') {
            loadedPairs.add(pairKey(from, 'en'));
            loadedPairs.add(pairKey('en', to));
          }
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
        if (opts.onPartial) {
          opts.onPartial({ text: parts.join('\n\n'), from, to });
        }
      }

      opts.onProgress?.({ status: 'done', progress: 1 });
      return {
        text: parts.join('\n\n'),
        from,
        to,
      };
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
      // Warm reverse pack in the background for swap.
      if (from !== to) {
        t.translate({ from: to, to: from, text: '.', html: false })
          .then(() => {
            loadedPairs.add(pairKey(to, from));
          })
          .catch(() => {});
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
      if (t) {
        t.delete().catch(() => {});
      }
    },
  };
}
