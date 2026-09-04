#!/usr/bin/env node
/**
 * Latency checks for sentence TM and optional Bergamot warm translate.
 * Usage: node scripts/bench-bergamot.mjs
 * Optional: BENCH_URL=http://127.0.0.1:8080 for live engine smoke (needs models).
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

/**
 * Minimal in-process harness for incremental.js (no browser APIs beyond what Node has).
 */
async function benchIncremental() {
  const modPath = pathToFileURL(path.join(root, 'web/js/engine/incremental.js')).href;
  const {
    createTranslationMemory,
    translateIncremental,
    classifyLiveChange,
    isFinishedSentence,
  } = await import(modPath);

  const tm = createTranslationMemory(256);
  let calls = 0;
  /** @type {string[]} */
  const translated = [];

  /**
   * @param {string[]} sentences
   */
  async function translateBatch(sentences) {
    calls += 1;
    return sentences.map((s) => {
      const out = `T(${s})`;
      translated.push(out);
      return out;
    });
  }

  const text1 =
    'Hello world. This is a second sentence. And a third one that is still open';
  const t0 = performance.now();
  const r1 = await translateIncremental(text1, {
    from: 'en',
    to: 'es',
    tm,
    translateBatch,
  });
  const coldMs = performance.now() - t0;
  const coldCalls = calls;

  calls = 0;
  const text2 =
    'Hello world. This is a second sentence. And a third one that is still open today';
  const t1 = performance.now();
  const r2 = await translateIncremental(text2, {
    from: 'en',
    to: 'es',
    tm,
    translateBatch,
  });
  const dirtyMs = performance.now() - t1;
  const dirtyCalls = calls;

  if (r1.dirtyCount < 2) {
    throw new Error(`expected multiple dirty sentences on cold run, got ${r1.dirtyCount}`);
  }
  if (r2.dirtyCount !== 1) {
    throw new Error(`expected 1 dirty sentence on edit, got ${r2.dirtyCount}`);
  }
  if (dirtyCalls !== 1) {
    throw new Error(`expected 1 batch call on dirty edit, got ${dirtyCalls}`);
  }

  const change = classifyLiveChange(text2, text1, 'en');
  if (!change.openChanged) {
    throw new Error('expected openChanged after editing trailing sentence');
  }
  if (!isFinishedSentence('Done.')) {
    throw new Error('isFinishedSentence failed');
  }

  console.log('incremental TM');
  console.log(`  cold translate: ${coldMs.toFixed(2)} ms (${coldCalls} batches, dirty=${r1.dirtyCount})`);
  console.log(`  one-dirty edit: ${dirtyMs.toFixed(2)} ms (${dirtyCalls} batches, dirty=${r2.dirtyCount})`);
  console.log(`  output len: ${r2.text.length}`);
  return { coldMs, dirtyMs, coldCalls, dirtyCalls };
}

async function benchHttp() {
  const base = process.env.BENCH_URL;
  if (!base) {
    console.log('live engine: skipped (set BENCH_URL to exercise /catalog.json)');
    return null;
  }
  const t0 = performance.now();
  const res = await fetch(`${base.replace(/\/$/, '')}/catalog.json`);
  if (!res.ok) {
    throw new Error(`catalog fetch failed: ${res.status}`);
  }
  const catalog = await res.json();
  const ms = performance.now() - t0;
  const models = Array.isArray(catalog.models) ? catalog.models.length : 0;
  console.log('live catalog');
  console.log(`  fetch: ${ms.toFixed(2)} ms (${models} models)`);
  return { ms, models };
}

async function main() {
  console.log('translatasm bench');
  await benchIncremental();
  await benchHttp();
  console.log('ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
