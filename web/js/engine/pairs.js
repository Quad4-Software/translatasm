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
 * Split text into translation chunks. Prefer blank-line paragraphs,
 * then sentence breaks for oversized blocks.
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string[]}
 */
export function splitChunks(text, maxChars = 900) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return [];
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
    const sentences = block.match(/[^.!?…]+[.!?…]+(?:\s+|$)|[^.!?…]+$/g) || [block];
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
