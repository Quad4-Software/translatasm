/**
 * Sentence-level alignment helpers (no Marian word alignments in 0.4.9 JS API).
 */

import { splitSentences } from '../engine/pairs.js';

/**
 * @typedef {{source: string, target: string}} AlignedSentence
 */

/**
 * Build aligned sentence pairs by translating each sentence separately.
 * @param {string} text
 * @param {{
 *   from: string,
 *   to: string,
 *   html?: boolean,
 *   translateOne: (sentence: string) => Promise<string>,
 *   onPartial?: (sentences: AlignedSentence[]) => void,
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<{text: string, sentences: AlignedSentence[]}>}
 */
export async function translateAligned(text, opts) {
  if (opts.html) {
    const out = await opts.translateOne(text);
    return { text: out, sentences: [{ source: text, target: out }] };
  }
  const sources = splitSentences(text, { lang: opts.from });
  if (!sources.length) {
    return { text: '', sentences: [] };
  }
  if (sources.length > 80) {
    const out = await opts.translateOne(text);
    return { text: out, sentences: [{ source: text, target: out }] };
  }

  /** @type {AlignedSentence[]} */
  const sentences = [];
  for (const source of sources) {
    if (opts.signal?.aborted) {
      break;
    }
    const target = await opts.translateOne(source);
    sentences.push({ source, target });
    opts.onPartial?.(sentences);
  }
  return {
    text: sentences.map((s) => s.target).join(' '),
    sentences,
  };
}

/**
 * @param {AlignedSentence[]} sentences
 * @param {number} index
 * @returns {{source: string, target: string} | null}
 */
export function peerAt(sentences, index) {
  if (!sentences || index < 0 || index >= sentences.length) {
    return null;
  }
  return sentences[index];
}

/**
 * Render sentences as clickable spans (escaped).
 * @param {AlignedSentence[]} sentences
 * @param {'source' | 'target'} side
 * @param {number} [active]
 * @returns {string}
 */
export function renderAlignHtml(sentences, side, active = -1) {
  return sentences
    .map((s, i) => {
      const text = escapeHtml(side === 'source' ? s.source : s.target);
      const cls = i === active ? 'align-sent is-active' : 'align-sent';
      return `<span class="${cls}" data-align-i="${i}" tabindex="0">${text}</span>`;
    })
    .join(' ');
}

/**
 * @param {string} s
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
