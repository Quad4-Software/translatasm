import test from 'node:test';
import assert from 'node:assert/strict';
import { protectTerms, restoreTerms } from './glossary.js';

test('protect and restore plain terms', () => {
  const entries = [
    { from: 'en', to: 'es', source: 'OpenAI', target: 'OpenAI' },
    { from: 'en', to: 'es', source: 'translatasm', target: 'translatasm' },
  ];
  const { text, map } = protectTerms('OpenAI built translatasm tools', entries);
  assert.ok(text.includes('__T0__'));
  assert.ok(text.includes('__T1__'));
  const restored = restoreTerms(`${text} ok`, map);
  assert.equal(restored, 'OpenAI built translatasm tools ok');
});

test('longest match first', () => {
  const entries = [
    { from: 'en', to: 'es', source: 'BON', target: 'BON' },
    { from: 'en', to: 'es', source: 'BON in a Box', target: 'BON in a Box' },
  ];
  const { text, map } = protectTerms('Try BON in a Box today', entries);
  assert.equal(restoreTerms(text, map), 'Try BON in a Box today');
  assert.ok(!text.includes('BON in a Box') || text.includes('__T'));
});

test('html mode skips tags', () => {
  const entries = [{ from: 'en', to: 'es', source: 'Hello', target: 'HolaX' }];
  const { text, map } = protectTerms('<a title="Hello">Hello</a>', entries, { html: true });
  assert.ok(text.includes('title="Hello"'));
  assert.ok(text.includes('__T0__'));
  assert.equal(restoreTerms(text, map), '<a title="Hello">HolaX</a>');
});
