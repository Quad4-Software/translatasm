import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleReview, vocabToCsv } from './vocab.js';

test('scheduleReview again resets interval', () => {
  const base = {
    word: 'casa',
    from: 'es',
    to: 'en',
    createdAt: 1,
    ease: 2.5,
    reps: 3,
    intervalDays: 10,
    lapses: 0,
  };
  const next = scheduleReview(base, 0);
  assert.equal(next.reps, 0);
  assert.equal(next.intervalDays, 0);
  assert.equal(next.lapses, 1);
  assert.ok(next.dueAt <= Date.now() + 1000);
});

test('scheduleReview good advances', () => {
  const base = {
    word: 'house',
    from: 'en',
    to: 'es',
    createdAt: 1,
    ease: 2.5,
    reps: 0,
    intervalDays: 0,
    lapses: 0,
  };
  const next = scheduleReview(base, 1);
  assert.equal(next.reps, 1);
  assert.equal(next.intervalDays, 1);
  assert.ok((next.dueAt || 0) > Date.now());
});

test('vocabToCsv includes header', () => {
  const csv = vocabToCsv([
    { word: 'a', from: 'en', to: 'es', gloss: 'x', createdAt: 1, note: 'n,ote' },
  ]);
  assert.ok(csv.startsWith('word,from,to'));
  assert.ok(csv.includes('"n,ote"'));
});
