/**
 * Catalog and routing helpers for Bergamot pairs.
 */

/**
 * @param {{ from: string, to: string }[]} models
 * @param {string} from
 * @param {string} to
 * @returns {{ from: string, to: string } | null}
 */
export function findDirect(models, from, to) {
  return models.find((m) => m.from === from && m.to === to) || null;
}

/**
 * @param {{ from: string, to: string }[]} models
 * @param {string} from
 * @param {string} to
 * @returns {{ from: string, to: string } | null}
 */
export function findReverse(models, from, to) {
  return findDirect(models, to, from);
}

/**
 * Whether from->to is available directly or via English pivot.
 * @param {{ from: string, to: string }[]} models
 * @param {string} from
 * @param {string} to
 * @param {string} [pivot]
 * @returns {boolean}
 */
export function canTranslate(models, from, to, pivot = 'en') {
  if (!from || !to || from === to) {
    return false;
  }
  if (findDirect(models, from, to)) {
    return true;
  }
  return Boolean(findDirect(models, from, pivot) && findDirect(models, pivot, to));
}

/**
 * @param {string} code
 * @param {Record<string, string> | Array<{code:string,label:string}>} names
 * @returns {string}
 */
export function languageLabel(code, names) {
  if (Array.isArray(names)) {
    const hit = names.find((n) => n.code === code);
    return hit ? hit.label : code;
  }
  return names[code] || code;
}

/**
 * Split plain text into sentences (Latin + common CJK punctuation).
 * @param {string} text
 * @param {{lang?: string}} [opts]
 * @returns {string[]}
 */
export function splitSentences(text, opts = {}) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return [];
  }
  if (opts.lang && typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      const seg = new Intl.Segmenter(opts.lang, { granularity: 'sentence' });
      const parts = [...seg.segment(normalized)].map((s) => s.segment.trim()).filter(Boolean);
      if (parts.length) {
        return parts;
      }
    } catch {
      // fall through
    }
  }
  const re = /[^.!?…。！？]+[.!?…。！？]+(?:\s+|$)|[^.!?…。！？]+$/g;
  return normalized.match(re)?.map((s) => s.trim()).filter(Boolean) || [normalized];
}

/**
 * Split text into translation chunks. Prefer blank-line paragraphs,
 * then sentence breaks for oversized blocks.
 * @param {string} text
 * @param {number} [maxChars]
 * @param {{html?: boolean, lang?: string}} [opts]
 * @returns {string[]}
 */
export function splitChunks(text, maxChars = 900, opts = {}) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return [];
  }

  if (opts.html) {
    return splitHtmlChunks(normalized, maxChars);
  }

  const paragraphs = normalized.split(/\n{2,}/);
  /** @type {string[]} */
  const out = [];

  for (const para of paragraphs) {
    const block = para.trim();
    if (!block) {
      continue;
    }
    if (block.length <= maxChars) {
      out.push(block);
      continue;
    }
    const sentences = splitSentences(block, { lang: opts.lang });
    let buf = '';
    for (const sentence of sentences) {
      const piece = sentence.trim();
      if (!piece) {
        continue;
      }
      if (!buf) {
        buf = piece;
        continue;
      }
      if ((buf + ' ' + piece).length <= maxChars) {
        buf = `${buf} ${piece}`;
      } else {
        out.push(buf);
        buf = piece;
      }
    }
    if (buf) {
      out.push(buf);
    }
  }

  return out.length ? out : [normalized];
}

/**
 * Paragraph-only splits so HTML tags are not cut mid-element.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
function splitHtmlChunks(text, maxChars) {
  if (text.length <= maxChars) {
    return [text];
  }
  const parts = text.split(/(?=<\/p>)|(?<=<\/p>)|\n{2,}/i).filter((p) => p.length);
  /** @type {string[]} */
  const out = [];
  let buf = '';
  for (const part of parts) {
    if (!buf) {
      buf = part;
      continue;
    }
    if ((buf + part).length <= maxChars) {
      buf += part;
    } else {
      out.push(buf);
      buf = part;
    }
  }
  if (buf) {
    out.push(buf);
  }
  return out.length ? out : [text];
}
