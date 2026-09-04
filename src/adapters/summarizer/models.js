// Live model catalogs, one per summarizer provider.
//
// Every provider publishes what it actually serves — Gemini's ListModels, the
// OpenAI-compatible `/models` endpoints (OpenAI, OpenCode Zen, OpenRouter) and
// Ollama's `/api/tags` — so the Setup UI and the `/setup` autocomplete can offer
// the complete list to search through instead of a hand-maintained handful.
// Results are cached in memory: Discord autocomplete fires on every keystroke
// and has to answer inside 3 seconds.
//
// A dead endpoint, missing key or timeout degrades to CURATED_MODELS rather
// than showing an empty picker; the model field stays free text either way.

import { config as envConfig } from '../../config/env.js';

// The model a provider gets when it's selected without naming one. Single
// source for createAdapter(), /setup and the dashboard.
export const DEFAULT_MODELS = {
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
  ollama: 'llama3',
  opencode: 'glm-5.3',
  openrouter: 'openai/gpt-4o-mini',
};

// Hand-picked shortlist per provider: shown first in an unfiltered picker, and
// used verbatim when the live catalog can't be reached.
export const CURATED_MODELS = {
  gemini: [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.5-flash-lite',
    'gemini-flash-latest',
    'gemini-pro-latest',
  ],
  openai: [
    'gpt-4o-mini',
    'gpt-4o',
    'gpt-4.1',
    'gpt-4.1-mini',
    'o3-mini',
  ],
  // OpenCode Zen Go gateway — bare ids, no `opencode/` prefix.
  opencode: [
    'glm-5.3',
    'glm-5.3-flash',
    'kimi-k3',
    'minimax-m3',
    'qwen3.8-max',
  ],
  // OpenRouter ids are vendor-namespaced.
  openrouter: [
    'openai/gpt-4o-mini',
    'anthropic/claude-sonnet-4',
    'google/gemini-2.5-flash',
    'deepseek/deepseek-chat',
    'meta-llama/llama-3.3-70b-instruct',
  ],
  ollama: [
    'llama3.1',
    'llama3',
    'qwen2.5',
    'mistral',
    'gemma2',
    'phi3',
  ],
};

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// ListModels reports `generateContent` support but no modality, so image, TTS,
// music, embedding and live-audio endpoints look like chat models. They can't
// produce StructuredNotes — drop them by id.
const GEMINI_NON_TEXT = /embedding|^aqa$|^imagen|^veo-|^lyria|nano-banana|-tts$|-image(-|$)|transcribe|native-audio|-live(-|$)/;

// OpenAI's /models mixes chat with audio, image, embedding and moderation
// endpoints. Keep the chat families, minus the non-text variants.
const OPENAI_TEXT = /^(gpt|o[1-9]|chatgpt|codex)/i;
const OPENAI_NON_TEXT = /transcribe|tts|audio|realtime|whisper|embedding|moderation|image|dall-e|sora|search|computer-use/i;

const CACHE_TTL_MS = 10 * 60 * 1000; // live catalogs barely change
const ERROR_TTL_MS = 30 * 1000;      // don't hammer a dead endpoint per keystroke
const cache = new Map(); // provider -> { until, payload }

export function clearModelCache(provider) {
  if (provider) cache.delete(provider);
  else cache.clear();
}

/** "1M" / "128K" / "8192" — compact context-window label. */
export function formatContext(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

async function getJson(url, { headers = {}, timeoutMs, fetchImpl }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const entry = (id, label, context) => ({ id, label: label || id, context: Number.isFinite(context) ? context : null });

async function fetchGemini({ env, fetchImpl, timeoutMs }) {
  const key = env.gemini?.apiKey;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const models = [];
  let pageToken = '';
  // ListModels pages at 50 by default; ask for the max and follow the cursor.
  for (let page = 0; page < 5; page += 1) {
    const url = `${GEMINI_BASE}/models?key=${encodeURIComponent(key)}&pageSize=200`
      + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const data = await getJson(url, { timeoutMs, fetchImpl });
    for (const m of data?.models || []) {
      if (!m?.supportedGenerationMethods?.includes('generateContent')) continue;
      const id = String(m.name || '').replace(/^models\//, '');
      if (!id || GEMINI_NON_TEXT.test(id)) continue;
      models.push(entry(id, m.displayName, m.inputTokenLimit));
    }
    pageToken = data?.nextPageToken || '';
    if (!pageToken) break;
  }
  return models;
}

// Shared shape for the OpenAI-compatible `/models` listings.
async function fetchOpenAICompatible({ baseUrl, apiKey, fetchImpl, timeoutMs }) {
  const data = await getJson(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    timeoutMs,
    fetchImpl,
  });
  return (data?.data || []).map((m) => m?.id).filter((id) => typeof id === 'string' && id);
}

async function fetchOpenAI({ env, fetchImpl, timeoutMs }) {
  if (!env.openai?.apiKey) throw new Error('OPENAI_API_KEY is not set');
  const ids = await fetchOpenAICompatible({
    baseUrl: env.openai.baseUrl, apiKey: env.openai.apiKey, fetchImpl, timeoutMs,
  });
  const chat = ids.filter((id) => OPENAI_TEXT.test(id) && !OPENAI_NON_TEXT.test(id));
  // OPENAI_BASE_URL often points at a compatible gateway (LM Studio, vLLM, a
  // proxy) whose ids the heuristic doesn't recognise — show everything rather
  // than nothing.
  return (chat.length ? chat : ids).map((id) => entry(id));
}

async function fetchOpenCode({ env, fetchImpl, timeoutMs }) {
  if (!env.opencode?.apiKey) throw new Error('OPENCODE_API_KEY is not set');
  const ids = await fetchOpenAICompatible({
    baseUrl: env.opencode.baseUrl, apiKey: env.opencode.apiKey, fetchImpl, timeoutMs,
  });
  return ids.map((id) => entry(id));
}

async function fetchOpenRouter({ env, fetchImpl, timeoutMs }) {
  // OpenRouter's catalog is public; the key only matters for inference.
  const data = await getJson(`${env.openrouter.baseUrl.replace(/\/$/, '')}/models`, {
    headers: env.openrouter?.apiKey ? { authorization: `Bearer ${env.openrouter.apiKey}` } : {},
    timeoutMs,
    fetchImpl,
  });
  const models = [];
  for (const m of data?.data || []) {
    if (!m?.id) continue;
    const out = m.architecture?.output_modalities;
    // Image/audio-only endpoints can't return notes.
    if (Array.isArray(out) && out.length && !out.includes('text')) continue;
    models.push(entry(m.id, m.name, m.context_length));
  }
  return models;
}

async function fetchOllama({ env, fetchImpl, timeoutMs }) {
  const url = env.ollama?.url;
  if (!url) throw new Error('OLLAMA_URL is not set');
  const data = await getJson(`${url.replace(/\/$/, '')}/api/tags`, { timeoutMs, fetchImpl });
  return (data?.models || [])
    .map((m) => m?.name)
    .filter((name) => typeof name === 'string' && name)
    .map((name) => entry(name));
}

const FETCHERS = {
  gemini: fetchGemini,
  openai: fetchOpenAI,
  opencode: fetchOpenCode,
  openrouter: fetchOpenRouter,
  ollama: fetchOllama,
};

export const CATALOG_PROVIDERS = Object.keys(FETCHERS);

// Curated shortlist first (in its own order), then everything else A→Z. That
// ordering is what an unfiltered picker and the empty-query autocomplete show.
function order(models, curated) {
  const rank = new Map(curated.map((id, i) => [id, i]));
  return models.sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  });
}

function dedupe(models) {
  const seen = new Set();
  const out = [];
  for (const m of models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/**
 * The catalog for one provider.
 *
 * Returns `{ provider, models: [{ id, label, context }], curated, default,
 * source, error, fetchedAt }` where `source` is 'live' when the provider
 * answered and 'curated' when we fell back to the static shortlist.
 */
export async function listModels(provider, {
  env = envConfig,
  fetchImpl = fetch,
  timeoutMs = 4000,
  refresh = false,
  now = Date.now,
} = {}) {
  const curated = CURATED_MODELS[provider] || [];
  const base = { provider, curated, default: DEFAULT_MODELS[provider] || null };
  const fetcher = FETCHERS[provider];
  if (!fetcher) return { ...base, models: [], source: 'curated', error: `Unknown provider: ${provider}`, fetchedAt: now() };

  const hit = cache.get(provider);
  if (!refresh && hit && hit.until > now()) return hit.payload;

  let payload;
  try {
    const models = dedupe(await fetcher({ env, fetchImpl, timeoutMs }));
    if (!models.length) throw new Error('provider returned no models');
    payload = { ...base, models: order(models, curated), source: 'live', error: null, fetchedAt: now() };
  } catch (err) {
    payload = {
      ...base,
      models: curated.map((id) => entry(id)),
      source: 'curated',
      error: err?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (err?.message || String(err)),
      fetchedAt: now(),
    };
  }
  cache.set(provider, { until: now() + (payload.source === 'live' ? CACHE_TTL_MS : ERROR_TTL_MS), payload });
  return payload;
}

/**
 * Rank a catalog against a search string. Every whitespace-separated token must
 * appear in the id or the display label; exact id, then prefix, then id-substring
 * matches come first, so typing "flash" or "claude son" lands on the obvious pick.
 */
export function searchModels(models, query = '', limit = 25) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return models.slice(0, limit);
  const tokens = q.split(/\s+/);
  const scored = [];
  for (let i = 0; i < models.length; i += 1) {
    const m = models[i];
    const id = m.id.toLowerCase();
    const hay = `${id} ${String(m.label || '').toLowerCase()}`;
    if (!tokens.every((t) => hay.includes(t))) continue;
    const score = id === q ? 0 : id.startsWith(q) ? 1 : id.includes(q) ? 2 : 3;
    scored.push({ m, score, i });
  }
  // Stable within a score band: preserve the catalog's own ordering.
  scored.sort((a, b) => (a.score - b.score) || (a.i - b.i));
  return scored.slice(0, limit).map((s) => s.m);
}
