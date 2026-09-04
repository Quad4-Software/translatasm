/**
 * Extension bridge for translatasm (translate + language detect).
 */

import { createBergamotEngine } from '/js/engine/bergamot.js';
import { detectLanguage } from '/js/detect/langdetect.js';

const statusEl = document.getElementById('status');
const params = new URLSearchParams(location.search);
const extId = params.get('extId') || '';

/** @type {ReturnType<typeof createBergamotEngine> | null} */
let engine = null;
/** @type {AbortController | null} */
let active = null;
/** @type {object | null} */
let catalog = null;

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

function extensionRuntime() {
  const root = globalThis.chrome || globalThis.browser;
  return root?.runtime;
}

async function loadCatalog() {
  if (catalog) return catalog;
  try {
    const res = await fetch('/api/models', { credentials: 'omit' });
    if (res.ok) {
      catalog = await res.json();
      return catalog;
    }
  } catch {
    /* fall through */
  }
  catalog = await (await fetch('/catalog.json', { credentials: 'omit' })).json();
  return catalog;
}

async function ensureEngine() {
  if (engine) return;
  engine = createBergamotEngine();
  setStatus('Loading translation models…');
  await engine.load(undefined, (p) => {
    if (p?.message) setStatus(String(p.message));
  });
  setStatus('Ready');
}

async function translate(text, opts) {
  await ensureEngine();
  if (active) active.abort();
  active = new AbortController();
  setStatus('Translating ' + opts.from + ' → ' + opts.to + '…');
  const result = await engine.translate(text, {
    from: opts.from,
    to: opts.to,
    html: Boolean(opts.html),
    incremental: false,
    signal: active.signal,
  });
  setStatus('Ready');
  return { text: result.text, from: result.from, to: result.to };
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') throw new Error('invalid message');
  switch (msg.type) {
    case 'ping':
      return {
        ok: true,
        name: 'translatasm',
        isolated: Boolean(globalThis.crossOriginIsolated),
        ready: Boolean(engine),
      };
    case 'list-models':
      return loadCatalog();
    case 'detect': {
      const text = typeof msg.text === 'string' ? msg.text : '';
      if (!text.trim()) throw new Error('empty text');
      const cat = await loadCatalog();
      const language = await detectLanguage(text, cat);
      return { language };
    }
    case 'translate': {
      const text = typeof msg.text === 'string' ? msg.text : '';
      const from = typeof msg.from === 'string' ? msg.from : 'en';
      const to = typeof msg.to === 'string' ? msg.to : 'es';
      if (!text.trim()) throw new Error('empty text');
      if (text.length > 200_000) throw new Error('text too large');
      return translate(text, { from, to, html: msg.html });
    }
    case 'dispose':
      active?.abort();
      engine?.dispose();
      engine = null;
      setStatus('Disposed');
      return { ok: true };
    default:
      throw new Error('unknown type: ' + msg.type);
  }
}

function connect() {
  const runtime = extensionRuntime();
  if (!runtime || !extId) {
    setStatus('Open this page from the translatasm extension.');
    return;
  }
  let port;
  try {
    port = runtime.connect(extId, { name: 'translatasm-bridge' });
  } catch (err) {
    setStatus('Connect failed: ' + err);
    return;
  }
  setStatus('Connected. Keep this tab open while translating.');
  port.onMessage.addListener((msg) => {
    const id = msg?.id;
    handleMessage(msg)
      .then((result) => port.postMessage({ id, ok: true, result }))
      .catch((err) => port.postMessage({ id, ok: false, error: String(err?.message || err) }));
  });
  port.onDisconnect.addListener(() => {
    setStatus('Extension disconnected. Reloading…');
    setTimeout(() => location.reload(), 800);
  });
  port.postMessage({ type: 'bridge-hello', name: 'translatasm' });
}

connect();
