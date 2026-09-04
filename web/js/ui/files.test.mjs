import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fileKind,
  looksLikeHtml,
  looksBinary,
  parseSrt,
  serializeSrt,
  splitHtmlSafe,
  MAX_FILE_BYTES,
} from './files.js';

test('fileKind', () => {
  assert.equal(fileKind('a.TXT'), 'txt');
  assert.equal(fileKind('note.md'), 'md');
  assert.equal(fileKind('subs.srt'), 'srt');
  assert.equal(fileKind('x.pdf'), null);
});

test('looksLikeHtml', () => {
  assert.equal(looksLikeHtml('<p>Hello</p>'), true);
  assert.equal(looksLikeHtml('plain text'), false);
});

test('looksBinary null bytes', () => {
  assert.equal(looksBinary(new Uint8Array([65, 0, 66])), true);
  assert.equal(looksBinary(new Uint8Array([72, 101, 108, 108, 111])), false);
});

test('srt round-trip', () => {
  const raw = `1
00:00:01,000 --> 00:00:02,500
Hello world

2
00:00:03,000 --> 00:00:04,000
Second line
`;
  const cues = parseSrt(raw);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'Hello world');
  const out = serializeSrt(cues);
  const again = parseSrt(out);
  assert.equal(again.length, 2);
  assert.equal(again[1].text, 'Second line');
});

test('splitHtmlSafe does not explode short html', () => {
  const html = '<p>One</p><p>Two</p>';
  assert.deepEqual(splitHtmlSafe(html, 5000), [html]);
});

test('MAX_FILE_BYTES is positive', () => {
  assert.ok(MAX_FILE_BYTES > 1000);
});
