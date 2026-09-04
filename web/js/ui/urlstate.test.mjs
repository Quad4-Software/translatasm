import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUrlState, buildUrlSearch, truncateQ, Q_MAX } from './urlstate.js';

test('parseUrlState reads from to q flags', () => {
  const s = parseUrlState('?from=de&to=en&q=Hallo&html=1&auto=true', ['de', 'en', 'es']);
  assert.equal(s.from, 'de');
  assert.equal(s.to, 'en');
  assert.equal(s.q, 'Hallo');
  assert.equal(s.html, true);
  assert.equal(s.auto, true);
});

test('parseUrlState drops invalid langs', () => {
  const s = parseUrlState('?from=xx&to=es', ['en', 'es']);
  assert.equal(s.from, undefined);
  assert.equal(s.to, 'es');
});

test('buildUrlSearch round-trip', () => {
  const search = buildUrlSearch({ from: 'en', to: 'fr', q: 'hi', html: true, auto: false });
  const parsed = parseUrlState(search, ['en', 'fr']);
  assert.equal(parsed.from, 'en');
  assert.equal(parsed.to, 'fr');
  assert.equal(parsed.q, 'hi');
  assert.equal(parsed.html, true);
  assert.equal(parsed.auto, undefined);
});

test('truncateQ caps length', () => {
  const long = 'a'.repeat(Q_MAX + 50);
  assert.equal(truncateQ(long).length, Q_MAX);
});
