# CHECKPOINT

## Now

Summarizer fallback is implemented, configurable from `/setup` and the web
Settings page, tested (291/291 suite green), browser-verified, and live.
Guild `1362914118918602893` runs **primary `opencode:glm-5.3`, fallback
`gemini:gemini-2.5-flash`**.

No blocking work outstanding. Remaining items are the two optional fixes under
Known gaps (prompt density target, `formatMs` epoch timestamps).

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

## Changed this session

New: `src/adapters/summarizer/fallback.js`, `test/summarizer-fallback.test.js`.
Modified: `src/adapters/summarizer/index.js` (split out `createAdapter`, compose
fallback), `src/store/config.js` (+2 fields), `src/store/db.js` (+2 columns,
schema + migration), `src/pipeline/orchestrator.js`, `src/pipeline/retry.js` and
`src/web/api.js` merge path (truthful `model_used`; don't clobber a `userMessage`
the wrapper already set).

Fallback exposed in the UI: `src/commands/setup-logic.js` (validation, `none`
clears, model defaults to the provider's first suggestion), `src/commands/definitions.js`
(`fallback_provider` / `fallback_model` options), `src/bot.js` (option mapping),
`web/src/pages/Setup.jsx` (Fallback field in the Summarizer card), plus
`test/setup-logic.test.js` and `test/definitions.test.js`.

Unrelated pre-existing uncommitted work was already in the tree on arrival and
was not touched.

## Known gaps

- Nothing blocking. The `/setup` wiring gap is closed.
- `SUMMARY_PROMPT` has no length/coverage target, so summary density is entirely
  at the model's discretion. This is the root cause of the meeting-83
  under-summarization and it still affects long meetings on any provider.
- `buildTranscript` feeds absolute epoch `startMs` into `formatMs`, which expects
  a relative offset, so every transcript line is stamped `[29803170:09]` instead
  of `[00:09]`. The model gets no usable timing signal. One-line fix, untaken.
- Gemini's project spend cap was exhausted on 2026-08-31 and is the reason
  meeting 83 originally failed. Assumed to reset at the calendar-UTC month
  boundary; not verified. If it still 429s afterward, raise the cap at
  https://ai.studio/spend.

## Meeting 83

Recovered end to end: transcript was always intact (`transcription_complete=1`),
only summarization had failed. Re-summarized on `opencode:glm-5.3`, 15 todos
seeded, posted to `#meeting-notes` as a 6-message thread. The earlier
`mimo-v2.5` thread was deleted (bot-only, zero human replies).
