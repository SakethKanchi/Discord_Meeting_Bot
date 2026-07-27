import { SUPPORTED_PROVIDERS } from '../adapters/summarizer/index.js';
import { LANGUAGE_CODES, SUMMARY_LANGUAGE_VALUES } from '../adapters/summarizer/languages.js';
import { STT_PROVIDERS, STT_MODELS, sttProviderReady } from '../adapters/stt/index.js';

const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'];

export function providerKeyPresent(provider, env) {
  if (provider === 'gemini') return { ok: !!env.gemini.apiKey, missing: 'GEMINI_API_KEY' };
  if (provider === 'openai') return { ok: !!env.openai.apiKey, missing: 'OPENAI_API_KEY' };
  if (provider === 'opencode') return { ok: !!env.opencode.apiKey, missing: 'OPENCODE_API_KEY' };
  if (provider === 'ollama') return { ok: !!env.ollama.url, missing: 'OLLAMA_URL' };
  return { ok: false, missing: null };
}

export function validateSetup(input, env) {
  const patch = {};

  if (input.provider !== undefined) {
    if (!SUPPORTED_PROVIDERS.includes(input.provider)) {
      return { ok: false, error: `Unknown provider "${input.provider}". Use one of: ${SUPPORTED_PROVIDERS.join(', ')}.` };
    }
    const key = providerKeyPresent(input.provider, env);
    if (!key.ok) return { ok: false, error: `Cannot use ${input.provider}: ${key.missing} is not set in .env.` };
    patch.summarizerProvider = input.provider;
    if (input.model) patch.summarizerModel = input.model;
  }

  if (input.whisperModel !== undefined) {
    if (!WHISPER_MODELS.includes(input.whisperModel)) {
      return { ok: false, error: `Invalid whisper model. Use one of: ${WHISPER_MODELS.join(', ')}.` };
    }
    patch.whisperModel = input.whisperModel;
  }

  // Speech-to-text provider (sidecar | openai). Selecting a cloud
  // provider requires its API key to be set, mirroring the summarizer checks.
  if (input.sttProvider !== undefined) {
    if (!STT_PROVIDERS.includes(input.sttProvider)) {
      return { ok: false, error: `Unknown STT provider "${input.sttProvider}". Use one of: ${STT_PROVIDERS.join(', ')}.` };
    }
    const ready = sttProviderReady(input.sttProvider, env);
    if (!ready.ok) return { ok: false, error: `Cannot use ${input.sttProvider} STT: ${ready.missing} is not set in .env.` };
    patch.sttProvider = input.sttProvider;
    // A model supplied alongside the provider must belong to that provider.
    if (input.sttModel !== undefined && input.sttModel !== null && input.sttProvider !== 'sidecar') {
      if (!STT_MODELS[input.sttProvider].includes(input.sttModel)) {
        return { ok: false, error: `Invalid ${input.sttProvider} model. Use one of: ${STT_MODELS[input.sttProvider].join(', ')}.` };
      }
      patch.sttModel = input.sttModel;
    }
  } else if (input.sttModel !== undefined && input.sttModel !== null) {
    // Model changed without naming a provider: validate against the current one.
    const provider = env.sttProvider || (typeof input.currentSttProvider === 'string' ? input.currentSttProvider : 'sidecar');
    if (provider !== 'sidecar' && !STT_MODELS[provider]?.includes(input.sttModel)) {
      return { ok: false, error: `Invalid ${provider} model. Use one of: ${(STT_MODELS[provider] || []).join(', ')}.` };
    }
    patch.sttModel = input.sttModel;
  }

  if (input.notesChannelId !== undefined) patch.notesChannelId = input.notesChannelId;
  if (input.useThread !== undefined) patch.useThread = !!input.useThread;
  if (input.autoJoin !== undefined) patch.autoJoin = !!input.autoJoin;
  if (input.keepAudio !== undefined) patch.keepAudio = !!input.keepAudio;

  // Voice channels auto-join is restricted to. Empty array = any channel.
  // Set from the dashboard (slash options can't express a multi-select).
  if (input.autoJoinChannelIds !== undefined) {
    if (!Array.isArray(input.autoJoinChannelIds)) {
      return { ok: false, error: 'autoJoinChannelIds must be an array of voice channel ids.' };
    }
    const ids = [...new Set(input.autoJoinChannelIds.map((v) => String(v)))];
    if (ids.some((id) => !/^\d{5,25}$/.test(id))) {
      return { ok: false, error: 'autoJoinChannelIds contains an invalid channel id.' };
    }
    if (ids.length > 25) {
      return { ok: false, error: 'Too many auto-join channels (max 25).' };
    }
    patch.autoJoinChannelIds = ids;
  }
  if (input.language !== undefined) {
    if (!LANGUAGE_CODES.has(input.language)) {
      return { ok: false, error: `Invalid language. Use one of: ${[...LANGUAGE_CODES].join(', ')}.` };
    }
    patch.language = input.language;
  }

  if (input.summary_language !== undefined) {
    if (!SUMMARY_LANGUAGE_VALUES.has(input.summary_language)) {
      return { ok: false, error: `Invalid summary language. Use one of: ${[...SUMMARY_LANGUAGE_VALUES].join(', ')}.` };
    }
    patch.summaryLanguage = input.summary_language;
  }

  return { ok: true, patch };
}

export { WHISPER_MODELS };

export function availableProviders(env) {
  return SUPPORTED_PROVIDERS.map((provider) => ({ provider, ...providerKeyPresent(provider, env) }));
}
