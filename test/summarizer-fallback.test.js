// test/summarizer-fallback.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FallbackSummarizer } from '../src/adapters/summarizer/fallback.js';
import { getSummarizer } from '../src/adapters/summarizer/index.js';

const NOTES = { tldr: 'ok', topics: [], decisions: [], openQuestions: [], actionItems: [] };
const silent = { warn() {} };
const ok = (tag) => ({ summarize: async () => ({ ...NOTES, tldr: tag }) });
const boom = (status) => ({
  summarize: async () => { const e = new Error(`fail ${status}`); e.status = status; throw e; },
});

const wrap = (primary, makeFallback) => new FallbackSummarizer(primary, makeFallback, {
  label: 'opencode:glm-5.3', fallbackLabel: 'gemini:gemini-2.5-flash', log: silent,
});

test('primary success never touches the fallback', async () => {
  let built = 0;
  const s = wrap(ok('primary'), () => { built += 1; return ok('fallback'); });
  const notes = await s.summarize('t', {});
  assert.equal(notes.tldr, 'primary');
  assert.equal(built, 0, 'fallback must not even be constructed');
  assert.equal(s.lastUsed, 'opencode:glm-5.3');
});

test('primary failure falls through and reports the fallback as the model used', async () => {
  const s = wrap(boom(429), () => ok('fallback'));
  const notes = await s.summarize('t', {});
  assert.equal(notes.tldr, 'fallback');
  assert.equal(s.lastUsed, 'gemini:gemini-2.5-flash',
    'model_used must name the provider that actually produced the notes');
});

test('an unusable fallback surfaces the primary error, not the construction error', async () => {
  const s = wrap(boom(429), () => { throw new Error('GEMINI_API_KEY is not set in .env'); });
  const err = await s.summarize('t', {}).then(() => null, (e) => e);
  assert.match(err.message, /fail 429/);
  assert.match(err.userMessage, /Quota or rate limit hit \(429\)/);
  assert.match(err.userMessage, /Fallback gemini:gemini-2\.5-flash is unavailable/);
});

test('both failing names both providers and keeps the primary error attached', async () => {
  const s = wrap(boom(429), () => boom(500));
  const err = await s.summarize('t', {}).then(() => null, (e) => e);
  assert.equal(err.status, 500, 'the last error propagates');
  assert.equal(err.primaryError.status, 429);
  assert.match(err.userMessage, /Both summarizers failed/);
  assert.match(err.userMessage, /opencode:glm-5\.3/);
  assert.match(err.userMessage, /gemini:gemini-2\.5-flash/);
});

test('getSummarizer returns a bare adapter when no fallback is configured', () => {
  const env = { gemini: { apiKey: 'k' } };
  const s = getSummarizer({ summarizerProvider: 'gemini', summarizerModel: 'gemini-2.5-flash' }, env);
  assert.equal(s instanceof FallbackSummarizer, false);
  assert.equal(s.lastUsed, undefined);
});

test('getSummarizer composes a fallback when one is configured', () => {
  const env = { gemini: { apiKey: 'k' }, opencode: { apiKey: 'k', baseUrl: 'https://x/v1' } };
  const s = getSummarizer({
    summarizerProvider: 'opencode', summarizerModel: 'glm-5.3',
    summarizerFallbackProvider: 'gemini', summarizerFallbackModel: 'gemini-2.5-flash',
  }, env);
  assert.ok(s instanceof FallbackSummarizer);
  assert.equal(s.lastUsed, 'opencode:glm-5.3');
});

test('a fallback identical to the primary is not wrapped', () => {
  const env = { opencode: { apiKey: 'k', baseUrl: 'https://x/v1' } };
  const s = getSummarizer({
    summarizerProvider: 'opencode', summarizerModel: 'glm-5.3',
    summarizerFallbackProvider: 'opencode', summarizerFallbackModel: 'glm-5.3',
  }, env);
  assert.equal(s instanceof FallbackSummarizer, false);
});
