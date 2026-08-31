// test/available-providers.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableProviders } from '../src/commands/setup-logic.js';

test('availableProviders reflects which keys are set', () => {
  const env = { gemini: { apiKey: 'x' }, openai: { apiKey: '' },
    opencode: { apiKey: '' }, openrouter: { apiKey: '' }, ollama: { url: 'http://localhost' } };
  const list = availableProviders(env);
  const byName = Object.fromEntries(list.map((p) => [p.provider, p.ok]));
  assert.equal(byName.gemini, true);
  assert.equal(byName.openai, false);
  assert.equal(byName.openrouter, false);
  assert.equal(byName.ollama, true);
});
