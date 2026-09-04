import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canTranslate,
  findDirect,
  findReverse,
  languageLabel,
  splitChunks,
} from './pairs.js';

const models = [
  { from: 'en', to: 'es' },
  { from: 'es', to: 'en' },
  { from: 'en', to: 'fr' },
  { from: 'fr', to: 'en' },
];

test('findDirect and findReverse', () => {
  assert.equal(findDirect(models, 'en', 'es')?.to, 'es');
  assert.equal(findReverse(models, 'en', 'es')?.from, 'es');
});

test('canTranslate supports English pivot', () => {
  assert.equal(canTranslate(models, 'es', 'fr', 'en'), true);
  assert.equal(canTranslate(models, 'es', 'de', 'en'), false);
  assert.equal(canTranslate(models, 'en', 'en', 'en'), false);
});

test('languageLabel falls back to code', () => {
  assert.equal(languageLabel('en', { en: 'English' }), 'English');
  assert.equal(languageLabel('xx', [{ code: 'en', label: 'English' }]), 'xx');
});

test('splitChunks keeps short text whole', () => {
  assert.deepEqual(splitChunks('Hello world'), ['Hello world']);
});

test('splitChunks breaks paragraphs and long sentences', () => {
  const text = 'One.\n\nTwo three four five six seven eight nine ten.';
  const chunks = splitChunks(text, 20);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0], 'One.');
});
