import { FakeSummarizer } from './fake.js';
import { GeminiSummarizer } from './gemini.js';
import { OllamaSummarizer } from './ollama.js';
import { OpenAISummarizer } from './openai.js';
import { OpenCodeSummarizer } from './opencode.js';
import { OpenRouterSummarizer } from './openrouter.js';
import { FallbackSummarizer } from './fallback.js';
import { config as envConfig } from '../../config/env.js';

export function createAdapter(provider, model, env = envConfig) {
  switch (provider) {
    case 'fake': return new FakeSummarizer();
    case 'gemini': return new GeminiSummarizer(model, env.gemini.apiKey);
    case 'ollama': return new OllamaSummarizer(model, env.ollama.url);
    case 'openai': return new OpenAISummarizer(model, env.openai.baseUrl, env.openai.apiKey);
    case 'opencode': return new OpenCodeSummarizer(model || 'deepseek-v4-flash', env.opencode.baseUrl, env.opencode.apiKey);
    case 'openrouter': return new OpenRouterSummarizer(model || 'openai/gpt-4o-mini', env.openrouter.baseUrl, env.openrouter.apiKey);
    default: throw new Error(`Unknown summarizer provider: ${provider}`);
  }
}

const label = (provider, model) => `${provider}:${model || ''}`;

export function getSummarizer(cfg, env = envConfig) {
  const primary = createAdapter(cfg.summarizerProvider, cfg.summarizerModel, env);
  const fbProvider = cfg.summarizerFallbackProvider;
  const fbModel = cfg.summarizerFallbackModel;
  const primaryLabel = label(cfg.summarizerProvider, cfg.summarizerModel);
  const fallbackLabel = label(fbProvider, fbModel);
  // No fallback configured, or it names the same provider+model as the primary
  // (retrying an identical dead endpoint buys nothing) — hand back the bare adapter.
  if (!fbProvider || fallbackLabel === primaryLabel) return primary;
  return new FallbackSummarizer(primary, () => createAdapter(fbProvider, fbModel, env), {
    label: primaryLabel,
    fallbackLabel,
  });
}

export const SUPPORTED_PROVIDERS = ['gemini', 'ollama', 'openai', 'opencode', 'openrouter'];
