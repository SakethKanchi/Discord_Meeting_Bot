# Parley Web GUI — Redesign (Granola-style)

Date: 2026-06-29
Status: Approved (brainstorm)
Supersedes the layout/UX of: `docs/superpowers/specs/2026-06-28-web-gui-design.md`
(backend stays; only the frontend presentation changes, plus a small todos-filter API addition)

## Why

The v1 dashboard shipped working but over-built vs the industry standard for AI
meeting notetakers (Granola, Fireflies, Otter, Fathom, Circleback, tl;dv).
Research findings that drive this redesign:

- **You land on the meeting note, not a dashboard.** The note is the universal hero.
- **Action items live inside the note first.** Any cross-meeting view is derived.
- **The assignee-grouped "everyone's items" wall is the one layout every tool
  avoids.** Defaults are personal ("my items") or filterable — never a firehose.
- **Document-feel over panel-feel:** thin sidebar (a meetings list), single-column
  note, generous whitespace, no heavy border grids.

Parley wrinkle: it **already posts notes into Discord**, so the web app is not the
note-delivery surface — its job is a calm browse / search / configure archive.

**Capture-model note (drives feature priorities):** Granola's signature interaction
is *note-while-you-talk* — the human writes, AI enhances. Parley has no human
note-taking surface: it auto-captures Discord voice and auto-emits notes +
auto-assigned action items. That is **Circleback's / Fathom's model**, not
Granola's. So borrow Granola's *layout* (thin meetings rail + single-column
reading note) but follow Circleback's *feature model*: topic-grouped notes,
an Action-items view scoped by assignee, and **natural-language Q&A over a
meeting** — which both genre leaders (Circleback's archive query, Otter Chat,
Granola chat) now treat as core, not optional. The enhance-my-notes /
gray-AI-text-vs-user-text interaction is deliberately NOT mimicked (no human
notes exist to enhance).

## Decisions (locked in brainstorm)

1. **Cross-meeting action items:** a dedicated "Action items" page, defaults to
   **all-open**, with a prominent **`Assignee ▾` filter** (Parley has no auth /
   viewer identity, so "my items" is achieved by picking a person, not by login).
   Per-meeting checkable action items also remain inside each note.
2. **Landing view:** land directly on the **latest meeting's note** for the
   selected guild. Note is the hero; a thin left sidebar is the meetings rail +
   search field.
3. **Theme:** **dark by default** (brand-consistent with the dark landing page),
   with a **light reading toggle**, persisted in `localStorage`. (Note: the genre
   leaders are all light/reading-first; dark-default is a brand choice the light
   toggle covers.)
4. **Ask this meeting (natural-language Q&A):** an ask box inside the reading view.
   Question + the meeting's transcript go to the guild's configured summarizer
   provider; answer rendered inline. Reuses the existing summarizer adapters (new
   `ask()` text-completion path) and per-guild provider config. Single-meeting
   scope in v1 (archive-wide query deferred). No keys cross the API — same provider
   plumbing as summarization.

## Information Architecture

One primary screen — the **reading view**:

```
┌ header ─────────────────────────────────────────────────┐
│ Parley   [Fund Flow ▾]              ☾  Action items   ⚙  │
├──────────────┬──────────────────────────────────────────┤
│ search…      │  #general · Jun 28                        │
│ • #general   │  <TL;DR as opening paragraph, no label>   │
│   Jun 28     │  Topics / Decisions / Open questions      │
│   #eng       │  Action items   ☐ Alex — split tickets    │
│   Jun 26     │  ▸ Transcript (collapsed)                 │
└──────────────┴──────────────────────────────────────────┘
```

Routes:
- `/` → reading view, auto-opens the latest meeting for the selected guild. If the
  guild has no meetings, the main pane shows a calm empty state ("No meetings yet").
- `/meetings/:id` → reading view focused on that meeting (sidebar still present).
- `/action-items` → filtered cross-meeting action items page.
- `/search?q=` → the main pane renders a results list (replacing the note) with a
  clear control to return to the note; each result links to its meeting. Search
  input lives in the sidebar and navigates here on submit.
- `/setup` → config form (gear icon), logic unchanged, restyled.

Header (the entire top-level nav): wordmark · guild picker · theme toggle (☾/☀) ·
"Action items" link · gear (Setup). No 4-tab bar.

**Deleted from v1:** the 4-equal-tab `Layout` nav, and the global assignee-grouped
`Todos.jsx` wall (replaced by `/action-items` filtered page + in-note checkboxes).

## Components (frontend, `web/src/`)

- `components/Layout.jsx` — rebuilt: slim header (wordmark, guild picker, theme
  toggle, Action items link, gear) + the two-pane reading shell (sidebar rail +
  `<Outlet/>` main). Sidebar holds the meetings list + search input.
- `components/MeetingsRail.jsx` (new) — the thin sidebar list of meetings for the
  selected guild; highlights the active one; contains the search field.
- `pages/Reading.jsx` (new, replaces the old full-page `Meetings.jsx`) — the main
  pane: renders the active meeting note. On `/` with no id, redirects to the latest
  meeting. The note rendering (TL;DR lede, topics, decisions, open questions,
  action-item checkboxes, collapsible transcript, talk-time) is the restyled
  successor of `MeetingDetail.jsx`. Includes an **"Ask this meeting"** box
  (POST `…/meetings/:id/ask`) rendering the answer inline.
- `pages/ActionItems.jsx` (new, replaces `Todos.jsx`) — cross-meeting list, default
  open-only, `Assignee ▾` dropdown (populated from a new assignees endpoint), each
  item checkable (PATCH) and linking to its source meeting.
- `pages/Search.jsx` — restyled; can render into the main pane.
- `pages/Setup.jsx` — restyled only; the provider/model/channel/theme logic from the
  prior tasks (incl. the controlled-model + provider-default fix) is unchanged.
- `ThemeContext.jsx` (new) — `{theme, setTheme}`; writes `data-theme` on `<html>`,
  persists to `localStorage` (key `parley-theme`), defaults `dark`.
- `GuildContext.jsx` — unchanged behavior (add `.catch` per the v1 follow-up).
- `index.css` / `tailwind.config.js` — token system reworked into CSS variables with
  a dark and light set; `darkMode: ['selector', '[data-theme="dark"]']`. Granola
  principles: remove panel boxes, drop uppercase micro-labels, hairline dividers,
  generous line-height, single-column note, one refined type scale. Motion minimal
  (note cross-fade on switch).

The actual visual craft is executed with the **impeccable** frontend skill during
implementation so the result is not templated.

## Data flow

- Reading view: `GuildContext` provides `guildId` → `MeetingsRail` fetches
  `api.meetings(guildId)` for the rail and picks the latest as default → `Reading`
  fetches `api.meeting(id)` for the active note. Theme is independent (ThemeContext).
- Action items: `ActionItems` fetches the assignee list + filtered todos for the
  selected guild; checkbox toggles PATCH then refetch.

## Backend deltas (small; everything else untouched)

The v1 backend (todos table, auto-seed, backfill, all `/api` read/config endpoints,
the 127.0.0.1 server) stays exactly as merged. Add only:

1. `db.listTodos(guildId, { open, assignee })` — extend the existing function with an
   optional `assignee` filter (exact match; `assignee` of `null`/"Unassigned"
   selectable). Keep the existing `{open}` behavior and the existing call sites
   working (assignee optional).
2. `db.listAssignees(guildId)` (new) — distinct assignees for a guild's todos
   (NULL surfaced as the "Unassigned" marker), alphabetical, for the dropdown.
3. API: `GET /api/guilds/:g/todos` gains an optional `&assignee=` query param;
   `GET /api/guilds/:g/assignees` (new) returns `[string|null]` (or `[{assignee}]`).
4. **Ask-AI:** add `ask(prompt)` (plain-text completion) to each summarizer adapter
   (`gemini/openai/opencode/ollama`, plus `fake` for tests) and an `askMeeting({cfg,
   env, question, transcript, meta})` helper in `src/adapters/summarizer/ask.js`
   that builds a transcript-grounded prompt and dispatches via the existing
   `getSummarizer(cfg, env)`. New endpoint `POST /api/guilds/:g/meetings/:id/ask`
   `{question}` → `{answer}`; uses the meeting's guild config for the provider,
   404 unknown meeting, 400 empty question, 502 on provider error.
5. Frontend `api.js`: `todos(guildId, {open, assignee})`, `assignees(guildId)`,
   `ask(meetingId, question)`.

No keys cross the API; 127.0.0.1-only; validateSetup remains the only config-write
path. These invariants are unchanged.

## Testing

- Backend: extend `test/todos.test.js` / `test/api.test.js` — `listTodos` assignee
  filter (incl. null/Unassigned), `listAssignees` distinctness, the
  `?assignee=` query param, and that existing no-assignee calls still pass.
  Full `node --test` stays green.
- Frontend: no unit tests (v1 convention); each task verified by `npm --prefix web
  run build` succeeding. A final manual pass in the running app.

## Out of scope (explicit YAGNI)

Auth / multi-user · websockets / live indicator · external-tool export
(Notion/Linear) — noted by research as the category's eventual action-item workflow,
but deferred · manual todo creation · per-item due dates · analytics ·
**archive-wide Q&A / chat** (v1 ask is single-meeting only) · streaming ask
responses · ask conversation history (each ask is one-shot, stateless).

## Deferred v1 follow-ups folded into this work where cheap

- Shared fetch `.catch` → a visible error/empty state across pages (the redesign
  rebuilds these components anyway).
- The Todos empty-state copy and uncontrolled-input issues disappear with the
  rebuild. `Number(id)` guard / JSON-404 for unknown `/api/*` remain optional
  hardening, not required by this redesign.
