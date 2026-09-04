/**
 * Prefer Chromium Translator when ready, else Bergamot.
 */

import { createBergamotEngine } from './bergamot.js';
import { createChromeTranslatorEngine, hasChromeTranslator } from './chrome-translator.js';

/**
 * @returns {import('./types.js').Engine}
 */
export function createFastPathEngine() {
  const bergamot = createBergamotEngine();
  const chrome = hasChromeTranslator() ? createChromeTranslatorEngine() : null;
  /** @type {Map<string, boolean>} */
  const chromeReady = new Map();

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
   * @returns {Promise<boolean>}
   */
  async function useChrome(from, to) {
    if (!chrome) {
      return false;
    }
    const key = pairKey(from, to);
    if (chromeReady.has(key)) {
      return Boolean(chromeReady.get(key));
    }
    const ok = await chrome.canHandle(from, to);
    chromeReady.set(key, ok);
    return ok;
  }

  return {
    id: 'fast-path',

    async load(model, onProgress) {
      await bergamot.load(model, onProgress);
      if (chrome) {
        await chrome.load(model, onProgress).catch(() => {});
      }
    },

    /**
     * @param {string} text
     * @param {import('./types.js').TranslateOptions} [opts]
     */
    async translate(text, opts = {}) {
      const from = opts.from || '';
      const to = opts.to || '';
      if (!opts.html && chrome && (await useChrome(from, to))) {
        try {
          return await chrome.translate(text, opts);
        } catch (err) {
          if (err && typeof err === 'object' && 'name' in err) {
            const name = String(err.name);
            if (name === 'CancelledError' || name === 'SupersededError' || name === 'AbortError') {
              throw err;
            }
          }
          chromeReady.set(pairKey(from, to), false);
        }
      }
      return bergamot.translate(text, opts);
    },

    async prefetch(from, to, onProgress) {
      const tasks = [];
      if (bergamot.prefetch) {
        tasks.push(bergamot.prefetch(from, to, onProgress));
      }
      if (chrome) {
        tasks.push(
          chrome.prefetch(from, to).then(() => {
            chromeReady.set(pairKey(from, to), true);
          }).catch(() => {
            chromeReady.set(pairKey(from, to), false);
          }),
        );
      }
      await Promise.all(tasks);
    },

    dispose() {
      bergamot.dispose();
      chrome?.dispose();
      chromeReady.clear();
    },
  };
}
