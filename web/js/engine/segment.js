/**
 * Sentence pre-segmentation for CJK and other scripts via Intl.Segmenter.
 */

/**
 * @param {string} text
 * @param {string} [lang]
 * @returns {string[]}
 */
export function segmentSentences(text, lang) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return [];
  }
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      const locale = lang && lang !== 'auto' ? lang : undefined;
      const seg = new Intl.Segmenter(locale, { granularity: 'sentence' });
      const parts = [...seg.segment(normalized)].map((s) => s.segment.trim()).filter(Boolean);
      if (parts.length) {
        return parts;
      }
    } catch {
      // fall through
    }
  }
  return normalized.match(/[^.!?…。！？]+[.!?…。！？]+(?:\s+|$)|[^.!?…。！？]+$/g)?.map((s) => s.trim()).filter(Boolean) || [
    normalized,
  ];
}

/**
 * Languages that need explicit segmentation before Marian (CJK).
 * @param {string} lang
 * @returns {boolean}
 */
export function needsCjkSegmentation(lang) {
  const c = String(lang || '').toLowerCase().split('-')[0];
  return c === 'zh' || c === 'ja' || c === 'ko';
}
