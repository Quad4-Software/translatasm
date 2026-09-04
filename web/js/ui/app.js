import { createEngine, registerEngine } from '../engine/registry.js';
import { createBergamotEngine, hasNativeIntGemm } from '../engine/bergamot.js';
import { canTranslate, findDirect, languageLabel } from '../engine/pairs.js';
import { translateAligned, renderAlignHtml } from '../engine/align.js';
import {
  classifyLiveChange,
  openSentenceDebounceMs,
  sharedMemory,
} from '../engine/incremental.js';
import { mountDictDrawer } from '../dict/drawer.js';
import { listGlossary, protectTerms, restoreTerms } from '../dict/glossary.js';
import { parseUrlState, syncUrlState } from './urlstate.js';
import { detectLanguage, detectDebounceMs, warmDetector } from '../detect/langdetect.js';
import {
  downloadText,
  fileKind,
  looksLikeHtml,
  parseSrt,
  readTextFile,
  serializeSrt,
} from './files.js';

registerEngine('bergamot', createBergamotEngine);

const STORAGE_KEY = 'translatasm.prefs.v1';
const LIVE_DEBOUNCE_MIN_MS = 70;
const LIVE_DEBOUNCE_MAX_MS = 160;
const FINISHED_FLUSH_MS = 16;
const SRT_BATCH = 12;
const AUTO_VALUE = 'auto';

/**
 * @param {number} len
 */
function liveDebounceMs(len) {
  if (len < 80) {
    return LIVE_DEBOUNCE_MIN_MS;
  }
  if (len > 600) {
    return LIVE_DEBOUNCE_MAX_MS;
  }
  return Math.round(LIVE_DEBOUNCE_MIN_MS + ((len - 80) / 520) * (LIVE_DEBOUNCE_MAX_MS - LIVE_DEBOUNCE_MIN_MS));
}

/**
 * @returns {Promise<void>}
 */
export async function bootApp() {
  const els = {
    from: /** @type {HTMLSelectElement} */ (document.getElementById('from')),
    to: /** @type {HTMLSelectElement} */ (document.getElementById('to')),
    source: /** @type {HTMLTextAreaElement} */ (document.getElementById('source')),
    target: /** @type {HTMLTextAreaElement} */ (document.getElementById('target')),
    sourceAlign: /** @type {HTMLElement} */ (document.getElementById('source-align')),
    targetAlign: /** @type {HTMLElement} */ (document.getElementById('target-align')),
    pairGrid: /** @type {HTMLElement} */ (document.getElementById('pair-grid')),
    sourceLabel: document.getElementById('source-label'),
    targetLabel: document.getElementById('target-label'),
    sourceCount: document.getElementById('source-count'),
    latency: document.getElementById('latency'),
    status: document.getElementById('status'),
    route: document.getElementById('route'),
    error: document.getElementById('error'),
    spinner: document.getElementById('spinner'),
    progressTrack: document.querySelector('.progress-track'),
    progress: document.getElementById('progress'),
    btnTranslate: /** @type {HTMLButtonElement} */ (document.getElementById('btn-translate')),
    btnCopy: /** @type {HTMLButtonElement} */ (document.getElementById('btn-copy')),
    btnLink: /** @type {HTMLButtonElement} */ (document.getElementById('btn-link')),
    btnClear: /** @type {HTMLButtonElement} */ (document.getElementById('btn-clear')),
    btnSwap: /** @type {HTMLButtonElement} */ (document.getElementById('btn-swap')),
    btnFile: /** @type {HTMLButtonElement} */ (document.getElementById('btn-file')),
    btnDownload: /** @type {HTMLButtonElement} */ (document.getElementById('btn-download')),
    btnDict: /** @type {HTMLButtonElement} */ (document.getElementById('btn-dict')),
    btnMore: /** @type {HTMLButtonElement | null} */ (document.getElementById('btn-more')),
    moreSheet: /** @type {HTMLElement | null} */ (document.getElementById('more-sheet')),
    paneTabs: /** @type {HTMLElement | null} */ (document.querySelector('.pane-tabs')),
    ctaRow: /** @type {HTMLElement | null} */ (document.getElementById('cta-row')),
    fileInput: /** @type {HTMLInputElement} */ (document.getElementById('file-input')),
    optAuto: /** @type {HTMLInputElement} */ (document.getElementById('opt-auto')),
    optHtml: /** @type {HTMLInputElement} */ (document.getElementById('opt-html')),
    optAlign: /** @type {HTMLInputElement} */ (document.getElementById('opt-align')),
  };

  /** @type {import('../engine/types.js').ModelInfo[]} */
  let models = [];
  /** @type {import('../engine/types.js').LanguageInfo[]} */
  let languages = [];
  let pivot = 'en';
  /** @type {import('../engine/types.js').Engine | null} */
  let engine = null;
  let liveTimer = 0;
  let finishedTimer = 0;
  let detectTimer = 0;
  /** @type {number} */
  let requestSerial = 0;
  /** @type {AbortController | null} */
  let translateAbort = null;
  let ready = false;
  /** @type {string} */
  let resolvedFrom = 'en';
  /** @type {string} */
  let lastLiveSource = '';
  /** @type {{key: string, entries: unknown[]}} */
  let glossaryCache = { key: '', entries: [] };
  /** @type {import('../engine/align.js').AlignedSentence[] | null} */
  let lastSentences = null;
  /** @type {{name: string, kind: string, body: string, translated?: string} | null} */
  let lastFile = null;
  let alignActive = -1;

  const catalog = await fetchCatalog();
  models = catalog.models;
  languages = catalog.languages;
  pivot = catalog.pivot || 'en';
  const catalogCodes = new Set(languages.map((l) => l.code));

  const prefs = loadPrefs();
  const urlState = parseUrlState(location.search, catalogCodes);

  const initialFrom = urlState.from || prefs.from || 'en';
  const initialTo = urlState.to || prefs.to || 'es';
  fillLanguageSelect(els.from, languages, initialFrom, true);
  fillLanguageSelect(els.to, languages, initialTo, false);

  if (urlState.auto != null) {
    els.optAuto.checked = urlState.auto;
  } else if (prefs.autoDetect != null) {
    els.optAuto.checked = Boolean(prefs.autoDetect);
  }
  if (urlState.html != null) {
    els.optHtml.checked = urlState.html;
  } else if (prefs.htmlMode != null) {
    els.optHtml.checked = Boolean(prefs.htmlMode);
  }
  if (urlState.align != null) {
    els.optAlign.checked = urlState.align;
  } else if (prefs.alignMode != null) {
    els.optAlign.checked = Boolean(prefs.alignMode);
  }

  if (els.optAuto.checked) {
    els.from.value = AUTO_VALUE;
  }
  if (els.from.value === els.to.value && els.from.value !== AUTO_VALUE) {
    els.to.value = els.from.value === 'en' ? 'es' : 'en';
  }
  resolvedFrom = els.from.value === AUTO_VALUE ? initialFrom === AUTO_VALUE ? 'en' : initialFrom : els.from.value;
  if (urlState.q) {
    els.source.value = urlState.q;
  }
  refreshLabels();
  updateRoute();
  updateCounts();
  syncShareUrl(false);

  void loadAppVersion();

  engine = createEngine('bergamot');
  setStatus('Starting Bergamot...');
  setBusy(true);
  try {
    await engine.load(models[0], (p) => {
      if (typeof p.progress === 'number') {
        setProgress(p.progress);
      }
    });
    await warmPair(effectiveFrom(), els.to.value);
    ready = true;
    const accel = hasNativeIntGemm() ? 'Firefox native IntGEMM' : 'WASM IntGEMM';
    setStatus(`Ready (${accel}). Type to translate.`);
    warmDetector().catch(() => {});
    if (els.source.value.trim()) {
      lastLiveSource = els.source.value;
      await runTranslate({ quiet: true });
    }
  } catch (err) {
    showError(err);
  } finally {
    setBusy(false);
    hideProgress();
  }

  els.from.addEventListener('change', () => {
    if (els.from.value === AUTO_VALUE) {
      els.optAuto.checked = true;
    } else {
      els.optAuto.checked = false;
      resolvedFrom = els.from.value;
      if (els.from.value === els.to.value) {
        const alt = languages.find((l) => l.code !== els.from.value);
        if (alt) {
          els.to.value = alt.code;
        }
      }
    }
    onPairChanged().catch(showError);
  });
  els.to.addEventListener('change', () => {
    const from = effectiveFrom();
    if (els.to.value === from) {
      const alt = languages.find((l) => l.code !== els.to.value);
      if (alt) {
        if (els.from.value === AUTO_VALUE) {
          resolvedFrom = alt.code;
        } else {
          els.from.value = alt.code;
          resolvedFrom = alt.code;
        }
      }
    }
    onPairChanged().catch(showError);
  });
  els.optAuto.addEventListener('change', () => {
    if (els.optAuto.checked) {
      els.from.value = AUTO_VALUE;
    } else if (els.from.value === AUTO_VALUE) {
      els.from.value = resolvedFrom;
    }
    savePrefs();
    syncShareUrl(true);
    scheduleDetectAndTranslate();
  });
  els.optHtml.addEventListener('change', () => {
    if (els.optHtml.checked) {
      els.optAlign.checked = false;
      hideAlignPanes();
    }
    savePrefs();
    syncShareUrl(true);
    if (ready && els.source.value.trim()) {
      runTranslate({ quiet: true }).catch(showError);
    }
  });
  els.optAlign.addEventListener('change', () => {
    if (els.optAlign.checked) {
      els.optHtml.checked = false;
    } else {
      hideAlignPanes();
    }
    savePrefs();
    syncShareUrl(true);
    if (ready && els.source.value.trim()) {
      runTranslate({ quiet: true }).catch(showError);
    }
  });
  els.btnTranslate.addEventListener('click', () => {
    runTranslate({ force: true }).catch(showError);
  });
  els.btnCopy.addEventListener('click', () => {
    copyTarget().catch(showError);
  });
  els.btnLink.addEventListener('click', () => {
    copyShareLink().catch(showError);
  });
  els.btnClear.addEventListener('click', clearAll);
  els.btnSwap.addEventListener('click', () => {
    swapDirection().catch(showError);
  });
  els.btnFile.addEventListener('click', () => els.fileInput.click());
  els.btnDownload.addEventListener('click', () => {
    downloadResult();
  });
  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files && els.fileInput.files[0];
    if (file) {
      handleFile(file).catch(showError);
    }
    els.fileInput.value = '';
  });

  els.pairGrid.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    els.pairGrid.classList.add('is-drop');
  });
  els.pairGrid.addEventListener('dragleave', () => {
    els.pairGrid.classList.remove('is-drop');
  });
  els.pairGrid.addEventListener('drop', (ev) => {
    ev.preventDefault();
    els.pairGrid.classList.remove('is-drop');
    const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (file) {
      handleFile(file).catch(showError);
    }
  });

  els.source.addEventListener('paste', (ev) => {
    const clip = ev.clipboardData?.getData('text') || '';
    if (looksLikeHtml(clip) && !els.optHtml.checked) {
      els.optHtml.checked = true;
      els.optAlign.checked = false;
      savePrefs();
    }
  });

  els.source.addEventListener('input', () => {
    updateCounts();
    els.btnClear.disabled = !els.source.value && !els.target.value;
    lastFile = null;
    els.btnDownload.disabled = !els.target.value;
    if (!ready) {
      return;
    }
    scheduleDetectAndTranslate();
  });
  els.source.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      runTranslate({ force: true }).catch(showError);
    }
  });

  els.sourceAlign.addEventListener('click', onAlignClick);
  els.targetAlign.addEventListener('click', onAlignClick);

  const mobileChrome = setupMobileChrome(els);

  const dictRoot = document.getElementById('dict-root');
  if (dictRoot) {
    mountDictDrawer({
      root: dictRoot,
      getPair: () => ({ from: effectiveFrom(), to: els.to.value }),
      onStatus: (msg) => setStatus(msg),
      onGlossaryChange: () => {
        glossaryCache = { key: '', entries: [] };
        sharedMemory.clear();
        if (ready && els.source.value.trim()) {
          runTranslate({ quiet: true }).catch(showError);
        }
      },
    });
  }

  function scheduleDetectAndTranslate() {
    window.clearTimeout(liveTimer);
    window.clearTimeout(finishedTimer);
    window.clearTimeout(detectTimer);
    const text = els.source.value;
    if (els.optAuto.checked) {
      detectTimer = window.setTimeout(() => {
        runDetect()
          .then(() => runTranslate({ quiet: true }))
          .catch(showError);
      }, detectDebounceMs(text.length));
      lastLiveSource = text;
      return;
    }

    const htmlMode = els.optHtml.checked;
    const alignMode = els.optAlign.checked && !htmlMode;
    if (htmlMode || alignMode) {
      liveTimer = window.setTimeout(() => {
        runTranslate({ quiet: true }).catch(showError);
      }, liveDebounceMs(text.length));
      lastLiveSource = text;
      return;
    }

    const from = effectiveFrom();
    const change = classifyLiveChange(text, lastLiveSource, from);
    lastLiveSource = text;

    if (change.finishedChanged) {
      finishedTimer = window.setTimeout(() => {
        runTranslate({ quiet: true }).catch(showError);
      }, FINISHED_FLUSH_MS);
    }

    if (change.openChanged || !change.finishedChanged) {
      const openLen =
        change.openIndex >= 0 && change.sources[change.openIndex]
          ? change.sources[change.openIndex].length
          : text.length;
      liveTimer = window.setTimeout(() => {
        runTranslate({ quiet: true }).catch(showError);
      }, openSentenceDebounceMs(openLen));
    }
  }

  /**
   * @param {string} from
   * @param {string} to
   * @returns {Promise<unknown[]>}
   */
  async function getGlossary(from, to) {
    const key = `${from}|${to}`;
    if (glossaryCache.key === key) {
      return glossaryCache.entries;
    }
    const entries = await listGlossary(from, to).catch(() => []);
    glossaryCache = { key, entries };
    return entries;
  }

  /**
   * @returns {Promise<void>}
   */
  async function runDetect() {
    if (!els.optAuto.checked) {
      return;
    }
    const text = els.source.value.trim();
    if (text.length < 8) {
      return;
    }
    const serial = requestSerial;
    const code = await detectLanguage(text, catalogCodes);
    if (serial !== requestSerial) {
      return;
    }
    if (!code || code === els.to.value) {
      return;
    }
    if (code !== resolvedFrom) {
      resolvedFrom = code;
      refreshLabels();
      updateRoute();
      savePrefs();
      syncShareUrl(true);
      await warmPair(resolvedFrom, els.to.value);
      setStatus(`Detected ${languageLabel(code, languages)}.`);
    }
  }

  /**
   * @returns {string}
   */
  function effectiveFrom() {
    if (els.from.value === AUTO_VALUE || els.optAuto.checked) {
      return resolvedFrom;
    }
    return els.from.value;
  }

  /**
   * @param {{quiet?: boolean, force?: boolean}} [mode]
   */
  async function runTranslate(mode = {}) {
    clearError();
    if (!engine || !ready) {
      throw new Error('Translation engine is not ready.');
    }
    const from = effectiveFrom();
    const to = els.to.value;
    const text = els.source.value;
    const htmlMode = els.optHtml.checked;
    const alignMode = els.optAlign.checked && !htmlMode;

    if (!text.trim()) {
      els.target.value = '';
      lastSentences = null;
      hideAlignPanes();
      if (els.latency) {
        els.latency.textContent = '';
      }
      syncShareUrl(true);
      if (!mode.quiet) {
        setStatus('Paste or type some text first.');
      }
      return;
    }
    if (!canTranslate(models, from, to, pivot)) {
      throw new Error(`No path from ${from} to ${to}.`);
    }

    if (translateAbort) {
      translateAbort.abort();
    }
    const ac = new AbortController();
    translateAbort = ac;
    const serial = ++requestSerial;
    const started = performance.now();
    if (!mode.quiet) {
      setBusy(true);
      setProgress(0.25);
      setStatus('Translating...');
    }

    try {
      const glossary = /** @type {import('../dict/glossary.js').GlossaryEntry[]} */ (
        await getGlossary(from, to)
      );
      if (ac.signal.aborted || serial !== requestSerial) {
        return;
      }
      const protected_ = protectTerms(text, glossary, { html: htmlMode });

      let outText = '';
      /** @type {import('../engine/align.js').AlignedSentence[] | null} */
      let sentences = null;

      if (alignMode) {
        const aligned = await translateAligned(protected_.text, {
          from,
          to,
          html: false,
          signal: ac.signal,
          translateOne: async (sentence) => {
            if (serial !== requestSerial || ac.signal.aborted) {
              return '';
            }
            const result = await engine.translate(sentence, {
              from,
              to,
              html: false,
              signal: ac.signal,
            });
            return restoreTerms(result.text, protected_.map);
          },
          translateBatch: async (batch) => {
            if (serial !== requestSerial || ac.signal.aborted) {
              return batch.map(() => '');
            }
            const result = await engine.translate(batch.join('\n'), {
              from,
              to,
              html: false,
              incremental: false,
              signal: ac.signal,
            });
            const parts = result.text.split('\n');
            if (parts.length === batch.length) {
              return parts.map((p, i) => restoreTerms(p, protected_.map));
            }
            /** @type {string[]} */
            const outs = [];
            for (const sentence of batch) {
              if (serial !== requestSerial || ac.signal.aborted) {
                outs.push('');
                continue;
              }
              const one = await engine.translate(sentence, {
                from,
                to,
                html: false,
                incremental: false,
                signal: ac.signal,
              });
              outs.push(restoreTerms(one.text, protected_.map));
            }
            return outs;
          },
          onPartial: (partial) => {
            if (serial !== requestSerial) {
              return;
            }
            els.target.value = partial.map((p) => p.target).join(' ');
            showAlignPanes(
              partial.map((p) => ({
                source: restoreTerms(p.source, protected_.map),
                target: p.target,
              })),
            );
          },
        });
        if (serial !== requestSerial) {
          return;
        }
        sentences = aligned.sentences.map((p) => ({
          source: restoreTerms(p.source, protected_.map),
          target: p.target,
        }));
        outText = sentences.map((s) => s.target).join(' ');
      } else {
        const result = await engine.translate(protected_.text, {
          from,
          to,
          html: htmlMode,
          signal: ac.signal,
          onPartial: (partial) => {
            if (serial !== requestSerial) {
              return;
            }
            els.target.value = restoreTerms(partial.text, protected_.map);
          },
        });
        if (serial !== requestSerial) {
          return;
        }
        outText = restoreTerms(result.text, protected_.map);
        hideAlignPanes();
      }

      els.target.value = outText;
      lastSentences = sentences;
      if (sentences) {
        showAlignPanes(sentences);
      }
      const ms = Math.round(performance.now() - started);
      if (els.latency) {
        els.latency.textContent = `${ms} ms`;
      }
      els.btnCopy.disabled = !outText;
      els.btnDownload.disabled = !outText;
      els.btnClear.disabled = !els.source.value && !els.target.value;
      syncShareUrl(true);
      if (!mode.quiet) {
        setStatus('Done.');
        if (outText && mobileChrome.isMobile()) {
          mobileChrome.setActivePane('target');
        }
      }
    } catch (err) {
      if (isSuperseded(err) || serial !== requestSerial || ac.signal.aborted) {
        return;
      }
      throw err;
    } finally {
      if (serial === requestSerial) {
        setBusy(false);
        hideProgress();
        if (els.spinner) {
          els.spinner.hidden = true;
        }
      }
    }
  }

  /**
   * @param {File} file
   */
  async function handleFile(file) {
    const kind = fileKind(file.name);
    const body = await readTextFile(file);
    lastFile = { name: file.name, kind: kind || 'txt', body };
    if (kind === 'srt') {
      els.optHtml.checked = false;
      els.optAlign.checked = false;
      await translateSrtFile(body, file.name);
      return;
    }
    els.source.value = body;
    if (looksLikeHtml(body)) {
      els.optHtml.checked = true;
      els.optAlign.checked = false;
    }
    updateCounts();
    savePrefs();
    setStatus(`Loaded ${file.name}`);
    await runTranslate({ force: true });
    els.btnDownload.disabled = !els.target.value;
  }

  /**
   * @param {string} body
   * @param {string} name
   */
  async function translateSrtFile(body, name) {
    const cues = parseSrt(body);
    if (!cues.length) {
      throw new Error('No SRT cues found.');
    }
    els.source.value = cues.map((c) => c.text).join('\n');
    updateCounts();
    setBusy(true);
    setStatus(`Translating ${cues.length} cues…`);
    const from = effectiveFrom();
    const to = els.to.value;
    if (translateAbort) {
      translateAbort.abort();
    }
    const ac = new AbortController();
    translateAbort = ac;
    const serial = ++requestSerial;
    const glossary = /** @type {import('../dict/glossary.js').GlossaryEntry[]} */ (
      await getGlossary(from, to)
    );
    /** @type {string[]} */
    const outs = [];
    for (let i = 0; i < cues.length; i += SRT_BATCH) {
      if (serial !== requestSerial || ac.signal.aborted) {
        return;
      }
      const batch = cues.slice(i, i + SRT_BATCH);
      setProgress(Math.min(1, (i + batch.length) / cues.length));
      /** @type {string[]} */
      const protectedBatch = [];
      /** @type {string[][]} */
      const maps = [];
      for (const cue of batch) {
        const protected_ = protectTerms(cue.text, glossary, { html: false });
        protectedBatch.push(protected_.text);
        maps.push(protected_.map);
      }
      if (!engine) {
        return;
      }
      const joined = await engine.translate(protectedBatch.join('\n'), {
        from,
        to,
        html: false,
        incremental: false,
        signal: ac.signal,
      });
      let parts = joined.text.split('\n');
      if (parts.length !== batch.length) {
        parts = [];
        for (let j = 0; j < batch.length; j += 1) {
          if (serial !== requestSerial || ac.signal.aborted) {
            return;
          }
          const one = await engine.translate(protectedBatch[j], {
            from,
            to,
            html: false,
            incremental: false,
            signal: ac.signal,
          });
          parts.push(restoreTerms(one.text, maps[j]));
        }
      } else {
        for (let j = 0; j < parts.length; j += 1) {
          parts[j] = restoreTerms(parts[j], maps[j]);
        }
      }
      outs.push(...parts);
    }
    if (serial !== requestSerial) {
      return;
    }
    const rebuilt = cues.map((c, i) => ({ ...c, text: outs[i] || c.text }));
    els.target.value = outs.join('\n');
    lastFile = {
      name,
      kind: 'srt',
      body,
      translated: serializeSrt(rebuilt),
    };
    els.btnCopy.disabled = false;
    els.btnDownload.disabled = false;
    els.btnClear.disabled = false;
    setBusy(false);
    hideProgress();
    setStatus('SRT translated.');
  }

  function downloadResult() {
    const text = els.target.value;
    if (!text) {
      return;
    }
    if (lastFile?.kind === 'srt' && lastFile.translated) {
      downloadText(lastFile.name.replace(/\.srt$/i, '.translated.srt'), lastFile.translated);
      setStatus('Downloaded SRT.');
      return;
    }
    const ext = lastFile?.kind === 'md' ? 'md' : els.optHtml.checked ? 'html' : 'txt';
    downloadText(`translated.${ext}`, text);
    setStatus('Downloaded translation.');
  }

  async function onPairChanged() {
    refreshLabels();
    updateRoute();
    savePrefs();
    syncShareUrl(true);
    glossaryCache = { key: '', entries: [] };
    sharedMemory.clear();
    lastLiveSource = '';
    setStatus('Loading language pack...');
    setBusy(true);
    try {
      await warmPair(effectiveFrom(), els.to.value);
      setStatus('Ready.');
      if (els.source.value.trim()) {
        lastLiveSource = els.source.value;
        await runTranslate({ quiet: true });
      }
    } finally {
      setBusy(false);
      hideProgress();
    }
  }

  /**
   * @param {string} from
   * @param {string} to
   */
  async function warmPair(from, to) {
    if (!engine || !engine.prefetch) {
      return;
    }
    if (!canTranslate(models, from, to, pivot)) {
      return;
    }
    setProgress(0.35);
    await engine.prefetch(from, to, (p) => {
      if (typeof p.progress === 'number') {
        setProgress(p.progress);
      }
    });
  }

  async function swapDirection() {
    const from = effectiveFrom();
    const to = els.to.value;
    if (!canTranslate(models, to, from, pivot)) {
      setStatus('Cannot swap this pair.');
      return;
    }
    const carried = els.target.value;
    els.optAuto.checked = false;
    els.from.value = to;
    els.to.value = from;
    resolvedFrom = to;
    refreshLabels();
    updateRoute();
    savePrefs();
    if (carried.trim()) {
      els.source.value = carried;
      els.target.value = '';
      updateCounts();
    }
    await onPairChanged();
  }

  async function copyTarget() {
    const text = els.target.value;
    if (!text) {
      return;
    }
    await navigator.clipboard.writeText(text);
    setStatus('Copied translation.');
  }

  async function copyShareLink() {
    syncShareUrl(true);
    const url = location.href;
    await navigator.clipboard.writeText(url);
    setStatus('Copied share link.');
  }

  function clearAll() {
    requestSerial += 1;
    if (translateAbort) {
      translateAbort.abort();
      translateAbort = null;
    }
    window.clearTimeout(liveTimer);
    window.clearTimeout(finishedTimer);
    window.clearTimeout(detectTimer);
    els.source.value = '';
    els.target.value = '';
    lastLiveSource = '';
    lastFile = null;
    lastSentences = null;
    hideAlignPanes();
    els.btnCopy.disabled = true;
    els.btnClear.disabled = true;
    els.btnDownload.disabled = true;
    if (els.latency) {
      els.latency.textContent = '';
    }
    updateCounts();
    clearError();
    syncShareUrl(true);
    setStatus('Cleared.');
  }

  /**
   * @param {import('../engine/align.js').AlignedSentence[]} sentences
   */
  function showAlignPanes(sentences) {
    els.source.hidden = true;
    els.target.hidden = true;
    els.sourceAlign.hidden = false;
    els.targetAlign.hidden = false;
    els.sourceAlign.innerHTML = renderAlignHtml(sentences, 'source', alignActive);
    els.targetAlign.innerHTML = renderAlignHtml(sentences, 'target', alignActive);
  }

  function hideAlignPanes() {
    els.source.hidden = false;
    els.target.hidden = false;
    els.sourceAlign.hidden = true;
    els.targetAlign.hidden = true;
    els.sourceAlign.innerHTML = '';
    els.targetAlign.innerHTML = '';
    alignActive = -1;
  }

  /**
   * @param {MouseEvent} ev
   */
  function onAlignClick(ev) {
    const t = /** @type {HTMLElement} */ (ev.target);
    const span = t.closest('[data-align-i]');
    if (!span || !lastSentences) {
      return;
    }
    const i = Number(span.getAttribute('data-align-i'));
    alignActive = i;
    showAlignPanes(lastSentences);
  }

  function refreshLabels() {
    const from = effectiveFrom();
    const fromLabel = languageLabel(from, languages);
    const toLabel = languageLabel(els.to.value, languages);
    if (els.sourceLabel) {
      const auto = els.optAuto.checked ? ' (auto)' : '';
      els.sourceLabel.textContent = `${fromLabel}${auto}`;
    }
    if (els.targetLabel) {
      els.targetLabel.textContent = toLabel;
    }
    const tabSource = document.getElementById('tab-source');
    const tabTarget = document.getElementById('tab-target');
    if (tabSource) {
      tabSource.textContent = fromLabel;
    }
    if (tabTarget) {
      tabTarget.textContent = toLabel;
    }
  }

  function updateRoute() {
    if (!els.route) {
      return;
    }
    const from = effectiveFrom();
    const to = els.to.value;
    if (findDirect(models, from, to)) {
      els.route.hidden = true;
      els.route.textContent = '';
      return;
    }
    if (canTranslate(models, from, to, pivot)) {
      els.route.hidden = false;
      els.route.textContent = `via ${languageLabel(pivot, languages)}`;
      return;
    }
    els.route.hidden = false;
    els.route.textContent = 'unavailable';
  }

  function updateCounts() {
    if (els.sourceCount) {
      els.sourceCount.textContent = String(els.source.value.length);
    }
  }

  /**
   * @param {boolean} includeQ
   */
  function syncShareUrl(includeQ) {
    syncUrlState(
      {
        from: els.optAuto.checked ? effectiveFrom() : els.from.value === AUTO_VALUE ? effectiveFrom() : els.from.value,
        to: els.to.value,
        q: includeQ ? els.source.value : undefined,
        html: els.optHtml.checked || undefined,
        auto: els.optAuto.checked || undefined,
        align: els.optAlign.checked || undefined,
      },
      { includeQ, replace: true },
    );
  }

  function savePrefs() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          from: els.from.value === AUTO_VALUE ? resolvedFrom : els.from.value,
          to: els.to.value,
          autoDetect: els.optAuto.checked,
          htmlMode: els.optHtml.checked,
          alignMode: els.optAlign.checked,
        }),
      );
    } catch {
      // ignore quota / private mode
    }
  }

  /**
   * @param {string} msg
   */
  function setStatus(msg) {
    if (els.status) {
      els.status.textContent = msg;
    }
  }

  /**
   * @param {unknown} err
   */
  function showError(err) {
    if (isSuperseded(err)) {
      return;
    }
    const msg = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
    if (els.error) {
      els.error.hidden = false;
      els.error.textContent = msg;
    }
    setStatus('Something went wrong.');
    setBusy(false);
    hideProgress();
    console.error(err);
  }

  function clearError() {
    if (els.error) {
      els.error.hidden = true;
      els.error.textContent = '';
    }
  }

  /**
   * @param {boolean} on
   */
  function setBusy(on) {
    els.btnTranslate.disabled = on;
    els.btnSwap.disabled = on;
    els.from.disabled = on;
    els.to.disabled = on;
    if (els.spinner) {
      els.spinner.hidden = !on;
    }
  }

  /**
   * @param {number} value
   */
  function setProgress(value) {
    if (!els.progressTrack || !els.progress) {
      return;
    }
    els.progressTrack.hidden = false;
    els.progress.style.width = `${Math.max(0, Math.min(1, value)) * 100}%`;
  }

  function hideProgress() {
    if (!els.progressTrack || !els.progress) {
      return;
    }
    els.progressTrack.hidden = true;
    els.progress.style.width = '0%';
  }
}

/**
 * Mobile pane tabs, sticky dock sizing, and overflow action sheet.
 * @param {{
 *   pairGrid: HTMLElement,
 *   paneTabs: HTMLElement | null,
 *   btnMore: HTMLButtonElement | null,
 *   moreSheet: HTMLElement | null,
 *   ctaRow: HTMLElement | null,
 *   btnLink: HTMLButtonElement,
 *   btnClear: HTMLButtonElement,
 *   btnFile: HTMLButtonElement,
 *   btnDownload: HTMLButtonElement,
 *   btnDict: HTMLButtonElement,
 *   source: HTMLTextAreaElement,
 * }} els
 */
function setupMobileChrome(els) {
  const mq = window.matchMedia('(max-width: 820px)');
  const tabs = els.paneTabs;
  const moreBtn = els.btnMore;
  const moreSheet = els.moreSheet;
  const ctaRow = els.ctaRow;
  /** @type {{setActivePane: (name: 'source' | 'target') => void, isMobile: () => boolean}} */
  const api = {
    setActivePane() {},
    isMobile: () => mq.matches,
  };

  if (!tabs || !moreBtn || !moreSheet || !ctaRow) {
    return api;
  }

  const moreSlot = /** @type {HTMLElement | null} */ (moreSheet.querySelector('[data-more-slot]'));
  if (!moreSlot) {
    return api;
  }

  const secondary = [els.btnLink, els.btnClear, els.btnFile, els.btnDownload];
  let mobile = mq.matches;

  /**
   * @param {'source' | 'target'} name
   */
  function setActivePane(name) {
    els.pairGrid.dataset.activePane = name;
    for (const tab of tabs.querySelectorAll('[data-pane]')) {
      const on = tab.getAttribute('data-pane') === name;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
    }
    if (name === 'source' && mobile) {
      queueMicrotask(() => els.source.focus({ preventScroll: true }));
    }
  }

  /**
   * @param {boolean} open
   */
  function setMoreOpen(open) {
    moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.classList.toggle('more-sheet-open', open);
    if (open) {
      moreSheet.hidden = false;
      requestAnimationFrame(() => {
        moreSheet.classList.add('is-open');
      });
      return;
    }
    moreSheet.classList.remove('is-open');
    window.setTimeout(() => {
      if (!moreSheet.classList.contains('is-open')) {
        moreSheet.hidden = true;
      }
    }, 320);
  }

  function measureDock() {
    if (!mobile) {
      document.documentElement.style.setProperty('--dock-h', '0px');
      return;
    }
    const h = Math.ceil(ctaRow.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--dock-h', `${h}px`);
  }

  function syncLayout() {
    mobile = mq.matches;
    tabs.hidden = !mobile;
    moreBtn.hidden = !mobile;
    if (mobile) {
      for (const btn of secondary) {
        moreSlot.appendChild(btn);
      }
    } else {
      setMoreOpen(false);
      for (const btn of secondary) {
        ctaRow.insertBefore(btn, els.btnDict);
      }
      setActivePane('source');
    }
    measureDock();
  }

  tabs.addEventListener('click', (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target);
    const btn = t.closest('[data-pane]');
    if (!btn) {
      return;
    }
    const pane = btn.getAttribute('data-pane');
    if (pane === 'source' || pane === 'target') {
      setActivePane(pane);
    }
  });

  moreBtn.addEventListener('click', () => {
    setMoreOpen(!moreSheet.classList.contains('is-open'));
  });

  moreSheet.addEventListener('click', (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target);
    if (t.closest('[data-more-close]')) {
      setMoreOpen(false);
      return;
    }
    if (t.closest('button')) {
      setMoreOpen(false);
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !moreSheet.hidden) {
      setMoreOpen(false);
    }
  });

  window.addEventListener('resize', () => {
    measureDock();
  });

  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', syncLayout);
  } else {
    mq.addListener(syncLayout);
  }

  syncLayout();
  setActivePane(/** @type {'source' | 'target'} */ (els.pairGrid.dataset.activePane || 'source'));

  api.setActivePane = setActivePane;
  api.isMobile = () => mobile;
  return api;
}

/**
 * Show build version from the Go API when available.
 * @returns {Promise<void>}
 */
async function loadAppVersion() {
  const el = document.getElementById('app-version');
  if (!(el instanceof HTMLElement)) {
    return;
  }
  try {
    const res = await fetch('/api/version');
    if (!res.ok) {
      return;
    }
    const data = await res.json();
    const ver = data && typeof data.version === 'string' ? data.version.trim() : '';
    if (!ver) {
      return;
    }
    el.textContent = `v${ver}`;
    el.hidden = false;
  } catch {
    // Static hosts without the API omit the label.
  }
}

/**
 * @returns {Promise<{models: import('../engine/types.js').ModelInfo[], languages: import('../engine/types.js').LanguageInfo[], pivot: string}>}
 */
async function fetchCatalog() {
  const urls = ['/api/models', '/catalog.json'];
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        lastErr = new Error(`Could not load model catalog (${url}).`);
        continue;
      }
      const data = await res.json();
      const models = Array.isArray(data.models) ? data.models : [];
      if (!models.length) {
        lastErr = new Error('Model catalog is empty.');
        continue;
      }
      const languages = Array.isArray(data.languages) ? data.languages : [];
      return {
        models,
        languages,
        pivot: typeof data.pivot === 'string' ? data.pivot : 'en',
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Could not load model catalog.');
}

/**
 * @param {HTMLSelectElement} select
 * @param {import('../engine/types.js').LanguageInfo[]} languages
 * @param {string} selected
 * @param {boolean} withAuto
 */
function fillLanguageSelect(select, languages, selected, withAuto) {
  select.innerHTML = '';
  if (withAuto) {
    const opt = document.createElement('option');
    opt.value = AUTO_VALUE;
    opt.textContent = 'Auto detect';
    select.appendChild(opt);
  }
  for (const lang of languages) {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = lang.label;
    select.appendChild(opt);
  }
  if (selected === AUTO_VALUE && withAuto) {
    select.value = AUTO_VALUE;
  } else if (selected && [...select.options].some((o) => o.value === selected)) {
    select.value = selected;
  }
}

/**
 * @returns {{from?: string, to?: string, autoDetect?: boolean, htmlMode?: boolean, alignMode?: boolean}}
 */
function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isSuperseded(err) {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const name = 'name' in err ? String(err.name) : '';
  return name === 'SupersededError' || name === 'CancelledError' || name === 'AbortError';
}
