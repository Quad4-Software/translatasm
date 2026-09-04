/**
 * Firefox Bergamot WASM 2.x adapter hook.
 * npm @browsermt/bergamot-translator@0.4.9 cannot load Firefox Remote Settings WASM as-is.
 * CJK packs (zh/ja) require WASM 2.x + Intl.Segmenter (see segment.js / bergamot.js).
 * Fetch artifacts with: bash scripts/fetch-firefox-wasm.sh and TRANSLATASM_CJK=1 make assets
 */

export { createBergamotEngine as createFirefoxBergamotEngine, hasNativeIntGemm } from './bergamot.js';
export { needsCjkSegmentation, segmentSentences } from './segment.js';

/**
 * @returns {boolean}
 */
export function firefoxWasmPresent() {
  return false;
}
