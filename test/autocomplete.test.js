import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelChoices, modelChoiceName, providerForOption, handleAutocomplete, MAX_CHOICES } from '../src/commands/autocomplete.js';
import { clearModelCache } from '../src/adapters/summarizer/models.js';
import { openDb } from '../src/store/db.js';
import { setGuildConfig } from '../src/store/config.js';

const env = {
  gemini: { apiKey: 'gk' },
  openai: { apiKey: 'ok', baseUrl: 'https://api.openai.com/v1' },
  opencode: { apiKey: 'ck', baseUrl: 'https://opencode.ai/zen/go/v1' },
  openrouter: { apiKey: 'rk', baseUrl: 'https://openrouter.ai/api/v1' },
  ollama: { url: 'http://127.0.0.1:11434' },
};

const catalog = (ids) => async () => ({
  ok: true,
  json: async () => ({ data: ids.map((id) => (typeof id === 'string' ? { id } : id)) }),
  text: async () => '',
});

test.beforeEach(() => clearModelCache());

test('model option autocompletes from the picked provider, not the saved one', () => {
  const cfg = { summarizerProvider: 'gemini', summarizerFallbackProvider: 'openai' };
  assert.equal(providerForOption('model', { provider: 'openrouter' }, cfg), 'openrouter');
  assert.equal(providerForOption('model', {}, cfg), 'gemini');
});

test('fallback_model option follows the fallback provider and falls back to the primary', () => {
  const cfg = { summarizerProvider: 'gemini', summarizerFallbackProvider: 'openai' };
  assert.equal(providerForOption('fallback_model', { fallbackProvider: 'opencode' }, cfg), 'opencode');
  assert.equal(providerForOption('fallback_model', {}, cfg), 'openai');
  // No fallback configured yet: offer the primary provider's catalog.
  assert.equal(providerForOption('fallback_model', {}, { summarizerProvider: 'gemini' }), 'gemini');
  // "none" disables the fallback entirely — nothing to autocomplete.
  assert.equal(providerForOption('fallback_model', { fallbackProvider: 'none' }, cfg), null);
  assert.equal(providerForOption('keyword', {}, cfg), null);
});

test('choices are filtered by the typed query and stay within Discord limits', async () => {
  const ids = Array.from({ length: 80 }, (_, i) => `glm-${i}`).concat(['kimi-k3']);
  const choices = await modelChoices('opencode', 'glm', { env, fetchImpl: catalog(ids) });
  assert.equal(choices.length, MAX_CHOICES);
  assert.ok(choices.every((c) => c.value.startsWith('glm-')));
  assert.ok(choices.every((c) => c.name.length <= 100 && c.value.length <= 100));
});

test('choice names show the context window and the value stays the raw id', async () => {
  const fetchImpl = catalog([
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', context_length: 128000, architecture: { output_modalities: ['text'] } },
  ]);
  const [choice] = await modelChoices('openrouter', 'gpt-4o', { env, fetchImpl });
  assert.equal(choice.value, 'openai/gpt-4o-mini');
  assert.equal(choice.name, 'openai/gpt-4o-mini · 128K');
});

test('no provider means no choices', async () => {
  assert.deepEqual(await modelChoices(null, 'x', { env }), []);
});

test('long ids are truncated to Discord\'s 100-char name limit', () => {
  const name = modelChoiceName({ id: 'x'.repeat(140), label: '', context: 128000 });
  assert.equal(name.length, 100);
  assert.ok(name.endsWith('… · 128K'));
});

test('an unreachable provider still autocompletes from the curated shortlist', async () => {
  const fetchImpl = async () => { throw new Error('gateway down'); };
  const choices = await modelChoices('opencode', 'glm', { env, fetchImpl });
  assert.ok(choices.length > 0);
  assert.ok(choices.some((c) => c.value === 'glm-5.3'));
});


// A stand-in for discord.js's AutocompleteInteraction: only the three accessors
// the handler touches, plus the single respond() Discord permits.
function fakeInteraction({ focused, options = {}, guildId = 'g1' }) {
  const sent = [];
  return {
    guildId,
    sent,
    options: {
      getFocused: () => focused,
      getString: (name) => options[name] ?? null,
    },
    respond: async (choices) => { sent.push(choices); },
  };
}

test('handleAutocomplete answers with the guild provider catalog', async () => {
  const db = openDb(':memory:');
  setGuildConfig(db, 'g1', { summarizerProvider: 'opencode', summarizerModel: 'glm-5.3' });
  const it = fakeInteraction({ focused: { name: 'model', value: 'kimi' } });
  await handleAutocomplete(it, { db, env, fetchImpl: catalog(['glm-5.3', 'kimi-k3', 'kimi-k2.6']) });
  assert.equal(it.sent.length, 1);
  // kimi-k3 is a curated pick, so it outranks the alphabetically-earlier tag.
  assert.deepEqual(it.sent[0].map((c) => c.value), ['kimi-k3', 'kimi-k2.6']);
});

test('handleAutocomplete uses the provider being picked in the same command', async () => {
  const db = openDb(':memory:');
  setGuildConfig(db, 'g1', { summarizerProvider: 'gemini' });
  const it = fakeInteraction({ focused: { name: 'model', value: '' }, options: { provider: 'opencode' } });
  await handleAutocomplete(it, { db, env, fetchImpl: catalog(['glm-5.3']) });
  assert.deepEqual(it.sent[0].map((c) => c.value), ['glm-5.3']);
});

test('handleAutocomplete always responds once, even when the catalog throws', async () => {
  const db = openDb(':memory:');
  const it = fakeInteraction({ focused: { name: 'model', value: 'x' }, guildId: null });
  await handleAutocomplete(it, { db, env: {}, fetchImpl: async () => { throw new Error('nope'); } });
  assert.equal(it.sent.length, 1);
  assert.deepEqual(it.sent[0], []);
});