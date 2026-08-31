import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript, computeTalkTime, formatMs } from '../src/pipeline/summarize.js';

const utterances = [
  { displayName: 'Alice', startMs: 2000, endMs: 4000, text: 'second' },
  { displayName: 'Bob', startMs: 0, endMs: 1000, text: 'first' },
  { displayName: 'Alice', startMs: 5000, endMs: 6000, text: 'third word here' },
];

test('formatMs renders mm:ss', () => {
  assert.equal(formatMs(0), '00:00');
  assert.equal(formatMs(65000), '01:05');
});

test('buildTranscript sorts by startMs and labels speakers', () => {
  const t = buildTranscript(utterances);
  assert.equal(t, '[00:00] Bob: first\n[00:02] Alice: second\n[00:05] Alice: third word here');
});

test('buildTranscript stamps relative to the first utterance, not epoch', () => {
  const origin = 1_788_190_209_302;
  const t = buildTranscript([
    { displayName: 'Joy', startMs: origin, endMs: origin + 900, text: 'hey' },
    { displayName: 'Ahmad', startMs: origin + 65_000, endMs: origin + 66_000, text: 'hi' },
  ]);
  assert.equal(t, '[00:00] Joy: hey\n[01:05] Ahmad: hi');
});

test('buildTranscript of no utterances is empty', () => {
  assert.equal(buildTranscript([]), '');
});

test('computeTalkTime aggregates ms, words, pct per speaker', () => {
  const stats = computeTalkTime(utterances);
  const alice = stats.find((s) => s.displayName === 'Alice');
  const bob = stats.find((s) => s.displayName === 'Bob');
  assert.equal(alice.ms, 3000);     // (4000-2000)+(6000-5000)
  assert.equal(alice.words, 4);     // "second"(1) + "third word here"(3)
  assert.equal(bob.ms, 1000);
  assert.equal(alice.pct + bob.pct, 100);
});
