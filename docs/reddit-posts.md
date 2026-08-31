# Parley — Reddit Posts

Three tailored posts. Copy the title + body for the matching subreddit.

**Before posting:**
- Stagger posts a few days apart (cross-post spam filters).
- Add 1 screenshot/GIF of a notes thread — big engagement lift.
- r/selfhosted: use the self-hosted / show-and-tell flair, no price/marketing talk.
- r/SideProject: the closing question drives comments — keep it.

---

## 1. r/selfhosted

**Title:**

```
I built Parley — a self-hosted Discord meeting-notes bot that transcribes locally (Otter/Fireflies alternative, no cloud recording)
```

**Body:**

I run a lot of meetings in Discord voice and got tired of the options: Otter/Fathom/Fireflies all want a SaaS account, per-seat pricing, and — the dealbreaker — they record everything to someone else's cloud. So I built **Parley**, a fully self-hosted alternative.

**What it does:**
- Joins a Discord voice channel and records each speaker on their own audio stream.
- Transcribes **locally** with a warm [faster-whisper](https://github.com/SYSTRAN/faster-whisper) sidecar (pick model size from `tiny` to `large-v3-turbo`).
- Posts structured AI notes into a thread: TL;DR, topic sections, decisions, open questions, and action items grouped by the person responsible, plus per-speaker talk-time.
- Full-text `/search` over every past meeting (SQLite FTS5), plus `/history`, `/summary`, `/raw`.

**Why it's actually private:** audio never leaves your machine. The only thing that ever goes out is the final transcript text — to whichever summarizer you pick. And if you run **Ollama**, even that stays local. Zero cloud dependency end to end. Audio files are deleted after the notes are delivered.

**The speaker-attribution trick:** no ML diarization. Discord hands you a separate audio stream per user, so every utterance is attributed to the exact right person — not guessed.

**Runs anywhere:** Node's built-in `node:sqlite` (no native DB build), so it works on a Raspberry Pi or a GPU box — only a config value changes. Summarizer is pluggable (Gemini free tier by default, any OpenAI-compatible endpoint, or offline Ollama), switchable per-server with `/setup`, no restart.

Stack: Node (discord.js) bot + Python FastAPI sidecar. ISC licensed.

GitHub: https://github.com/SakethKanchi/parley
Site: https://sakethkanchi.github.io/parley-landing/

Happy to answer setup/privacy questions.

---

## 2. r/opensource

**Title:**

```
Parley: open-source, self-hosted Discord meeting-notes bot — local transcription, pluggable summarizer (ISC)
```

**Body:**

Sharing an open-source project I've been building: **Parley**, a self-hosted meeting-notes bot for Discord voice. ISC licensed, PRs welcome.

**The idea:** an open alternative to Otter/Fathom/Fireflies that you fully control. Audio is transcribed locally; only the final transcript text leaves your machine (or nothing at all if you run a local model).

**Design points that might interest this crowd:**
- **Pluggable summarizer adapter.** Gemini, any OpenAI-compatible endpoint, or offline Ollama — all return the same `StructuredNotes` shape. Adding a provider is one small adapter module.
- **No ML diarization.** Discord delivers per-user audio streams, so speaker attribution is exact, not modeled. Cheap and correct.
- **Two clean processes.** Node (discord.js, ESM) bot + a persistent Python FastAPI sidecar running faster-whisper with the model loaded warm.
- **Zero native build for storage.** Uses Node's built-in `node:sqlite` (Node ≥ 22.5) with FTS5 for full-text search.
- **Per-guild config**, concurrent meetings across channels/servers, structured output (TL;DR, decisions, open questions, action items by assignee).

Good first-issue surface: new summarizer adapters, model/config options, transcript formatting. Architecture is documented in the repo.

GitHub: https://github.com/SakethKanchi/parley

Feedback and contributions welcome — especially on the adapter interface and STT sidecar.

---

## 3. r/SideProject

**Title:**

```
I got tired of meeting-notes SaaS recording everything to the cloud, so I built a self-hosted Discord bot that does it locally
```

**Body:**

Most of my team's meetings happen in Discord voice. I tried the usual notes tools (Otter, Fathom, Fireflies) and bounced off all of them — SaaS account required, per-seat pricing, and every word recorded to a vendor's cloud. So I built **Parley** over the past few months.

**What it does:** joins a Discord voice call, records each speaker separately, transcribes locally with faster-whisper, and drops structured notes into a thread — TL;DR, decisions, open questions, action items grouped by person, plus who-talked-how-much stats. There's full-text search over past meetings too.

**The part I'm proudest of:** speaker attribution with no ML diarization. Discord gives you one audio stream per user, so attribution is exact instead of a guessing game. Felt like cheating when it worked.

**Stack:** Node (discord.js) bot + a Python FastAPI sidecar keeping the whisper model warm. Storage is Node's built-in `node:sqlite` — no native build, runs on a Raspberry Pi or a GPU server alike. Summarizer is pluggable (Gemini free tier, OpenAI-compatible, or fully-offline Ollama).

It's free and open source (ISC).

GitHub: https://github.com/SakethKanchi/parley
Site: https://sakethkanchi.github.io/parley-landing/

Looking for feedback — especially: is local-only transcription a real selling point for you, or do people not care where audio gets processed? And what would make you actually self-host this vs. use a SaaS?
