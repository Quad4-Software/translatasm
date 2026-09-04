/**
 * Right-side dictionary drawer / mobile sheet.
 */

import { loadDictRegistry } from './registry.js';
import { lookupWord } from './lookup.js';
import { listVocab, removeVocab, saveVocab } from './vocab.js';

/**
 * @param {{
 *   root: HTMLElement,
 *   getPair: () => {from: string, to: string},
 *   onStatus?: (msg: string) => void,
 * }} opts
 */
export function mountDictDrawer(opts) {
  const { root, getPair, onStatus } = opts;
  /** @type {import('./registry.js').DictRegistry | null} */
  let registry = null;
  /** @type {import('./lookup.js').DictResult | null} */
  let lastResult = null;
  let open = false;

  const toggle = /** @type {HTMLButtonElement} */ (
    document.querySelector('[data-dict-toggle]') || root.querySelector('[data-dict-toggle]')
  );
  const panel = /** @type {HTMLElement} */ (root.querySelector('[data-dict-panel]'));
  const backdrop = /** @type {HTMLElement | null} */ (root.querySelector('[data-dict-backdrop]'));
  const closeBtn = /** @type {HTMLButtonElement | null} */ (root.querySelector('[data-dict-close]'));
  const form = /** @type {HTMLFormElement} */ (root.querySelector('[data-dict-form]'));
  const input = /** @type {HTMLInputElement} */ (root.querySelector('[data-dict-input]'));
  const statusEl = /** @type {HTMLElement} */ (root.querySelector('[data-dict-status]'));
  const resultEl = /** @type {HTMLElement} */ (root.querySelector('[data-dict-result]'));
  const vocabEl = /** @type {HTMLElement} */ (root.querySelector('[data-dict-vocab]'));
  const saveBtn = /** @type {HTMLButtonElement | null} */ (root.querySelector('[data-dict-save]'));
  const attrEl = /** @type {HTMLElement | null} */ (root.querySelector('[data-dict-attr]'));

  loadDictRegistry()
    .then((reg) => {
      registry = reg;
      if (attrEl) {
        attrEl.textContent = (reg.attribution || []).join(' · ');
      }
    })
    .catch((err) => {
      setStatus(err && err.message ? err.message : String(err));
    });

  toggle?.addEventListener('click', () => {
    setOpen(!open);
    if (open) {
      input.focus();
    }
  });
  closeBtn?.addEventListener('click', () => setOpen(false));
  backdrop?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && open) {
      setOpen(false);
    }
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    lookUp(input.value, 'source').catch(showErr);
  });

  saveBtn?.addEventListener('click', () => {
    saveCurrent().catch(showErr);
  });

  vocabEl.addEventListener('click', (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target);
    const btn = t.closest('[data-vocab-del]');
    if (!btn) {
      return;
    }
    const id = Number(btn.getAttribute('data-vocab-del'));
    removeVocab(id)
      .then(() => refreshVocab())
      .catch(showErr);
  });

  refreshVocab().catch(() => {});

  /**
   * @param {boolean} next
   */
  function setOpen(next) {
    open = next;
    root.classList.toggle('is-open', open);
    panel.hidden = false;
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (backdrop) {
      backdrop.hidden = !open;
    }
  }

  /**
   * @param {string} word
   * @param {'source' | 'target'} pane
   */
  async function lookUp(word, pane) {
    if (!registry) {
      registry = await loadDictRegistry();
      if (attrEl) {
        attrEl.textContent = (registry.attribution || []).join(' · ');
      }
    }
    setOpen(true);
    input.value = word;
    setStatus('Looking up…');
    resultEl.innerHTML = '';
    if (saveBtn) {
      saveBtn.disabled = true;
    }

    const pair = getPair();
    const lang = pane === 'target' ? pair.to : pair.from;
    const glossLang = pane === 'target' ? pair.from : pair.to;

    const result = await lookupWord(registry, word, { lang, glossLang });
    lastResult = result;
    renderResult(result);
    if (result.packMissing) {
      setStatus('Dictionary pack not downloaded yet');
      onStatus?.('Dictionary pack not downloaded yet');
    } else if (result.status) {
      setStatus(result.status);
    } else {
      setStatus(result.stemmed ? `Matched ${result.matched}` : 'Found');
    }
    if (saveBtn) {
      saveBtn.disabled = !(result.word && (result.senses?.length || result.glosses?.length));
    }
  }

  /**
   * @param {import('./lookup.js').DictResult} result
   */
  function renderResult(result) {
    const parts = [];
    parts.push(`<div class="dict-head"><strong>${escapeHtml(result.word || '')}</strong>`);
    if (result.pos) {
      parts.push(`<span class="dict-pos">${escapeHtml(result.pos)}</span>`);
    }
    if (result.ipa) {
      parts.push(`<span class="dict-ipa">${escapeHtml(result.ipa)}</span>`);
    }
    parts.push('</div>');

    if (result.glosses && result.glosses.length) {
      parts.push('<p class="dict-glosses"><span class="dict-label">Gloss</span> ');
      parts.push(escapeHtml(result.glosses.join(' · ')));
      parts.push('</p>');
    }

    if (result.senses && result.senses.length) {
      parts.push('<ol class="dict-senses">');
      for (const sense of result.senses) {
        parts.push('<li>');
        parts.push(`<span>${escapeHtml(sense.g || '')}</span>`);
        if (sense.e) {
          parts.push(`<em class="dict-ex">${escapeHtml(sense.e)}</em>`);
        }
        if (sense.s && sense.s.length) {
          parts.push(`<span class="dict-syn">${escapeHtml(sense.s.join(', '))}</span>`);
        }
        parts.push('</li>');
      }
      parts.push('</ol>');
    }

    if (result.packMissing) {
      parts.push('<p class="dict-miss">Dictionary pack not downloaded yet. Connect once to cache this language.</p>');
    } else if (!result.senses?.length && !result.glosses?.length) {
      parts.push(`<p class="dict-miss">${escapeHtml(result.status || 'No entry found.')}</p>`);
    }

    resultEl.innerHTML = parts.join('');
  }

  async function saveCurrent() {
    if (!lastResult || !lastResult.word) {
      return;
    }
    const pair = getPair();
    const gloss =
      (lastResult.glosses && lastResult.glosses[0]) ||
      (lastResult.senses && lastResult.senses[0] && lastResult.senses[0].g) ||
      '';
    await saveVocab({
      word: lastResult.word,
      from: pair.from,
      to: pair.to,
      gloss,
    });
    setStatus('Saved to vocab.');
    await refreshVocab();
  }

  async function refreshVocab() {
    const rows = await listVocab(30);
    if (!rows.length) {
      vocabEl.innerHTML = '<p class="dict-empty">No saved words yet.</p>';
      return;
    }
    vocabEl.innerHTML = rows
      .map(
        (row) =>
          `<div class="dict-vocab-row"><span><strong>${escapeHtml(row.word)}</strong> ${escapeHtml(
            row.gloss || '',
          )}</span><button type="button" class="ghost dict-del" data-vocab-del="${row.id}" aria-label="Remove">×</button></div>`,
      )
      .join('');
  }

  /**
   * @param {string} msg
   */
  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  /**
   * @param {unknown} err
   */
  function showErr(err) {
    const msg = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
    setStatus(msg);
  }

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    lookUp,
    isOpen: () => open,
  };
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

/**
 * Extract the word under the caret / around a click in a textarea.
 * @param {HTMLTextAreaElement} el
 * @returns {string}
 */
export function wordAtCaret(el) {
  const value = el.value || '';
  let start = el.selectionStart ?? 0;
  let end = el.selectionEnd ?? start;
  if (start !== end) {
    return value.slice(start, end).trim();
  }
  while (start > 0 && /[\p{L}\p{N}'’-]/u.test(value[start - 1])) {
    start -= 1;
  }
  while (end < value.length && /[\p{L}\p{N}'’-]/u.test(value[end])) {
    end += 1;
  }
  return value.slice(start, end).trim();
}
