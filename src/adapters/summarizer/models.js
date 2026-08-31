// Curated model suggestions per provider for the Setup UI's combobox.
// These are *suggestions* only — the field stays free-text so any model id
// the provider supports can still be entered manually.

export const MODEL_SUGGESTIONS = {
  gemini: [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
  ],
  openai: [
    'gpt-4o-mini',
    'gpt-4o',
    'gpt-4.1',
    'gpt-4.1-mini',
    'o3-mini',
    'o1-mini',
  ],
  // OpenCode Zen Go gateway — bare ids (no `opencode/` prefix). Full list at
  // https://opencode.ai/zen/go/v1/models
  opencode: [
    'deepseek-v4-flash',
    'minimax-m3',
    'kimi-k2.6',
    'glm-5.1',
    'qwen3.7-max',
  ],
  // OpenRouter gateway — ids are vendor-namespaced. Full list at
  // https://openrouter.ai/models
  openrouter: [
    'openai/gpt-4o-mini',
    'anthropic/claude-sonnet-4',
    'google/gemini-2.5-flash',
    'meta-llama/llama-3.3-70b-instruct',
    'deepseek/deepseek-chat',
  ],
  // Fallbacks when a live Ollama tag query isn't available.
  ollama: [
    'llama3.1',
    'llama3',
    'qwen2.5',
    'mistral',
    'gemma2',
    'phi3',
  ],
};

/**
 * Query a running Ollama server for its installed models. Returns model name
 * strings (e.g. "llama3.1:8b"), or [] if the server is unreachable. Short
 * timeout so the Setup page never hangs on a dead Ollama.
 */
export async function fetchOllamaModels(url, { timeoutMs = 1500 } = {}) {
  if (!url) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/tags`, { signal: ctrl.signal });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.models) ? data.models.map((m) => m.name).filter(Boolean) : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
