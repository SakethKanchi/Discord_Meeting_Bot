# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — run the bot (src/index.js). Requires the STT sidecar running too.
- `npm test` — run all unit tests (`node --test`).
- `npm run sidecar` — start the Python faster-whisper STT sidecar (stt_sidecar/server.py).
- Sidecar tests: `cd stt_sidecar && .venv/bin/python -m pytest test_server.py -q` (a local venv exists; deps in stt_sidecar/requirements.txt).
- Run a single Node test file: `node --test test/<name>.test.js`.
- Requires Node >= 22.5 (uses the built-in `node:sqlite`).

## Architecture (big picture)

Two processes: a Node (discord.js, ESM) bot + a persistent Python FastAPI sidecar running faster-whisper with the model loaded once (warm).

Per-user Discord audio streams give free speaker attribution (no ML diarization): each speaker's track is transcribed separately and tagged with their display name, then merged by timestamp.

Flow: capture per-speaker PCM → on meeting end, orchestrator (src/pipeline/orchestrator.js) transcribes each track via the sidecar → stores utterances in SQLite → summarizes via a pluggable adapter → saves summary → delivers a structured notes thread to Discord.

Concurrency: src/voice/meeting-manager.js keys active meetings by guild+channel (multiple channels record at once; no global singleton).

Pluggable summarizer (src/adapters/summarizer/): gemini (default), ollama, openai, opencode, openrouter — all return the same StructuredNotes shape. Chosen per-guild via /setup.

Storage: src/store/db.js (node:sqlite, FTS5 for /search). Per-guild runtime config in src/store/config.js.

Slash commands: /join /leave /summary /history /search /setup (src/commands/). Auto-join when >1 human, auto-leave when ≤1 (src/voice/decisions.js).

## Key conventions / gotchas

- `DATA_DIR` resolved once in src/config/env.js (`DATA_DIR` env → `/data` if present → cwd). SQLite db + audio/ live under it.
- Secrets (DISCORD_TOKEN, GEMINI_API_KEY, OPENAI_API_KEY, OPENCODE_API_KEY, OPENROUTER_API_KEY, OLLAMA_URL) live in .env ONLY — /setup never accepts API keys (Discord retains message content). /setup picks provider/model/behavior and validates the needed key exists in env.
- Summarizer adapters return StructuredNotes { tldr, topics[], decisions[], openQuestions[], actionItems[{assignee,task}] }; action items are rendered grouped per person.
- Bot uses minimal gateway intents [Guilds, GuildVoiceStates] — do NOT add MessageContent (privileged; would fail login).
- PCM filenames are `audio/<meetingId>/<userId>_<startMs>.pcm` (avoids the v1 underscore-in-name parsing bug).
