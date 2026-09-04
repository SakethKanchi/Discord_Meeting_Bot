import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandsJSON } from '../src/commands/definitions.js';

test('exports the v2 commands as JSON', () => {
  const names = commandsJSON().map((c) => c.name).sort();
  assert.deepEqual(names, ['history', 'join', 'leave', 'post', 'raw', 'search', 'setup', 'status', 'summary']);
});

test('search command has a required keyword option', () => {
  const search = commandsJSON().find((c) => c.name === 'search');
  const opt = search.options.find((o) => o.name === 'keyword');
  assert.equal(opt.required, true);
});

test('setup command exposes provider/model/fallback/stt/whisper/thread/autojoin/channel/language/summary_language options', () => {
  const setup = commandsJSON().find((c) => c.name === 'setup');
  const names = setup.options.map((o) => o.name).sort();
  assert.deepEqual(names, ['autojoin', 'fallback_model', 'fallback_provider', 'language', 'model', 'notes_channel', 'provider', 'stt_model', 'stt_provider', 'summary_language', 'thread', 'whisper_model']);
});

test('setup provider option includes openrouter', () => {
  const setup = commandsJSON().find((c) => c.name === 'setup');
  const provider = setup.options.find((o) => o.name === 'provider');
  const values = provider.choices.map((c) => c.value);
  assert.ok(values.includes('openrouter'));
  assert.ok(values.includes('opencode'));
});

test('model options are autocompleted, not choice-limited', () => {
  const setup = commandsJSON().find((c) => c.name === 'setup');
  for (const name of ['model', 'fallback_model']) {
    const opt = setup.options.find((o) => o.name === name);
    assert.equal(opt.autocomplete, true, `${name} autocompletes`);
    // Discord rejects an option that declares both choices and autocomplete.
    assert.ok(!opt.choices?.length, `${name} has no static choices`);
  }
});

test('stt_provider option offers sidecar and openai choices', () => {
  const setup = commandsJSON().find((c) => c.name === 'setup');
  const stt = setup.options.find((o) => o.name === 'stt_provider');
  const values = stt.choices.map((c) => c.value);
  assert.ok(values.includes('sidecar'));
  assert.ok(values.includes('openai'));
});

test('language option offers a German choice and auto', () => {
  const setup = commandsJSON().find((c) => c.name === 'setup');
  const lang = setup.options.find((o) => o.name === 'language');
  const values = lang.choices.map((c) => c.value);
  assert.ok(values.includes('de'));
  assert.ok(values.includes('auto'));
});

test('summary_language option offers match', () => {
  const setup = commandsJSON().find((c) => c.name === 'setup');
  const sl = setup.options.find((o) => o.name === 'summary_language');
  const values = sl.choices.map((c) => c.value);
  assert.ok(values.includes('match'));
  assert.ok(values.includes('en'));
});
