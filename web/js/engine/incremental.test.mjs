import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTranslationMemory,
  translateIncremental,
  classifyLiveChange,
  isFinishedSentence,
  openSentenceDebounceMs,
} from './incremental.js';

test('isFinishedSentence detects closers', () => {
  assert.equal(isFinishedSentence('Hello.'), true);
  assert.equal(isFinishedSentence('Hello'), false);
  assert.equal(isFinishedSentence('何？'), true);
});

test('openSentenceDebounceMs stays in range', () => {
  assert.equal(openSentenceDebounceMs(10), 40);
  assert.equal(openSentenceDebounceMs(400), 80);
  const mid = openSentenceDebounceMs(120);
  assert.ok(mid >= 40 && mid <= 80);
});

test('translateIncremental only retranslates dirty sentences', async () => {
  const tm = createTranslationMemory(64);
  let calls = 0;
  /** @param {string[]} sentences */
  async function translateBatch(sentences) {
    calls += 1;
    return sentences.map((s) => `T:${s}`);
  }

  const cold = await translateIncremental('One. Two. Three open', {
    from: 'en',
    to: 'es',
    tm,
    translateBatch,
  });
  assert.equal(cold.dirtyCount, 3);
  assert.equal(calls, 1);

  calls = 0;
  const warm = await translateIncremental('One. Two. Three open now', {
    from: 'en',
    to: 'es',
    tm,
    translateBatch,
  });
  assert.equal(warm.dirtyCount, 1);
  assert.equal(calls, 1);
  assert.ok(warm.text.includes('T:One.'));
  assert.ok(warm.text.includes('T:Three open now'));
});

test('classifyLiveChange flags finished vs open', () => {
  const a = 'Hello world. Open';
  const b = 'Hello world. Open today';
  const change = classifyLiveChange(b, a, 'en');
  assert.equal(change.openChanged, true);
  assert.equal(change.finishedChanged, false);

  const c = 'Hello world. Done.';
  const closed = classifyLiveChange(c, a, 'en');
  assert.equal(closed.finishedChanged, true);
});
