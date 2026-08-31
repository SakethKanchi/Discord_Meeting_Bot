import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OllamaSummarizer } from '../src/adapters/summarizer/ollama.js';
import { OpenAISummarizer } from '../src/adapters/summarizer/openai.js';
import { OpenCodeSummarizer } from '../src/adapters/summarizer/opencode.js';
import { OpenRouterSummarizer } from '../src/adapters/summarizer/openrouter.js';
import { getSummarizer } from '../src/adapters/summarizer/index.js';

const okJson = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test('OllamaSummarizer parses message content JSON', async () => {
  const fetchImpl = okJson({ message: { content: '{"tldr":"o","actionItems":[]}' } });
  const s = new OllamaSummarizer('qwen', 'http://x', fetchImpl);
  const out = await s.summarize('t', { attendees: [] });
  assert.equal(out.tldr, 'o');
});

test('OpenAISummarizer parses choices[0].message.content JSON', async () => {
  const fetchImpl = okJson({ choices: [{ message: { content: '{"tldr":"oa","actionItems":[]}' } }] });
  const s = new OpenAISummarizer('gpt-x', 'http://x', 'key', fetchImpl);
  const out = await s.summarize('t', { attendees: [] });
  assert.equal(out.tldr, 'oa');
});

test('OpenCodeSummarizer hits zen chat/completions and parses content JSON', async () => {
  let calledUrl;
  const fetchImpl = async (url) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"tldr":"oc","actionItems":[]}' } }] }) };
  };
  const s = new OpenCodeSummarizer('minimax-m3', 'https://opencode.ai/zen/go/v1', 'key', fetchImpl);
  const out = await s.summarize('t', { attendees: [] });
  assert.equal(out.tldr, 'oc');
  assert.equal(calledUrl, 'https://opencode.ai/zen/go/v1/chat/completions');
});

test('OpenCodeSummarizer throws clear missing-key error', () => {
  assert.throws(() => new OpenCodeSummarizer('gpt-5.5', 'http://x', ''), /OPENCODE_API_KEY/);
});

test('OpenRouterSummarizer hits openrouter chat/completions and parses content JSON', async () => {
  let calledUrl;
  let calledHeaders;
  const fetchImpl = async (url, opts) => {
    calledUrl = url;
    calledHeaders = opts.headers;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"tldr":"or","actionItems":[]}' } }] }) };
  };
  const s = new OpenRouterSummarizer('openai/gpt-4o-mini', 'https://openrouter.ai/api/v1', 'key', fetchImpl);
  const out = await s.summarize('t', { attendees: [] });
  assert.equal(out.tldr, 'or');
  assert.equal(calledUrl, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calledHeaders.authorization, 'Bearer key');
  assert.equal(calledHeaders['HTTP-Referer'], 'https://github.com/SakethKanchi/parley');
  assert.equal(calledHeaders['X-Title'], 'Parley');
});

test('OpenRouterSummarizer throws clear missing-key error', () => {
  assert.throws(() => new OpenRouterSummarizer('openai/gpt-4o-mini', 'http://x', ''), /OPENROUTER_API_KEY/);
});

test('getSummarizer builds ollama + openai + opencode + openrouter providers', () => {
  assert.equal(getSummarizer({ summarizerProvider: 'ollama', summarizerModel: 'qwen' }).constructor.name, 'OllamaSummarizer');
  assert.equal(
    getSummarizer({ summarizerProvider: 'openai', summarizerModel: 'gpt-x' }, { openai: { apiKey: 'k', baseUrl: 'http://x' } }).constructor.name,
    'OpenAISummarizer'
  );
  assert.equal(
    getSummarizer({ summarizerProvider: 'opencode', summarizerModel: 'minimax-m3' }, { opencode: { apiKey: 'k', baseUrl: 'http://x' } }).constructor.name,
    'OpenCodeSummarizer'
  );
  assert.equal(
    getSummarizer({ summarizerProvider: 'openrouter', summarizerModel: 'anthropic/claude-sonnet-4' }, { openrouter: { apiKey: 'k', baseUrl: 'http://x' } }).constructor.name,
    'OpenRouterSummarizer'
  );
});

test('opencode defaults to deepseek-v4-flash when no model set', () => {
  const s = getSummarizer({ summarizerProvider: 'opencode' }, { opencode: { apiKey: 'k', baseUrl: 'http://x' } });
  assert.equal(s.model, 'deepseek-v4-flash');
});

test('openrouter defaults to openai/gpt-4o-mini when no model set', () => {
  const s = getSummarizer({ summarizerProvider: 'openrouter' }, { openrouter: { apiKey: 'k', baseUrl: 'http://x' } });
  assert.equal(s.model, 'openai/gpt-4o-mini');
});

test('summarizer prompt includes the summary-language instruction', async () => {
  let sentBody;
  const fetchImpl = async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"tldr":"x"}' } }] }) };
  };
  const s = new OpenAISummarizer('m', 'http://x', 'k', fetchImpl);
  await s.summarize('hello transcript', { attendees: ['Sam'], summaryLanguage: 'de' });
  const prompt = sentBody.messages[0].content;
  assert.match(prompt, /Write the entire summary in German\./);
});
