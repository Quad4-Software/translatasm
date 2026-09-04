import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapToCatalogLang,
  gateDetection,
  heuristicDetect,
  detectDebounceMs,
} from '../detect/langdetect.js';

const catalog = new Set(['en', 'es', 'fr', 'de', 'ru', 'uk', 'el', 'nb', 'zh', 'ja']);

test('mapToCatalogLang aliases', () => {
  assert.equal(mapToCatalogLang('no', catalog), 'nb');
  assert.equal(mapToCatalogLang('en-US', catalog), 'en');
  assert.equal(mapToCatalogLang('pt-BR', ['pt', 'en']), 'pt');
  assert.equal(mapToCatalogLang('xx', catalog), null);
});

test('gateDetection enforces confidence', () => {
  assert.equal(gateDetection({ language: 'es', confidence: 0.9 }, catalog), 'es');
  assert.equal(gateDetection({ language: 'es', confidence: 0.2 }, catalog), null);
});

test('heuristicDetect spanish', () => {
  const hit = heuristicDetect('El gato está en la casa y los perros también están fuera del jardín.');
  assert.ok(hit);
  assert.equal(hit.language, 'es');
  assert.ok(hit.confidence >= 0.5);
});

test('heuristicDetect cyrillic prefers russian markers', () => {
  const hit = heuristicDetect('Это простой текст на русском языке и что с этим делать.');
  assert.ok(hit);
  assert.equal(hit.language, 'ru');
});

test('detectDebounceMs scales with length', () => {
  assert.ok(detectDebounceMs(10) <= detectDebounceMs(500));
});
