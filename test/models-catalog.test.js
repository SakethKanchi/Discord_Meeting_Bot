import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listModels, searchModels, clearModelCache, formatContext,
  CURATED_MODELS, DEFAULT_MODELS, CATALOG_PROVIDERS,
} from '../src/adapters/summarizer/models.js';

const env = {
  gemini: { apiKey: 'gk' },
  openai: { apiKey: 'ok', baseUrl: 'https://api.openai.com/v1' },
  opencode: { apiKey: 'ck', baseUrl: 'https://opencode.ai/zen/go/v1' },
  openrouter: { apiKey: 'rk', baseUrl: 'https://openrouter.ai/api/v1' },
  ollama: { url: 'http://127.0.0.1:11434' },
};

// Records the urls a fetcher hits and replays canned bodies keyed by substring.
function stubFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    for (const [match, body] of Object.entries(routes)) {
      if (url.includes(match)) {
        if (body instanceof Error) throw body;
        return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'no route' };
  };
  return { fetchImpl, calls };
}

const gemini = (models, nextPageToken) => ({ models, nextPageToken });
const geminiModel = (name, extra = {}) => ({
  name: `models/${name}`,
  displayName: name,
  supportedGenerationMethods: ['generateContent', 'countTokens'],
  inputTokenLimit: 1048576,
  ...extra,
});

test.beforeEach(() => clearModelCache());

test('gemini catalog follows pages and keeps only text generateContent models', async () => {
  const { fetchImpl, calls } = stubFetch({
    'pageToken=next': gemini([geminiModel('gemini-2.5-pro')]),
    '/models?key=': gemini([
      geminiModel('gemini-2.5-flash'),
      geminiModel('gemini-embedding-001', { supportedGenerationMethods: ['embedContent'] }),
      geminiModel('gemini-2.5-flash-preview-tts'),      // audio out
      geminiModel('gemini-3-pro-image'),                // image out
      geminiModel('veo-3.1-generate-preview'),          // video out
    ], 'next'),
  });
  const cat = await listModels('gemini', { env, fetchImpl });
  assert.equal(cat.source, 'live');
  assert.deepEqual(cat.models.map((m) => m.id), ['gemini-2.5-flash', 'gemini-2.5-pro']);
  assert.equal(cat.models[0].context, 1048576);
  assert.equal(calls.length, 2, 'followed nextPageToken');
});

test('openai catalog drops audio/image/embedding endpoints', async () => {
  const { fetchImpl } = stubFetch({
    '/models': { data: [
      { id: 'gpt-4o-mini' }, { id: 'gpt-4o-mini-tts' }, { id: 'whisper-1' },
      { id: 'text-embedding-3-small' }, { id: 'dall-e-3' }, { id: 'o3-mini' },
    ] },
  });
  const cat = await listModels('openai', { env, fetchImpl });
  assert.deepEqual(cat.models.map((m) => m.id), ['gpt-4o-mini', 'o3-mini']);
});

test('openai catalog keeps every id when a compatible gateway uses unknown names', async () => {
  const { fetchImpl } = stubFetch({
    '/models': { data: [{ id: 'qwen2.5-coder-32b-instruct' }, { id: 'llama-3.3-70b' }] },
  });
  const cat = await listModels('openai', { env, fetchImpl });
  assert.deepEqual(cat.models.map((m) => m.id), ['llama-3.3-70b', 'qwen2.5-coder-32b-instruct']);
});

test('openrouter catalog carries labels/context and skips non-text outputs', async () => {
  const { fetchImpl } = stubFetch({
    '/models': { data: [
      { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o mini', context_length: 128000, architecture: { output_modalities: ['text'] } },
      { id: 'black-forest/flux', name: 'Flux', architecture: { output_modalities: ['image'] } },
      { id: 'zz/no-modalities', name: 'Unknown' },
    ] },
  });
  const cat = await listModels('openrouter', { env, fetchImpl });
  assert.deepEqual(cat.models.map((m) => m.id), ['openai/gpt-4o-mini', 'zz/no-modalities']);
  assert.equal(cat.models[0].label, 'OpenAI: GPT-4o mini');
  assert.equal(cat.models[0].context, 128000);
});

test('ollama catalog lists installed tags', async () => {
  const { fetchImpl, calls } = stubFetch({ '/api/tags': { models: [{ name: 'llama3.1:8b' }, { name: 'mistral:latest' }] } });
  const cat = await listModels('ollama', { env, fetchImpl });
  assert.equal(cat.source, 'live');
  assert.deepEqual(cat.models.map((m) => m.id), ['llama3.1:8b', 'mistral:latest']);
  assert.match(calls[0], /^http:\/\/127\.0\.0\.1:11434\/api\/tags$/);
});

test('opencode sends its bearer token and lists bare ids', async () => {
  let headers;
  const fetchImpl = async (_url, opts) => {
    headers = opts.headers;
    return { ok: true, json: async () => ({ data: [{ id: 'glm-5.3' }, { id: 'kimi-k3' }] }), text: async () => '' };
  };
  const cat = await listModels('opencode', { env, fetchImpl });
  assert.equal(headers.authorization, 'Bearer ck');
  assert.deepEqual(cat.models.map((m) => m.id), ['glm-5.3', 'kimi-k3']);
});

test('curated models rank ahead of the rest of the catalog', async () => {
  const { fetchImpl } = stubFetch({
    '/models': { data: [{ id: 'aaa-first-alphabetically' }, { id: 'glm-5.3' }, { id: 'zzz' }] },
  });
  const cat = await listModels('opencode', { env, fetchImpl });
  assert.equal(cat.models[0].id, 'glm-5.3', 'curated pick leads');
  assert.deepEqual(cat.models.slice(1).map((m) => m.id), ['aaa-first-alphabetically', 'zzz']);
});

test('a failing provider degrades to the curated list with the reason', async () => {
  const { fetchImpl } = stubFetch({ '/models': new Error('boom') });
  const cat = await listModels('openrouter', { env, fetchImpl });
  assert.equal(cat.source, 'curated');
  assert.deepEqual(cat.models.map((m) => m.id), CURATED_MODELS.openrouter);
  assert.match(cat.error, /boom/);
});

test('a missing key never fires a request', async () => {
  let hits = 0;
  const fetchImpl = async () => { hits += 1; throw new Error('unreachable'); };
  const cat = await listModels('gemini', { env: { ...env, gemini: {} }, fetchImpl });
  assert.equal(hits, 0);
  assert.equal(cat.source, 'curated');
  assert.match(cat.error, /GEMINI_API_KEY/);
});

test('an empty live list falls back rather than showing nothing', async () => {
  const { fetchImpl } = stubFetch({ '/api/tags': { models: [] } });
  const cat = await listModels('ollama', { env, fetchImpl });
  assert.equal(cat.source, 'curated');
  assert.deepEqual(cat.models.map((m) => m.id), CURATED_MODELS.ollama);
});

test('catalogs are cached until the ttl expires, and refresh bypasses the cache', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return { ok: true, json: async () => ({ data: [{ id: `m${n}` }] }), text: async () => '' };
  };
  let clock = 1000;
  const now = () => clock;
  await listModels('opencode', { env, fetchImpl, now });
  const cached = await listModels('opencode', { env, fetchImpl, now });
  assert.equal(n, 1);
  assert.equal(cached.models[0].id, 'm1');

  const refreshed = await listModels('opencode', { env, fetchImpl, now, refresh: true });
  assert.equal(n, 2);
  assert.equal(refreshed.models[0].id, 'm2');

  clock += 11 * 60 * 1000; // past CACHE_TTL_MS
  await listModels('opencode', { env, fetchImpl, now });
  assert.equal(n, 3);
});

test('a failed catalog is retried sooner than a live one', async () => {
  let n = 0;
  const fetchImpl = async () => { n += 1; throw new Error('down'); };
  let clock = 0;
  const now = () => clock;
  await listModels('opencode', { env, fetchImpl, now });
  clock += 5000;
  await listModels('opencode', { env, fetchImpl, now });
  assert.equal(n, 1, 'still cached at 5s');
  clock += 30_000;
  await listModels('opencode', { env, fetchImpl, now });
  assert.equal(n, 2, 'retried after the error ttl');
});

test('a slow provider times out instead of hanging the picker', async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const cat = await listModels('openrouter', { env, fetchImpl, timeoutMs: 20 });
  assert.equal(cat.source, 'curated');
  assert.match(cat.error, /timed out/);
});

test('every supported provider has a default and a curated shortlist', () => {
  for (const p of CATALOG_PROVIDERS) {
    assert.ok(DEFAULT_MODELS[p], `${p} default`);
    assert.ok(CURATED_MODELS[p]?.length, `${p} curated`);
    assert.ok(CURATED_MODELS[p].includes(DEFAULT_MODELS[p]), `${p} default is curated`);
  }
});

test('searchModels ranks exact, then prefix, then substring', () => {
  const models = ['anthropic/claude-sonnet-4', 'openai/gpt-4o', 'openai/gpt-4o-mini', 'zz/gpt-4o-clone']
    .map((id) => ({ id, label: id, context: null }));
  assert.deepEqual(searchModels(models, 'openai/gpt-4o').map((m) => m.id),
    ['openai/gpt-4o', 'openai/gpt-4o-mini']);
  assert.deepEqual(searchModels(models, 'gpt-4o').map((m) => m.id),
    ['openai/gpt-4o', 'openai/gpt-4o-mini', 'zz/gpt-4o-clone']);
});

test('searchModels requires every token and matches labels', () => {
  const models = [
    { id: 'anthropic/claude-sonnet-4', label: 'Anthropic: Claude Sonnet 4', context: null },
    { id: 'anthropic/claude-opus-4', label: 'Anthropic: Claude Opus 4', context: null },
  ];
  assert.deepEqual(searchModels(models, 'claude son').map((m) => m.id), ['anthropic/claude-sonnet-4']);
  assert.deepEqual(searchModels(models, 'Anthropic Opus').map((m) => m.id), ['anthropic/claude-opus-4']);
  assert.deepEqual(searchModels(models, 'nope'), []);
});

test('searchModels caps results at the limit', () => {
  const models = Array.from({ length: 60 }, (_, i) => ({ id: `m-${i}`, label: '', context: null }));
  assert.equal(searchModels(models, 'm-', 25).length, 25);
  assert.equal(searchModels(models, '', 25).length, 25);
});

test('formatContext compacts token windows', () => {
  assert.equal(formatContext(1048576), '1M');
  assert.equal(formatContext(128000), '128K');
  assert.equal(formatContext(8192), '8K');
  assert.equal(formatContext(512), '512');
  assert.equal(formatContext(null), '');
});
