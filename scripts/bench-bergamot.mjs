#!/usr/bin/env node
/**
 * Bench and smoke-accuracy for local Bergamot packs.
 * Usage: node scripts/bench-bergamot.mjs
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LatencyOptimisedTranslator,
  TranslatorBacking,
} from '../web/vendor/bergamot/translator.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const MODEL_ROOT = join(WEB, 'models');

class DiskBacking extends TranslatorBacking {
  constructor() {
    super({
      registryUrl: 'disk://registry.json',
      downloadTimeout: 180000,
      pivotLanguage: 'en',
    });
  }

  /**
   * @returns {Promise<{from:string,to:string,files:object}[]>}
   */
  async loadModelRegistery() {
    const raw = await readFile(join(MODEL_ROOT, 'registry.json'), 'utf8');
    const registry = JSON.parse(raw);
    return Object.entries(registry).map(([key, files]) => ({
      from: key.substring(0, 2),
      to: key.substring(2, 4),
      files,
    }));
  }

  /**
   * @param {string} url
   * @param {string} [_checksum]
   * @param {{signal?: AbortSignal}} [_extra]
   * @returns {Promise<ArrayBuffer>}
   */
  async fetch(url, _checksum, _extra) {
    const path = resolveLocalPath(url);
    const buf = await readFile(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
}

/**
 * @param {string} url
 */
function resolveLocalPath(url) {
  if (url.startsWith('file:')) {
    return fileURLToPath(url);
  }
  if (url.startsWith('/models/')) {
    return join(WEB, url.slice(1));
  }
  if (url.startsWith('models/')) {
    return join(WEB, url);
  }
  throw new Error(`unsupported asset url: ${url}`);
}

/** @type {{from:string,to:string,text:string,expectIncludes?:string[],label:string}[]} */
const CASES = [
  {
    label: 'enes-hello',
    from: 'en',
    to: 'es',
    text: 'Hello, how are you?',
    expectIncludes: ['hola', 'cómo', 'estas', 'está'],
  },
  {
    label: 'esen-hello',
    from: 'es',
    to: 'en',
    text: 'Hola, ¿cómo estás?',
    expectIncludes: ['hello', 'how', 'you'],
  },
  {
    label: 'enfr-thanks',
    from: 'en',
    to: 'fr',
    text: 'Thank you very much.',
    expectIncludes: ['merci'],
  },
  {
    label: 'ende-good-morning',
    from: 'en',
    to: 'de',
    text: 'Good morning.',
    expectIncludes: ['guten', 'morgen'],
  },
  {
    label: 'enit-friend',
    from: 'en',
    to: 'it',
    text: 'She is my friend.',
    expectIncludes: ['amic'],
  },
  {
    label: 'pivot-eses',
    from: 'es',
    to: 'fr',
    text: 'El gato está en la casa.',
    expectIncludes: ['chat', 'maison'],
  },
];

const BENCH_TEXTS = {
  short: 'The quick brown fox jumps over the lazy dog.',
  medium:
    'Offline neural machine translation keeps every sentence on this device. ' +
    'Models load once, then typing stays private and fast enough for drafts.',
  long:
    'Privacy-preserving translation matters when you handle notes, messages, and drafts. '.repeat(8).trim(),
};

/**
 * @param {string} a
 * @param {string} b
 */
function tokenF1(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.length && !tb.length) {
    return 1;
  }
  if (!ta.length || !tb.length) {
    return 0;
  }
  const counts = new Map();
  for (const t of ta) {
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  let overlap = 0;
  for (const t of tb) {
    const n = counts.get(t) || 0;
    if (n > 0) {
      overlap += 1;
      counts.set(t, n - 1);
    }
  }
  const precision = overlap / tb.length;
  const recall = overlap / ta.length;
  if (precision + recall === 0) {
    return 0;
  }
  return (2 * precision * recall) / (precision + recall);
}

/**
 * @param {string} s
 */
function tokenize(s) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * @param {string} text
 * @param {string[]} needles
 */
function softHit(text, needles) {
  const norm = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  return needles.some((n) => norm.includes(n.toLowerCase()));
}

/**
 * @param {number} bytes
 */
function fmtMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @param {string} dir
 */
async function dirBytes(dir) {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      total += await dirBytes(p);
    } else {
      total += (await stat(p)).size;
    }
  }
  return total;
}

async function printSizes() {
  const wasm = (await stat(join(WEB, 'vendor/bergamot/worker/bergamot-translator-worker.wasm'))).size;
  const bergAll = await dirBytes(join(WEB, 'vendor/bergamot'));
  const models = await dirBytes(join(MODEL_ROOT, 'tiny'));
  const registry = (await stat(join(MODEL_ROOT, 'registry.json'))).size;
  const pairs = await readdir(join(MODEL_ROOT, 'tiny'));
  /** @type {{pair:string, bytes:number}[]} */
  const perPair = [];
  for (const pair of pairs) {
    perPair.push({ pair, bytes: await dirBytes(join(MODEL_ROOT, 'tiny', pair)) });
  }
  perPair.sort((a, b) => a.bytes - b.bytes);

  console.log('=== sizes ===');
  console.log(`WASM binary:          ${fmtMB(wasm)} (${wasm.toLocaleString()} bytes)`);
  console.log(`Bergamot vendor all:  ${fmtMB(bergAll)} (js+wasm)`);
  console.log(`Models all packs:     ${fmtMB(models)} (${pairs.length} pairs)`);
  console.log(`registry.json:        ${(registry / 1024).toFixed(1)} KB`);
  console.log(`Combined vendor+models: ${fmtMB(bergAll + models + registry)}`);
  console.log('Per-pair model dirs:');
  for (const row of perPair) {
    console.log(`  ${row.pair.padEnd(6)} ${fmtMB(row.bytes)}`);
  }
  console.log('');
}

/**
 * @param {LatencyOptimisedTranslator} translator
 * @param {string} from
 * @param {string} to
 * @param {string} text
 */
async function translateOnce(translator, from, to, text) {
  const result = await translator.translate({ from, to, text, html: false });
  return String(result?.target?.text ?? '').trim();
}

/**
 * @param {number[]} samples
 */
function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return { mean, p50, p95, min: sorted[0], max: sorted[sorted.length - 1] };
}

/**
 * @returns {Promise<LatencyOptimisedTranslator>}
 */
async function makeTranslator() {
  const translator = new LatencyOptimisedTranslator(
    { cacheSize: 5000, useNativeIntGemm: false },
    new DiskBacking(),
  );
  await translator.worker;
  return translator;
}

async function main() {
  await printSizes();

  console.log('=== warm worker ===');
  let warmStart = performance.now();
  let translator = await makeTranslator();
  console.log(`worker+wasm ready in ${(performance.now() - warmStart).toFixed(0)} ms\n`);

  console.log('=== accuracy (soft keyword + round-trip F1) ===');
  let pass = 0;
  let fail = 0;
  /** @type {number[]} */
  const roundTripScores = [];

  for (const c of CASES) {
    // Fresh worker per case avoids WASM heap aborts after several packs.
    await translator.delete().catch(() => {});
    translator = await makeTranslator();
    try {
      const t0 = performance.now();
      const out = await translateOnce(translator, c.from, c.to, c.text);
      const ms = performance.now() - t0;
      const hit = !c.expectIncludes?.length || softHit(out, c.expectIncludes);
      if (hit) {
        pass += 1;
      } else {
        fail += 1;
      }

      let f1 = null;
      if (c.from !== c.to) {
        const back = await translateOnce(translator, c.to, c.from, out);
        f1 = tokenF1(c.text, back);
        roundTripScores.push(f1);
      }

      const mark = hit ? 'PASS' : 'FAIL';
      console.log(
        `${mark} ${c.label.padEnd(22)} ${ms.toFixed(0).padStart(5)} ms  -> ${JSON.stringify(out)}` +
          (f1 == null ? '' : `  roundtripF1=${f1.toFixed(2)}`),
      );
    } catch (err) {
      fail += 1;
      const msg = err && typeof err === 'object' && 'message' in err ? err.message : String(err);
      console.log(`FAIL ${c.label.padEnd(22)} error: ${msg}`);
    }
  }

  const avgF1 =
    roundTripScores.reduce((a, b) => a + b, 0) / Math.max(roundTripScores.length, 1);
  console.log(`accuracy soft-pass ${pass}/${pass + fail}  mean round-trip token-F1 ${avgF1.toFixed(3)}\n`);

  console.log('=== latency (enes, 5 iters after warmup) ===');
  await translator.delete().catch(() => {});
  translator = await makeTranslator();
  const pairFrom = 'en';
  const pairTo = 'es';
  await translateOnce(translator, pairFrom, pairTo, 'warmup');

  for (const [name, text] of Object.entries(BENCH_TEXTS)) {
    /** @type {number[]} */
    const samples = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      await translateOnce(translator, pairFrom, pairTo, text);
      samples.push(performance.now() - t0);
    }
    const s = summarize(samples);
    console.log(
      `${name.padEnd(8)} chars=${String(text.length).padStart(4)}  ` +
        `mean=${s.mean.toFixed(0)}ms p50=${s.p50.toFixed(0)}ms p95=${s.p95.toFixed(0)}ms ` +
        `min=${s.min.toFixed(0)} max=${s.max.toFixed(0)}`,
    );
  }

  console.log('\n=== first-load cost (fresh pair en->de) ===');
  await translator.delete().catch(() => {});
  translator = await makeTranslator();
  try {
    const cold0 = performance.now();
    const coldOut = await translateOnce(translator, 'en', 'de', BENCH_TEXTS.short);
    console.log(`cold ende ${(performance.now() - cold0).toFixed(0)} ms -> ${JSON.stringify(coldOut)}`);
    const hot0 = performance.now();
    await translateOnce(translator, 'en', 'de', BENCH_TEXTS.short);
    console.log(`hot  ende ${(performance.now() - hot0).toFixed(0)} ms`);
  } catch (err) {
    console.log('ende bench error:', err && typeof err === 'object' && 'message' in err ? err.message : err);
  }

  await translator.delete().catch(() => {});
  if (fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
