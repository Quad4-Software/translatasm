/**
 * Right-side dictionary sidebar (non-modal popout).
 */

import { loadDictRegistry } from './registry.js';
import { lookupWord } from './lookup.js';
import {
  exportVocab,
  importVocab,
  listDueVocab,
  listVocab,
  removeVocab,
  saveVocab,
  scheduleReview,
  vocabToCsv,
} from './vocab.js';
import {
  exportGlossary,
  importGlossary,
  listGlossary,
  removeGlossary,
  saveGlossary,
} from './glossary.js';
import { downloadText } from '../ui/files.js';

/**
 * @param {{
 *   root: HTMLElement,
 *   getPair: () => {from: string, to: string},
 *   onStatus?: (msg: string) => void,
 *   onGlossaryChange?: () => void,
 * }} opts
 */
export function mountDictDrawer(opts) {
  const { root, getPair, onStatus, onGlossaryChange } = opts;
  /** @type {import('./registry.js').DictRegistry | null} */
  let registry = null;
  /** @type {import('./lookup.js').DictResult | null} */
  let lastResult = null;
  let open = false;
  /** @type {import('./vocab.js').VocabEntry[]} */
  let reviewQueue = [];
  let reviewIndex = 0;

  const toggle = /** @type {HTMLButtonElement} */ (
    document.querySelector('[data-dict-toggle]') || root.querySelector('[data-dict-toggle]')
  );
  const panel = /** @type {HTMLElement} */ (root.querySelector('[data-dict-panel]'));
  const form = /** @type {HTMLFormElement} */ (root.querySelector('[data-dict-form]'));
  const input = /** @type {HTMLInputElement} */ (root.querySelector('[data-dict-input]'));
  const statusEl = /** @type {HTMLElement} */ (root.querySelector('[data-dict-status]'));
  const packsEl = /** @type {HTMLElement | null} */ (root.querySelector('[data-dict-packs]'));
  const resultEl = /** @type {HTMLElement} */ (root.querySelector('[data-dict-result]'));
  const vocabEl = /** @type {HTMLElement} */ (root.querySelector('[data-dict-vocab]'));
  const saveBtn = /** @type {HTMLButtonElement | null} */ (root.querySelector('[data-dict-save]'));
  const attrEl = /** @type {HTMLElement | null} */ (root.querySelector('[data-dict-attr]'));

  const glossForm = /** @type {HTMLFormElement | null} */ (root.querySelector('[data-gloss-form]'));
  const glossSource = /** @type {HTMLInputElement | null} */ (root.querySelector('[data-gloss-source]'));
  const glossTarget = /** @type {HTMLInputElement | null} */ (root.querySelector('[data-gloss-target]'));
  const glossList = /** @type {HTMLElement | null} */ (root.querySelector('[data-gloss-list]'));

  loadDictRegistry()
    .then((reg) => {
      registry = reg;
      if (attrEl) {
        attrEl.textContent = (reg.attribution || []).join(' · ');
      }
      renderPackSummary(reg);
    })
    .catch((err) => {
      setStatus(err && err.message ? err.message : String(err));
    });

  toggle?.addEventListener('click', () => {
    setOpen(!open);
    if (open) {
      input.focus();
      refreshGloss().catch(() => {});
    }
  });
  root.querySelectorAll('[data-dict-close]').forEach((el) => {
    el.addEventListener('click', () => setOpen(false));
  });
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

  root.querySelector('[data-vocab-export]')?.addEventListener('click', () => {
    exportVocab()
      .then((rows) => {
        downloadText('translatasm-vocab.json', JSON.stringify(rows, null, 2), 'application/json');
        downloadText('translatasm-vocab.csv', vocabToCsv(rows), 'text/csv;charset=utf-8');
        setStatus('Exported vocab.');
      })
      .catch(showErr);
  });

  const vocabFile = /** @type {HTMLInputElement | null} */ (root.querySelector('[data-vocab-file]'));
  root.querySelector('[data-vocab-import]')?.addEventListener('click', () => vocabFile?.click());
  vocabFile?.addEventListener('change', () => {
    const file = vocabFile.files && vocabFile.files[0];
    if (!file) {
      return;
    }
    file
      .text()
      .then(async (raw) => {
        const rows = JSON.parse(raw);
        const n = await importVocab(rows);
        setStatus(`Imported ${n} vocab entries.`);
        await refreshVocab();
      })
      .catch(showErr);
    vocabFile.value = '';
  });

  const reviewPanel = /** @type {HTMLElement | null} */ (root.querySelector('[data-vocab-review-panel]'));
  const reviewPrompt = /** @type {HTMLElement | null} */ (root.querySelector('[data-review-prompt]'));
  const reviewAnswer = /** @type {HTMLElement | null} */ (root.querySelector('[data-review-answer]'));
  const reviewShow = /** @type {HTMLButtonElement | null} */ (root.querySelector('[data-review-show]'));
  const reviewAgain = /** @type {HTMLButtonElement | null} */ (root.querySelector('[data-review-again]'));
  const reviewGood = /** @type {HTMLButtonElement | null} */ (root.querySelector('[data-review-good]'));

  root.querySelector('[data-vocab-review]')?.addEventListener('click', () => {
    startReview().catch(showErr);
  });
  reviewShow?.addEventListener('click', () => {
    if (reviewAnswer) {
      reviewAnswer.hidden = false;
    }
    if (reviewAgain) {
      reviewAgain.disabled = false;
    }
    if (reviewGood) {
      reviewGood.disabled = false;
    }
  });
  reviewAgain?.addEventListener('click', () => gradeReview(0).catch(showErr));
  reviewGood?.addEventListener('click', () => gradeReview(1).catch(showErr));

  glossForm?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const pair = getPair();
    saveGlossary({
      from: pair.from,
      to: pair.to,
      source: glossSource?.value || '',
      target: glossTarget?.value || '',
    })
      .then(() => {
        if (glossSource) {
          glossSource.value = '';
        }
        if (glossTarget) {
          glossTarget.value = '';
        }
        setStatus('Glossary term saved.');
        onGlossaryChange?.();
        return refreshGloss();
      })
      .catch(showErr);
  });

  glossList?.addEventListener('click', (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target);
    const btn = t.closest('[data-gloss-del]');
    if (!btn) {
      return;
    }
    const id = Number(btn.getAttribute('data-gloss-del'));
    removeGlossary(id)
      .then(() => {
        onGlossaryChange?.();
        return refreshGloss();
      })
      .catch(showErr);
  });

  root.querySelector('[data-gloss-export]')?.addEventListener('click', () => {
    exportGlossary()
      .then((rows) => {
        downloadText('translatasm-glossary.json', JSON.stringify(rows, null, 2), 'application/json');
        setStatus('Exported glossary.');
      })
      .catch(showErr);
  });
  const glossFile = /** @type {HTMLInputElement | null} */ (root.querySelector('[data-gloss-file]'));
  root.querySelector('[data-gloss-import]')?.addEventListener('click', () => glossFile?.click());
  glossFile?.addEventListener('change', () => {
    const file = glossFile.files && glossFile.files[0];
    if (!file) {
      return;
    }
    file
      .text()
      .then(async (raw) => {
        const n = await importGlossary(JSON.parse(raw));
        setStatus(`Imported ${n} glossary terms.`);
        onGlossaryChange?.();
        await refreshGloss();
      })
      .catch(showErr);
    glossFile.value = '';
  });

  refreshVocab().catch(() => {});
  refreshGloss().catch(() => {});

  /**
   * @param {boolean} next
   */
  function setOpen(next) {
    open = next;
    root.classList.toggle('is-open', open);
    document.body.classList.toggle('dict-sidebar-open', open);
    panel.hidden = false;
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    toggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
    const scrim = /** @type {HTMLElement | null} */ (root.querySelector('.dict-scrim'));
    if (scrim) {
      scrim.hidden = !open;
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
      renderPackSummary(registry);
    }
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
      setStatus('Caching dictionary pack… connect once if offline.');
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
      parts.push(
        '<p class="dict-miss">Dictionary pack not downloaded yet. Connect once to cache this language.</p>',
      );
    } else if (!result.senses?.length && !result.glosses?.length) {
      parts.push(`<p class="dict-miss">${escapeHtml(result.status || 'No entry found.')}</p>`);
    }

    resultEl.innerHTML = parts.join('');
  }

  /**
   * @param {import('./registry.js').DictRegistry} reg
   */
  function renderPackSummary(reg) {
    if (!packsEl) {
      return;
    }
    const mono = Object.values(reg.mono || {});
    const bi = Object.values(reg.bi || {});
    const monoMb = mono.reduce((s, p) => s + (p.size_hint_mb || 0), 0);
    const biMb = bi.reduce((s, p) => s + (p.size_hint_mb || 0), 0);
    packsEl.textContent = `${mono.length} mono · ${bi.length} bi packs (~${(monoMb + biMb).toFixed(1)} MB listed). Lazy-load on lookup.`;
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
          )}${row.note ? ` <em>${escapeHtml(row.note)}</em>` : ''}</span><button type="button" class="ghost dict-del" data-vocab-del="${row.id}" aria-label="Remove">x</button></div>`,
      )
      .join('');
  }

  async function refreshGloss() {
    if (!glossList) {
      return;
    }
    const pair = getPair();
    const rows = await listGlossary(pair.from, pair.to);
    if (!rows.length) {
      glossList.innerHTML = '<p class="dict-empty">No glossary terms for this pair.</p>';
      return;
    }
    glossList.innerHTML = rows
      .map(
        (row) =>
          `<div class="dict-vocab-row"><span><strong>${escapeHtml(row.source)}</strong> → ${escapeHtml(
            row.target,
          )}</span><button type="button" class="ghost dict-del" data-gloss-del="${row.id}" aria-label="Remove">x</button></div>`,
      )
      .join('');
  }

  async function startReview() {
    reviewQueue = await listDueVocab(20);
    reviewIndex = 0;
    if (reviewPanel) {
      reviewPanel.hidden = !reviewQueue.length;
    }
    if (!reviewQueue.length) {
      setStatus('Nothing due for review.');
      return;
    }
    showReviewCard();
  }

  function showReviewCard() {
    const card = reviewQueue[reviewIndex];
    if (!card || !reviewPrompt || !reviewAnswer) {
      if (reviewPanel) {
        reviewPanel.hidden = true;
      }
      setStatus('Review done.');
      return;
    }
    if (reviewPanel) {
      reviewPanel.hidden = false;
    }
    reviewPrompt.textContent = `${card.word} (${card.from}→${card.to})`;
    reviewAnswer.textContent = card.gloss || card.note || '(no gloss)';
    reviewAnswer.hidden = true;
    if (reviewAgain) {
      reviewAgain.disabled = true;
    }
    if (reviewGood) {
      reviewGood.disabled = true;
    }
  }

  /**
   * @param {0 | 1} grade
   */
  async function gradeReview(grade) {
    const card = reviewQueue[reviewIndex];
    if (!card) {
      return;
    }
    const next = scheduleReview(card, grade);
    await saveVocab(next);
    reviewIndex += 1;
    await refreshVocab();
    showReviewCard();
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
