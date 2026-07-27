import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSetup } from '../src/commands/setup-logic.js';

const env = { gemini: { apiKey: 'g' }, openai: { apiKey: '' }, opencode: { apiKey: '' }, ollama: { url: 'http://x' }, sttUrl: 'http://127.0.0.1:8000' };

test('accepts gemini when key present', () => {
  const r = validateSetup({ provider: 'gemini', model: 'gemini-2.5-flash' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerProvider, 'gemini');
});

test('rejects openai when key missing', () => {
  const r = validateSetup({ provider: 'openai', model: 'gpt-x' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /OPENAI_API_KEY/);
});

test('rejects opencode when key missing', () => {
  const r = validateSetup({ provider: 'opencode', model: 'gpt-5.5' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /OPENCODE_API_KEY/);
});

test('accepts opencode when key present', () => {
  const r = validateSetup({ provider: 'opencode', model: 'gpt-5.5' }, { ...env, opencode: { apiKey: 'k' } });
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerProvider, 'opencode');
  assert.equal(r.patch.summarizerModel, 'gpt-5.5');
});

test('rejects unknown provider', () => {
  const r = validateSetup({ provider: 'bogus' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /provider/i);
});

test('accepts whisper model + thread + autojoin booleans', () => {
  const r = validateSetup({ whisperModel: 'medium', useThread: false, autoJoin: true }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.whisperModel, 'medium');
  assert.equal(r.patch.useThread, false);
});

test('rejects invalid whisper model', () => {
  const r = validateSetup({ whisperModel: 'humongous' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /whisper/i);
});

test('accepts valid language + summary_language', () => {
  const r = validateSetup({ language: 'de', summary_language: 'en' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.language, 'de');
  assert.equal(r.patch.summaryLanguage, 'en');
});

test('accepts summary_language match', () => {
  const r = validateSetup({ summary_language: 'match' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.summaryLanguage, 'match');
});

test('rejects unknown transcription language', () => {
  const r = validateSetup({ language: 'zz' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /language/i);
});

test('rejects unknown summary_language', () => {
  const r = validateSetup({ summary_language: 'zz' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /summary language/i);
});

// ── STT provider selection ───────────────────────────────────────────────────

test('accepts sidecar STT provider without a key', () => {
  const r = validateSetup({ sttProvider: 'sidecar' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.sttProvider, 'sidecar');
});

test('rejects openai STT when OPENAI_API_KEY missing', () => {
  const r = validateSetup({ sttProvider: 'openai' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /OPENAI_API_KEY/);
});

// ── auto-join channel allow-list + keep-audio ────────────────────────────────

test('accepts a valid autoJoinChannelIds list and dedupes it', () => {
  const r = validateSetup({ autoJoinChannelIds: ['123456789012345678', '123456789012345678', '987654321098765432'] }, env);
  assert.equal(r.ok, true);
  assert.deepEqual(r.patch.autoJoinChannelIds, ['123456789012345678', '987654321098765432']);
});

test('accepts an empty autoJoinChannelIds list (= any channel)', () => {
  const r = validateSetup({ autoJoinChannelIds: [] }, env);
  assert.equal(r.ok, true);
  assert.deepEqual(r.patch.autoJoinChannelIds, []);
});

test('rejects autoJoinChannelIds that is not an array', () => {
  const r = validateSetup({ autoJoinChannelIds: '123456789012345678' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /array/i);
});

test('rejects autoJoinChannelIds containing a non-snowflake id', () => {
  const r = validateSetup({ autoJoinChannelIds: ['123456789012345678', 'DROP TABLE'] }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid channel id/i);
});

test('rejects more than 25 autoJoinChannelIds', () => {
  const ids = Array.from({ length: 26 }, (_, i) => String(100000000000000000n + BigInt(i)));
  const r = validateSetup({ autoJoinChannelIds: ids }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /too many/i);
});

test('accepts keepAudio boolean', () => {
  assert.equal(validateSetup({ keepAudio: true }, env).patch.keepAudio, true);
  assert.equal(validateSetup({ keepAudio: false }, env).patch.keepAudio, false);
});

test('accepts openai STT with key and a valid model', () => {
  const r = validateSetup({ sttProvider: 'openai', sttModel: 'whisper-1' }, { ...env, openai: { apiKey: 'k' } });
  assert.equal(r.ok, true);
  assert.equal(r.patch.sttProvider, 'openai');
  assert.equal(r.patch.sttModel, 'whisper-1');
});

test('rejects an invalid openai STT model', () => {
  const r = validateSetup({ sttProvider: 'openai', sttModel: 'whisper-9000' }, { ...env, openai: { apiKey: 'k' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /openai model/i);
});

test('rejects an unknown STT provider', () => {
  const r = validateSetup({ sttProvider: 'magic' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /STT provider/i);
});

test('rejects openai STT when OPENAI_API_KEY missing', () => {
  const r = validateSetup({ sttProvider: 'openai' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /OPENAI_API_KEY/);
});
