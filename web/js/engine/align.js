/**
 * Sentence-level alignment helpers (no Marian word alignments in 0.4.9 JS API).
 */

import { splitSentences } from '../engine/pairs.js';

/**
 * @typedef {{source: string, target: string}} AlignedSentence
 */

const DEFAULT_BATCH = 12;

/**
 * Build aligned sentence pairs by translating sentences in batches.
 * @param {string} text
 * @param {{
 *   from: string,
 *   to: string,
 *   html?: boolean,
 *   batchSize?: number,
 *   translateOne: (sentence: string) => Promise<string>,
 *   translateBatch?: (sentences: string[]) => Promise<string[]>,
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

  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH);
  /** @type {AlignedSentence[]} */
  const sentences = [];

  for (let i = 0; i < sources.length; i += batchSize) {
    if (opts.signal?.aborted) {
      break;
    }
    const batch = sources.slice(i, i + batchSize);
    /** @type {string[]} */
    let targets;
    if (opts.translateBatch) {
      targets = await opts.translateBatch(batch);
    } else if (batch.length === 1) {
      targets = [await opts.translateOne(batch[0])];
    } else {
      const joined = await opts.translateOne(batch.join('\n'));
      const parts = joined.split('\n');
      if (parts.length === batch.length) {
        targets = parts;
      } else {
        targets = [];
        for (const source of batch) {
          if (opts.signal?.aborted) {
            break;
          }
          targets.push(await opts.translateOne(source));
        }
      }
    }
    for (let j = 0; j < batch.length; j += 1) {
      sentences.push({ source: batch[j], target: targets[j] ?? '' });
    }
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
