import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyNotes, normalizeNotes, SUMMARY_PROMPT } from '../src/adapters/summarizer/notes.js';
import { FakeSummarizer } from '../src/adapters/summarizer/fake.js';
import { parseGeminiNotes } from '../src/adapters/summarizer/gemini.js';
import { getSummarizer } from '../src/adapters/summarizer/index.js';

test('normalizeNotes fills missing fields from empty shape', () => {
  const n = normalizeNotes({ tldr: 'x' });
  assert.equal(n.tldr, 'x');
  assert.deepEqual(n.topics, []);
  assert.deepEqual(n.actionItems, []);
});

test('SUMMARY_PROMPT instructs JSON output with action item assignees', () => {
  assert.match(SUMMARY_PROMPT, /JSON/);
  assert.match(SUMMARY_PROMPT, /assignee/);
  assert.match(SUMMARY_PROMPT, /every distinct subject/);
  assert.match(SUMMARY_PROMPT, /Do not collapse a long meeting/);
});

test('FakeSummarizer returns a valid normalized shape', async () => {
  const out = await new FakeSummarizer().summarize('transcript', { attendees: ['Alice'] });
  assert.equal(typeof out.tldr, 'string');
  assert.ok(Array.isArray(out.actionItems));
});

test('parseGeminiNotes extracts JSON from a fenced code block', () => {
  const raw = 'Here:\n```json\n{"tldr":"hi","actionItems":[{"assignee":"Alice","task":"ship"}]}\n```';
  const n = parseGeminiNotes(raw);
  assert.equal(n.tldr, 'hi');
  assert.equal(n.actionItems[0].assignee, 'Alice');
});

test('parseGeminiNotes falls back to tldr on non-JSON', () => {
  const n = parseGeminiNotes('plain text summary');
  assert.equal(n.tldr, 'plain text summary');
});

test('getSummarizer returns fake when provider is fake', () => {
  const s = getSummarizer({ summarizerProvider: 'fake', summarizerModel: 'x' });
  assert.equal(s.constructor.name, 'FakeSummarizer');
});

test('getSummarizer throws on unknown provider', () => {
  assert.throws(() => getSummarizer({ summarizerProvider: 'nope' }), /Unknown summarizer/);
});
