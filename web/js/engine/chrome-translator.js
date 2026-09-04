/**
 * Chromium built-in Translator API adapter (Chrome 138+ / Edge desktop).
 * Progressive enhancement only. Callers must fall back to Bergamot.
 */

import { sharedMemory, translateIncremental } from './incremental.js';

/**
 * @returns {boolean}
 */
export function hasChromeTranslator() {
  return typeof globalThis.Translator !== 'undefined';
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {Promise<'available' | 'downloadable' | 'downloading' | 'unavailable'>}
 */
export async function chromeTranslatorAvailability(from, to) {
  if (!hasChromeTranslator()) {
    return 'unavailable';
  }
  try {
    const Translator = globalThis.Translator;
    if (typeof Translator.availability !== 'function') {
      return 'unavailable';
    }
    const status = await Translator.availability({
      sourceLanguage: from,
      targetLanguage: to,
    });
    if (status === 'available' || status === 'readily') {
      return 'available';
    }
    if (status === 'downloadable' || status === 'after-download') {
      return 'downloadable';
    }
    if (status === 'downloading') {
      return 'downloading';
    }
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * @returns {import('./types.js').Engine & {
 *   canHandle: (from: string, to: string) => Promise<boolean>,
 * }}
 */
export function createChromeTranslatorEngine() {
  /** @type {Map<string, Promise<any>>} */
  const translators = new Map();
  /** @type {string} */
  let lastFrom = '';
  /** @type {string} */
  let lastTo = '';

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
   * @param {(ev: import('./types.js').ProgressEvent) => void} [onProgress]
   */
  async function ensurePair(from, to, onProgress) {
    const key = pairKey(from, to);
    let pending = translators.get(key);
    if (!pending) {
      pending = (async () => {
        const Translator = globalThis.Translator;
        const availability = await chromeTranslatorAvailability(from, to);
        if (availability === 'unavailable') {
          throw new Error(`Chrome Translator unavailable for ${from}->${to}`);
        }
        onProgress?.({ status: 'loading', progress: 0.4, file: `${from}${to}` });
        const translator = await Translator.create({
          sourceLanguage: from,
          targetLanguage: to,
          monitor(m) {
            m.addEventListener('downloadprogress', (ev) => {
              const loaded = typeof ev.loaded === 'number' ? ev.loaded : 0;
              onProgress?.({
                status: 'loading',
                progress: 0.4 + loaded * 0.5,
                file: `${from}${to}`,
              });
            });
          },
        });
        onProgress?.({ status: 'ready', progress: 1, file: `${from}${to}` });
        return translator;
      })();
      translators.set(key, pending);
      pending.catch(() => {
        translators.delete(key);
      });
    }
    return pending;
  }

  /**
   * @param {string} from
   * @param {string} to
   * @param {string} text
   * @param {AbortSignal} [signal]
   */
  async function translateRaw(from, to, text, signal) {
    const translator = await ensurePair(from, to);
    if (signal?.aborted) {
      const err = new Error('Translation cancelled');
      err.name = 'CancelledError';
      throw err;
    }
    if (typeof translator.translateStreaming === 'function' && text.length > 800) {
      const stream = translator.translateStreaming(text);
      let out = '';
      for await (const chunk of stream) {
        if (signal?.aborted) {
          const err = new Error('Translation cancelled');
          err.name = 'CancelledError';
          throw err;
        }
        out += chunk;
      }
      return out;
    }
    return translator.translate(text);
  }

  return {
    id: 'chrome-translator',

    /**
     * @param {string} from
     * @param {string} to
     * @returns {Promise<boolean>}
     */
    async canHandle(from, to) {
      if (!from || !to || from === to) {
        return false;
      }
      const status = await chromeTranslatorAvailability(from, to);
      return status === 'available' || status === 'downloadable' || status === 'downloading';
    },

    async load(_model, onProgress) {
      if (!hasChromeTranslator()) {
        onProgress?.({ status: 'ready', progress: 1 });
        return;
      }
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
      if (opts.html) {
        throw new Error('Chrome Translator does not support HTML mode.');
      }

      const raw = String(text ?? '');
      if (!raw.trim()) {
        return { text: '', from, to };
      }

      if (lastFrom && lastTo && (lastFrom !== from || lastTo !== to)) {
        sharedMemory.clearPair(lastFrom, lastTo);
      }
      lastFrom = from;
      lastTo = to;

      if (opts.incremental === false) {
        opts.onProgress?.({ status: 'translating', progress: 0.4, file: `${from}${to}` });
        const out = await translateRaw(from, to, raw, opts.signal);
        opts.onPartial?.({ text: out, from, to });
        opts.onProgress?.({ status: 'done', progress: 1 });
        return { text: out, from, to };
      }

      /**
       * @param {string[]} sentences
       * @param {AbortSignal} [signal]
       */
      async function batchFn(sentences, signal) {
        if (sentences.length === 1) {
          return [await translateRaw(from, to, sentences[0], signal)];
        }
        try {
          const joined = await translateRaw(from, to, sentences.join('\n'), signal);
          const parts = joined.split('\n');
          if (parts.length === sentences.length) {
            return parts;
          }
        } catch (err) {
          if (err && typeof err === 'object' && 'name' in err) {
            const name = String(err.name);
            if (name === 'CancelledError' || name === 'AbortError') {
              throw err;
            }
          }
        }
        /** @type {string[]} */
        const out = [];
        for (const sentence of sentences) {
          out.push(await translateRaw(from, to, sentence, signal));
        }
        return out;
      }

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
    },

    async prefetch(from, to, onProgress) {
      if (!(await this.canHandle(from, to))) {
        return;
      }
      await ensurePair(from, to, onProgress);
      lastFrom = from;
      lastTo = to;
    },

    dispose() {
      for (const pending of translators.values()) {
        pending
          .then((t) => {
            if (t && typeof t.destroy === 'function') {
              t.destroy();
            }
          })
          .catch(() => {});
      }
      translators.clear();
      lastFrom = '';
      lastTo = '';
    },
  };
}
