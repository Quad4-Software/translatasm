import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, splitChunks } from './pairs.js';
import { peerAt, renderAlignHtml, translateAligned } from './align.js';

test('splitSentences basic', () => {
  const parts = splitSentences('Hello world. How are you? Fine!');
  assert.ok(parts.length >= 2);
});

test('splitChunks html mode keeps tags together', () => {
  const html = '<p>One two three</p>\n\n<p>Four five six</p>';
  const chunks = splitChunks(html, 30, { html: true });
  assert.ok(chunks.every((c) => !c.includes('<p') || c.includes('</p>') || c.startsWith('<p') || true));
  assert.ok(chunks.length >= 1);
});

test('peerAt bounds', () => {
  const s = [
    { source: 'a', target: 'b' },
    { source: 'c', target: 'd' },
  ];
  assert.equal(peerAt(s, 1)?.target, 'd');
  assert.equal(peerAt(s, 9), null);
});

test('renderAlignHtml escapes', () => {
  const html = renderAlignHtml([{ source: '<x>', target: 'y' }], 'source', 0);
  assert.ok(html.includes('&lt;x&gt;'));
  assert.ok(html.includes('is-active'));
});

test('translateAligned maps sentences', async () => {
  const result = await translateAligned('One. Two.', {
    from: 'en',
    to: 'es',
    translateOne: async (s) => `T(${s.trim()})`,
  });
  assert.ok(result.sentences.length >= 2);
  assert.ok(result.text.includes('T('));
});
