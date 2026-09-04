import { createEngine, registerEngine } from '../engine/registry.js';
import { createBergamotEngine, hasNativeIntGemm } from '../engine/bergamot.js';
import { canTranslate, findDirect, languageLabel } from '../engine/pairs.js';
import { mountDictDrawer, wordAtCaret } from '../dict/drawer.js';

registerEngine('bergamot', createBergamotEngine);

const STORAGE_KEY = 'translatasm.prefs.v1';
const LIVE_DEBOUNCE_MIN_MS = 70;
const LIVE_DEBOUNCE_MAX_MS = 160;

/**
 * Shorter debounce for short strings. Longer paste waits a bit more.
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
    btnClear: /** @type {HTMLButtonElement} */ (document.getElementById('btn-clear')),
    btnSwap: /** @type {HTMLButtonElement} */ (document.getElementById('btn-swap')),
  };

  /** @type {import('../engine/types.js').ModelInfo[]} */
  let models = [];
  /** @type {import('../engine/types.js').LanguageInfo[]} */
  let languages = [];
  let pivot = 'en';
  /** @type {ReturnType<typeof createBergamotEngine> | null} */
  let engine = null;
  let liveTimer = 0;
  /** @type {number} */
  let requestSerial = 0;
  let ready = false;

  const catalog = await fetchCatalog();
  models = catalog.models;
  languages = catalog.languages;
  pivot = catalog.pivot || 'en';

  const prefs = loadPrefs();
  fillLanguageSelect(els.from, languages, prefs.from || 'en');
  fillLanguageSelect(els.to, languages, prefs.to || 'es');
  if (els.from.value === els.to.value) {
    els.to.value = els.from.value === 'en' ? 'es' : 'en';
  }
  refreshLabels();
  updateRoute();

  engine = createEngine('bergamot');
  setStatus('Starting Bergamot...');
  setBusy(true);
  try {
    await engine.load(models[0], (p) => {
      if (typeof p.progress === 'number') {
        setProgress(p.progress);
      }
    });
    await warmPair(els.from.value, els.to.value);
    ready = true;
    const accel = hasNativeIntGemm() ? 'Firefox native IntGEMM' : 'WASM IntGEMM';
    setStatus(`Ready (${accel}). Type to translate.`);
  } catch (err) {
    showError(err);
  } finally {
    setBusy(false);
    hideProgress();
  }

  els.from.addEventListener('change', () => {
    if (els.from.value === els.to.value) {
      const alt = languages.find((l) => l.code !== els.from.value);
      if (alt) {
        els.to.value = alt.code;
      }
    }
    onPairChanged().catch(showError);
  });
  els.to.addEventListener('change', () => {
    if (els.to.value === els.from.value) {
      const alt = languages.find((l) => l.code !== els.to.value);
      if (alt) {
        els.from.value = alt.code;
      }
    }
    onPairChanged().catch(showError);
  });
  els.btnTranslate.addEventListener('click', () => {
    runTranslate({ force: true }).catch(showError);
  });
  els.btnCopy.addEventListener('click', () => {
    copyTarget().catch(showError);
  });
  els.btnClear.addEventListener('click', clearAll);
  els.btnSwap.addEventListener('click', () => {
    swapDirection().catch(showError);
  });
  els.source.addEventListener('input', () => {
    updateCounts();
    els.btnClear.disabled = !els.source.value && !els.target.value;
    if (!ready) {
      return;
    }
    window.clearTimeout(liveTimer);
    liveTimer = window.setTimeout(() => {
      runTranslate({ quiet: true }).catch(showError);
    }, liveDebounceMs(els.source.value.length));
  });
  els.source.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      runTranslate({ force: true }).catch(showError);
    }
  });

  const dictRoot = document.getElementById('dict-root');
  const dict =
    dictRoot &&
    mountDictDrawer({
      root: dictRoot,
      getPair: () => ({ from: els.from.value, to: els.to.value }),
      onStatus: (msg) => setStatus(msg),
    });

  /**
   * @param {HTMLTextAreaElement} el
   * @param {'source' | 'target'} pane
   */
  function bindWordLookup(el, pane) {
    el.addEventListener('dblclick', () => {
      if (!dict) {
        return;
      }
      const word = wordAtCaret(el);
      if (!word) {
        return;
      }
      dict.lookUp(word, pane).catch(showError);
    });
  }
  bindWordLookup(els.source, 'source');
  bindWordLookup(els.target, 'target');

  /**
   * @param {{quiet?: boolean, force?: boolean}} [mode]
   */
  async function runTranslate(mode = {}) {
    clearError();
    if (!engine || !ready) {
      throw new Error('Translation engine is not ready.');
    }
    const from = els.from.value;
    const to = els.to.value;
    const text = els.source.value;
    if (!text.trim()) {
      els.target.value = '';
      if (els.latency) {
        els.latency.textContent = '';
      }
      if (!mode.quiet) {
        setStatus('Paste or type some text first.');
      }
      return;
    }
    if (!canTranslate(models, from, to, pivot)) {
      throw new Error(`No path from ${from} to ${to}.`);
    }

    const serial = ++requestSerial;
    const started = performance.now();
    if (!mode.quiet) {
      setBusy(true);
      setProgress(0.25);
      setStatus('Translating...');
    } else if (els.spinner) {
      els.spinner.hidden = false;
    }

    try {
      const result = await engine.translate(text, {
        from,
        to,
        onPartial: (partial) => {
          if (serial !== requestSerial) {
            return;
          }
          els.target.value = partial.text;
        },
      });
      if (serial !== requestSerial) {
        return;
      }
      els.target.value = result.text;
      const ms = Math.round(performance.now() - started);
      if (els.latency) {
        els.latency.textContent = `${ms} ms`;
      }
      els.btnCopy.disabled = !result.text;
      els.btnClear.disabled = !els.source.value && !els.target.value;
      if (!mode.quiet) {
        setStatus('Done.');
      }
    } catch (err) {
      if (isSuperseded(err) || serial !== requestSerial) {
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

  async function onPairChanged() {
    refreshLabels();
    updateRoute();
    savePrefs();
    setStatus('Loading language pack...');
    setBusy(true);
    try {
      await warmPair(els.from.value, els.to.value);
      setStatus('Ready.');
      if (els.source.value.trim()) {
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
    const from = els.from.value;
    const to = els.to.value;
    if (!canTranslate(models, to, from, pivot)) {
      setStatus('Cannot swap this pair.');
      return;
    }
    const carried = els.target.value;
    els.from.value = to;
    els.to.value = from;
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

  function clearAll() {
    requestSerial += 1;
    window.clearTimeout(liveTimer);
    els.source.value = '';
    els.target.value = '';
    els.btnCopy.disabled = true;
    els.btnClear.disabled = true;
    if (els.latency) {
      els.latency.textContent = '';
    }
    updateCounts();
    clearError();
    setStatus('Cleared.');
  }

  function refreshLabels() {
    if (els.sourceLabel) {
      els.sourceLabel.textContent = languageLabel(els.from.value, languages);
    }
    if (els.targetLabel) {
      els.targetLabel.textContent = languageLabel(els.to.value, languages);
    }
  }

  function updateRoute() {
    if (!els.route) {
      return;
    }
    const from = els.from.value;
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

  function savePrefs() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          from: els.from.value,
          to: els.to.value,
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
 */
function fillLanguageSelect(select, languages, selected) {
  select.innerHTML = '';
  for (const lang of languages) {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = lang.label;
    select.appendChild(opt);
  }
  if (selected && [...select.options].some((o) => o.value === selected)) {
    select.value = selected;
  }
}

/**
 * @returns {{from?: string, to?: string}}
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
  return name === 'SupersededError' || name === 'CancelledError';
}
