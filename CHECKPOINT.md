# CHECKPOINT

## Now

Summarizer fallback is live. The two remaining pipeline gaps are closed:
relative transcript timestamps, and a coverage target in `SUMMARY_PROMPT`.
Guild `1362914118918602893` runs **primary `opencode:glm-5.3`, fallback
`gemini:gemini-2.5-flash`**.

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

## Changed this session

`buildTranscript` subtracts the first utterance's `startMs` before `formatMs`,
so lines stamp `[00:00]`…`[85:47]` instead of `[29803170:09]`. Verified against
meeting 83's 488 real utterances. Empty input returns `''`.

`SUMMARY_PROMPT` now requires coverage to scale with the meeting (every distinct
subject is a topic; do not collapse a long meeting into 2–3 topics) and specific
points. Density lives in topics/decisions/openQuestions/actionItems, not the tldr.

## Known gaps

- Gemini's project spend cap was exhausted on 2026-08-31 and is the reason
  meeting 83 originally failed. Assumed to reset at the calendar-UTC month
  boundary; not verified. If it still 429s afterward, raise the cap at
  https://ai.studio/spend.

## Meeting 83

Recovered end to end: transcript was always intact (`transcription_complete=1`),
only summarization had failed. Re-summarized on `opencode:glm-5.3`, 15 todos
seeded, posted to `#meeting-notes` as a 6-message thread. The earlier
`mimo-v2.5` thread was deleted (bot-only, zero human replies).
