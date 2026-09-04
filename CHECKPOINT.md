# CHECKPOINT

## Now

Model selection is catalog-driven: every provider is queried for the models it
actually serves, and both surfaces (dashboard Settings, `/setup model` +
`fallback_model`) are search-and-select over that list. Uncommitted; `npm test`
is 322/322 green.

No blocking work outstanding.

## Locked decisions

- **Primary summarizer is `opencode:glm-5.3`; fallback is `gemini:gemini-2.5-flash`.**
  GLM 5.3 was chosen on measured density: on meeting 83 (86 min, 488 utterances)
  it produced 21.9 bytes/utterance vs 7.4 for `mimo-v2.5`, matching Gemini's
  proven 16–32 band. `mimo-v2.5` silently dropped two entire discussion topics.
- **Fallback is per-guild config, not hardcoded.** `summarizer_fallback_provider`
  / `summarizer_fallback_model` on `guild_config`; NULL means no fallback and
  preserves the old single-provider behaviour exactly.
- **The fallback adapter is constructed lazily**, inside the catch. A fallback
  with a missing API key must never break the primary path at startup.
- **`model_used` records the provider that actually ran**, via
  `FallbackSummarizer.lastUsed`, not the one that was configured.
- **`gpt-5.6-luna` is unusable** on the OpenCode gateway: HTTP 500 even for a
  5-token request. Not a context-size issue.
- **`deepseek-v4-flash` / `-pro` are region-blocked** (403 RegionError, China-hosted,
  needs explicit workspace opt-in). Deliberately not opted in — data-residency
  decision for private meeting transcripts belongs to the owner.
- **Model lists are fetched, never hardcoded.** A curated shortlist survives only
  as the offline fallback and as the ranking hint for an empty query.

## Changed this session

`src/adapters/summarizer/models.js` is now a live catalog module:
`listModels(provider)` hits Gemini `ListModels`, the OpenAI-compatible `/models`
endpoints (OpenAI, OpenCode Zen, OpenRouter) and Ollama `/api/tags`, normalises
to `{ id, label, context }`, and caches 10 min (30 s on failure). Measured live:
gemini 27, opencode 35, openrouter 426; a dead key/host degrades to
`CURATED_MODELS` and says why. `searchModels` ranks exact → prefix → substring
with all query tokens required.

New `src/commands/autocomplete.js` owns `/setup` model autocomplete
(`handleAutocomplete`, 25-choice cap, 2 s catalog timeout, `id · 128K` labels).
`bot.js` routes `isAutocomplete()` to it before the command path.

New `web/src/components/ModelPicker.jsx`: combobox with type-to-filter, arrow/
Enter/Esc keys, context chips, source hint, refresh button. Outside click
cancels (the input doubles as the search box); Enter with no match commits raw
text, so unlisted ids still work. Used for both primary and fallback model.

`DEFAULT_MODELS` is the single source for per-provider defaults — previously
duplicated in `createAdapter`, `setup-logic` and `Setup.jsx`. Side effect: the
opencode default moved `deepseek-v4-flash` → `glm-5.3`, since the old default is
the region-blocked model documented below.

`GET /api/providers/:provider/models` returns the catalog (`?refresh=1` bypasses
the cache, unknown provider → 400); `GET /guilds/:g/config` now ships
`defaultModels` instead of the dead `models` shortlist payload.

## Known gaps

- Gemini's project spend cap was exhausted on 2026-08-31 and is the reason
  meeting 83 originally failed. Assumed to reset at the calendar-UTC month
  boundary; not verified. If it still 429s afterward, raise the cap at
  https://ai.studio/spend.

- `/setup`'s new autocomplete flags only reach Discord when the bot next starts
  (`deployCommands` on ready). The catalog + handler are covered by tests and a
  live smoke run, but no real Discord autocomplete round-trip has been observed.
