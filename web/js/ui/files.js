/**
 * File drop helpers for .txt / .md / .srt translation workflows.
 */

export const MAX_FILE_BYTES = 1.5 * 1024 * 1024;

/**
 * @param {string} name
 * @returns {'txt' | 'md' | 'srt' | null}
 */
export function fileKind(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.srt')) {
    return 'srt';
  }
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return 'md';
  }
  if (lower.endsWith('.txt') || lower.endsWith('.text')) {
    return 'txt';
  }
  return null;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeHtml(text) {
  return /<[a-z][\s\S]*>/i.test(String(text || '').slice(0, 8000));
}

/**
 * @param {File} file
 * @returns {Promise<string>}
 */
export async function readTextFile(file) {
  if (!file) {
    throw new Error('No file selected.');
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`File too large (max ${Math.round(MAX_FILE_BYTES / (1024 * 1024) * 10) / 10} MB).`);
  }
  const kind = fileKind(file.name);
  if (!kind) {
    throw new Error('Supported files: .txt, .md, .srt');
  }
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (looksBinary(bytes)) {
    throw new Error('File looks binary. Use a text file.');
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function looksBinary(bytes) {
  const n = Math.min(bytes.length, 512);
  let weird = 0;
  for (let i = 0; i < n; i += 1) {
    const b = bytes[i];
    if (b === 0) {
      return true;
    }
    if (b < 7 || (b > 14 && b < 32 && b !== 9 && b !== 10 && b !== 13)) {
      weird += 1;
    }
  }
  return weird > n * 0.3;
}

/**
 * @typedef {{index: number, start: string, end: string, text: string}} SrtCue
 */

/**
 * @param {string} raw
 * @returns {SrtCue[]}
 */
export function parseSrt(raw) {
  const normalized = String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!normalized) {
    return [];
  }
  const blocks = normalized.split(/\n{2,}/);
  /** @type {SrtCue[]} */
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trimEnd());
    if (lines.length < 2) {
      continue;
    }
    let i = 0;
    let index = cues.length + 1;
    if (/^\d+$/.test(lines[0].trim())) {
      index = Number(lines[0].trim());
      i = 1;
    }
    const timing = lines[i] || '';
    const m = timing.match(
      /^(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/,
    );
    if (!m) {
      continue;
    }
    const text = lines.slice(i + 1).join('\n').trim();
    cues.push({
      index,
      start: m[1].replace('.', ','),
      end: m[2].replace('.', ','),
      text,
    });
  }
  return cues;
}

/**
 * @param {SrtCue[]} cues
 * @returns {string}
 */
export function serializeSrt(cues) {
  return cues
    .map((c, i) => `${c.index || i + 1}\n${c.start} --> ${c.end}\n${c.text}`)
    .join('\n\n')
    .concat(cues.length ? '\n' : '');
}

/**
 * Trigger a browser download for text content.
 * @param {string} filename
 * @param {string} body
 * @param {string} [mime]
 */
export function downloadText(filename, body, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Split HTML-ish text on paragraph boundaries only (never mid-tag).
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string[]}
 */
export function splitHtmlSafe(text, maxChars = 4000) {
  const raw = String(text ?? '').trim();
  if (!raw) {
    return [];
  }
  if (raw.length <= maxChars) {
    return [raw];
  }
  const parts = raw.split(/(?=<\/p>)|(?<=<\/p>)|\n{2,}/i).filter((p) => p.trim());
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
  return out.length ? out : [raw];
}
