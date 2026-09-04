// Autocomplete for /setup's free-text model options: the provider's full live
// catalog, searched as you type. Discord takes at most 25 choices per response
// and expects them within 3 seconds, so the catalog fetch is short-timeout and
// served from the in-memory cache in adapters/summarizer/models.js.

import { listModels, searchModels, formatContext } from '../adapters/summarizer/models.js';
import { getGuildConfig } from '../store/config.js';
import { config as envConfig } from '../config/env.js';

export const MAX_CHOICES = 25;
const MAX_NAME = 100; // Discord's per-choice name/value limit

// `id · 128K` — the id is what gets saved, the context window is the hint.
export function modelChoiceName(model) {
  const ctx = formatContext(model.context);
  const suffix = ctx ? ` · ${ctx}` : '';
  const room = MAX_NAME - suffix.length;
  const id = model.id.length > room ? `${model.id.slice(0, room - 1)}…` : model.id;
  return `${id}${suffix}`;
}

/**
 * Which provider's catalog an option should offer. `picked` holds the provider
 * options from the same invocation (they win — the user is switching provider
 * and model together); otherwise fall back to the guild's saved config.
 * Returns null when no provider applies (e.g. fallback set to "none").
 */
export function providerForOption(optionName, picked = {}, cfg = {}) {
  if (optionName === 'model') return picked.provider || cfg.summarizerProvider || null;
  if (optionName === 'fallback_model') {
    const p = picked.fallbackProvider || cfg.summarizerFallbackProvider || cfg.summarizerProvider;
    return !p || p === 'none' ? null : p;
  }
  return null;
}

export async function modelChoices(provider, query = '', opts = {}) {
  if (!provider) return [];
  const { models } = await listModels(provider, { timeoutMs: 2000, ...opts });
  return searchModels(models, query, MAX_CHOICES)
    .map((m) => ({ name: modelChoiceName(m), value: m.id.slice(0, MAX_NAME) }));
}

/**
 * Answer one autocomplete interaction. Discord allows exactly one response, so
 * a catalog failure still has to send something — an empty list, which leaves
 * the user's typed text as-is.
 */
export async function handleAutocomplete(interaction, { db, env = envConfig, ...opts } = {}) {
  try {
    const focused = interaction.options.getFocused(true);
    const cfg = interaction.guildId && db ? getGuildConfig(db, interaction.guildId) : {};
    const provider = providerForOption(focused.name, {
      provider: interaction.options.getString('provider'),
      fallbackProvider: interaction.options.getString('fallback_provider'),
    }, cfg);
    await interaction.respond(await modelChoices(provider, focused.value, { env, ...opts }));
  } catch (err) {
    console.error('autocomplete error:', err);
    await interaction.respond([]).catch(() => {});
  }
}
