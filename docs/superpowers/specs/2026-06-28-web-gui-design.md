# Parley Web GUI — Design

Date: 2026-06-28
Status: Approved (brainstorm)

## Goal

A local admin web GUI for the Parley Discord bot. One operator, on the same
machine as the bot. Lets them: configure the bot (mirror `/setup`), browse
meetings + notes, work a checkable TODO list of action items, and search
transcripts. No login (localhost only).

## Decisions

- **Access:** local admin panel, no auth, bound to `127.0.0.1`. Operator sees ALL guilds.
- **Frontend:** React + Vite SPA, Tailwind for styling.
- **Backend:** Express, same process as the bot, started behind a flag.
- **TODOs:** real checkable tracker (new `todos` table), auto-seeded from summaries.
- **Out of scope (v1):** auth, multi-user, websockets / live "recording now"
  indicator (deferred), todo due dates, manual todo entry beyond what summaries seed.

## Architecture

```
Browser (React SPA)  ──fetch /api/*──▶  src/web/server.js (Express, 127.0.0.1)
                                              │  in-process
                                              ▼
                             open SQLite db handle + live discord.js client
                                              │
                                  db.js / config.js  +  new todos fns
```

- **Same process as the bot.** Started from `src/index.js` when `WEB_UI=1`
  (env) is set. Reuses the already-open `db` handle and the live discord.js
  `client`. The client is how the config editor resolves real **guild names**
  and **channel lists** (for the notes-channel picker) without extra Discord
  API wiring.
- **Bind `127.0.0.1` only.** No auth is intentional; nothing off-machine can
  reach it. Document this in README so nobody exposes the port.
- **Express:** one dependency, gives static serving + routing. Backend stays
  roughly one file (`src/web/server.js`) plus the new db functions.
- **Dev:** Vite dev server (`web/`) proxies `/api` → Express on its own port.
- **Prod:** `vite build` emits `web/dist/`; Express serves it as static + SPA
  fallback to `index.html`.

### Why same-process (rejected alternative)

A separate `npm run web` process is more crash-isolated but needs its own
SQLite handle and **cannot** read live guild/channel names from the bot's
discord.js client. Same-process wins for this local-admin use case.

## Data model

One new table. Everything else reuses existing schema (see `src/store/db.js`).

```sql
CREATE TABLE IF NOT EXISTS todos (
  id         INTEGER PRIMARY KEY,
  guild_id   TEXT NOT NULL,
  meeting_id INTEGER,                  -- source meeting; NULL allowed for future manual adds
  assignee   TEXT,                     -- display name, or NULL = "Unassigned"
  task       TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(meeting_id, assignee, task)   -- dedup when resummarize.js re-runs
);
```

- **Auto-seed:** `saveSummary()` already runs when a meeting is summarized.
  Extend it (or its caller in the orchestrator) to also insert each
  `notes.actionItems[]` row into `todos` via `INSERT OR IGNORE` so the
  `UNIQUE` constraint dedups re-summarization.
- **Backfill:** a one-time seed over existing summaries so the tracker isn't
  empty on first launch. Implemented as an idempotent function called on web
  server start (safe because of `INSERT OR IGNORE`).
- **assignee NULL** renders as "Unassigned", matching `discord-notes.js`.

### New db functions (`src/store/db.js`)

| Function | Returns / does |
|---|---|
| `listGuilds()` | distinct `guild_id` from meetings ∪ guild_config |
| `seedTodos(meetingId, guildId, actionItems)` | INSERT OR IGNORE each action item |
| `backfillTodos()` | seed todos from every existing summary (idempotent) |
| `listTodos(guildId, { open })` | todos for a guild, optionally only `done=0` |
| `setTodoDone(id, done)` | toggle a todo's done flag |

## API

Express, all routes under `/api`. JSON in/out. No auth.

| Method | Route | Backed by |
|---|---|---|
| GET   | `/api/guilds` | `listGuilds()` + names from `client.guilds` |
| GET   | `/api/guilds/:g/meetings` | `listRecent(g, limit)` |
| GET   | `/api/meetings/:id` | `getMeeting` + `getSummary` + `listAttendees` + `listUtterances` |
| GET   | `/api/guilds/:g/todos?open=1` | `listTodos` |
| PATCH | `/api/todos/:id` `{done}` | `setTodoDone` |
| GET   | `/api/guilds/:g/search?q=` | `searchUtterances` |
| GET   | `/api/guilds/:g/config` | `getGuildConfig` + available providers (env) + channel list (client) |
| PATCH | `/api/guilds/:g/config` | `setGuildConfig` after validation |

### Config editor rules (mirror `/setup`)

- **Never accepts API keys.** Keys stay in `.env` only (CLAUDE.md hard rule).
  The form only *shows which providers are usable* based on which keys are
  present in env.
- `PATCH /config` validates: chosen provider's key exists in env; model /
  whisper / language values are in the allowed sets; `notesChannelId` is a real
  channel in that guild. Reject with 400 + message otherwise.
- Channel picker options come from `client.guilds.cache.get(g).channels` (text
  channels only).

## Frontend (`web/`, React + Vite + Tailwind)

Single SPA. Header has a **guild picker** (drives all data). Routes:

- **/meetings** — list (from `listRecent`) → **/meetings/:id** detail: summary
  sections (tldr, topics, decisions, openQuestions), talktime bars, collapsible
  transcript.
- **/todos** — open action items grouped by assignee, checkboxes (PATCH on
  toggle), "show done" filter.
- **/setup** — config form: dropdowns for provider / model / whisper / language /
  summary language, channel picker, auto-join + use-thread switches. Disabled
  providers shown greyed with "set KEY in .env".
- **/search** — query box → matching utterances, each links to its meeting.

Deps: `react`, `react-dom`, `react-router-dom`, `tailwindcss`, `vite`,
`@vitejs/plugin-react`. No component kit in v1 (hand-rolled Tailwind).

## Wiring into the bot

- `src/index.js`: after the client is ready and db is open, if `process.env.WEB_UI`
  is truthy, `import('./web/server.js')` and start it with `{ db, client, port }`.
  Default port 3000 (`WEB_UI_PORT` override).
- `package.json`: add `dev:web` (vite) and `build:web` (vite build) scripts.
  `npm start` unchanged; setting `WEB_UI=1 npm start` enables the panel.

## Security

- Bind `127.0.0.1` only — never `0.0.0.0`. Hard-coded, not configurable, in v1.
- No auth by design; README warns not to port-forward / reverse-proxy it
  without adding auth first.
- Config PATCH validates all inputs server-side (don't trust the SPA).
- API keys never traverse the API or appear in any response.

## Testing

- Node `--test`: new db fns — `seedTodos` dedup, `backfillTodos` idempotency,
  `listTodos` open filter, `setTodoDone`, `listGuilds`.
- One API smoke test: start server against a temp DATA_DIR, hit a couple routes,
  assert shapes. Plain `fetch` (no new test dep) or `supertest` if preferred.
- Config PATCH validation test: reject unknown provider / missing key / bad channel.
- Frontend: manual for v1 (local panel). Vitest only if requested later.

## Deferred (explicit YAGNI)

Auth · multi-user · live recording indicator (poll later) · todo due dates ·
manual todo creation · websockets · UI component kit.
