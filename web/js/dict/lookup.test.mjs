import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findGlosses,
  findInEntries,
  normalizeWord,
  shardKey,
  stemCandidates,
  lookupWord,
} from './lookup.js';

const dictsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dicts');

test('normalizeWord strips punctuation', () => {
  assert.equal(normalizeWord('  "Houses!"  '), 'houses');
  assert.equal(normalizeWord('casa.'), 'casa');
});

test('shardKey covers latin and fallback', () => {
  assert.equal(shardKey('house'), 'h');
  assert.equal(shardKey('casa'), 'c');
  assert.equal(shardKey('дом'), 'cyr');
});

test('stemCandidates includes ing and plural forms', () => {
  const c = stemCandidates('running');
  assert.ok(c.includes('running'));
  assert.ok(c.includes('runn'));
  const houses = stemCandidates('houses');
  assert.ok(houses.includes('house'));
});

test('findInEntries follows points_to', () => {
  const entries = {
    houses: { w: 'houses', points_to: 'house' },
    house: { w: 'house', senses: [{ g: 'dwelling' }] },
  };
  const hit = findInEntries(entries, 'houses');
  assert.equal(hit?.entry.w, 'house');
  assert.equal(hit?.matched, 'houses');
});

test('findGlosses returns bilingual gloss list', () => {
  const hit = findGlosses({ house: ['casa', 'hogar'] }, 'house');
  assert.deepEqual(hit?.glosses, ['casa', 'hogar']);
});

test('lookupWord merges fixture mono and bi packs', async () => {
  const registry = JSON.parse(await readFile(path.join(dictsRoot, 'registry.json'), 'utf8'));

  globalThis.fetch = async (url) => {
    const u = String(url);
    const rel = u.replace(/^.*\/dicts\//, '');
    const file = path.join(dictsRoot, rel);
    try {
      const body = await readFile(file, 'utf8');
      return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(body),
      };
    } catch {
      return { ok: false, status: 404, json: async () => ({}) };
    }
  };

  const result = await lookupWord(registry, 'houses', { lang: 'en', glossLang: 'es' });
  assert.equal(result.word, 'house');
  assert.ok(result.senses?.length);
  assert.ok(result.glosses?.includes('casa'));
  assert.equal(result.packMissing, undefined);
});

test('lookupWord reports missing pack', async () => {
  const registry = {
    version: 1,
    pivot: 'en',
    attribution: [],
    mono: {},
    bi: {},
  };
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const result = await lookupWord(registry, 'house', { lang: 'fr', glossLang: 'en' });
  assert.equal(result.packMissing, true);
});
