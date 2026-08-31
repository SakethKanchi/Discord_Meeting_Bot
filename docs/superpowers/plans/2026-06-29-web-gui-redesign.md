# Parley Web GUI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use **superpowers:subagent-driven-development** — one fresh subagent per task, review between tasks. Frontend visual craft (Tasks 5–9) is executed with the **impeccable** skill so the result is not templated.

> **Execution:** Dispatch a fresh subagent per Task (1→9, in order). After each: run its tests / build, review the diff, then dispatch the next. Backend tasks (1–3) are TDD with `node --test`. Frontend tasks (5–9) verify via `npm --prefix web run build` + a manual pass (v1 convention: no FE unit tests).

**Goal:** Restyle the v1 admin dashboard into a Granola-layout / Circleback-feature reading view: land on the latest meeting note, thin meetings rail + search in a sidebar, single-column note, an Action-items page filtered by assignee, dark-default theme with a light toggle, and an **"Ask this meeting"** natural-language Q&A box. Backend stays as merged except three small additive deltas (assignee filter, assignees endpoint, ask endpoint).

**Spec:** `docs/superpowers/specs/2026-06-29-web-gui-redesign-design.md` (read it first).

## Global constraints (unchanged from v1)

- Node `>=22.5`, ESM. Server binds `127.0.0.1` only. No API keys ever cross the API.
- Config writes go only through `validateSetup` + `setGuildConfig`. Allowed value sets imported from their owning modules, never redefined.
- New backend tests are `*.test.js` under `test/`, run with `node --test`.
- Ask-AI reuses the existing per-guild provider plumbing (`getSummarizer(cfg, env)`); the question + transcript go to the same provider that summarized the meeting. Keys stay in `.env`.

---

## Task 1: db — assignee filter + `listAssignees`

**Files:** modify `src/store/db.js` (extend `listTodos` ~line 128; add `listAssignees`). Test: `test/todos-assignee.test.js`.

**Interfaces:**
- `db.listTodos(guildId, { open, assignee } = {})` — adds optional `assignee` (exact match). `assignee: null` selects unassigned rows (`assignee IS NULL`). Existing `{open}`-only and no-arg calls keep working.
- `db.listAssignees(guildId)` — distinct assignees across that guild's todos, alphabetical, NULL included (callers render it as "Unassigned"). Returns `[{ assignee }]` (`assignee` may be `null`).

- [ ] **Step 1: Failing test** — `test/todos-assignee.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db.js';

test('listTodos filters by assignee, including null/Unassigned', () => {
  const db = openDb(':memory:');
  const m = db.createMeeting({ guildId: 'g1', channelId: 'c', channelName: 'g', startedAt: 'now' });
  db.seedTodos(m, 'g1', [{ assignee: 'Alice', task: 'a' }, { assignee: 'Bob', task: 'b' }, { assignee: null, task: 'c' }]);
  assert.equal(db.listTodos('g1', { assignee: 'Alice' }).length, 1);
  assert.equal(db.listTodos('g1', { assignee: null }).length, 1);   // unassigned
  assert.equal(db.listTodos('g1').length, 3);                       // no filter unchanged
  assert.equal(db.listTodos('g1', { open: true }).length, 3);       // open-only unchanged
});

test('listAssignees returns distinct assignees incl. null', () => {
  const db = openDb(':memory:');
  const m = db.createMeeting({ guildId: 'g1', channelId: 'c', channelName: 'g', startedAt: 'now' });
  db.seedTodos(m, 'g1', [{ assignee: 'Bob', task: 'b' }, { assignee: 'Alice', task: 'a' }, { assignee: 'Alice', task: 'a2' }, { assignee: null, task: 'c' }]);
  const names = db.listAssignees('g1').map((r) => r.assignee);
  assert.deepEqual(names, [null, 'Alice', 'Bob']); // null first, then alpha
});
```

- [ ] **Step 2: Run, verify FAIL** — `node --test test/todos-assignee.test.js`.

- [ ] **Step 3: Implement.** Replace `listTodos` and add `listAssignees`:

```js
    listTodos(guildId, { open = false, assignee } = {}) {
      const where = ['guild_id = ?'];
      const args = [guildId];
      if (open) where.push('done = 0');
      if (assignee !== undefined) {
        if (assignee === null) where.push('assignee IS NULL');
        else { where.push('assignee = ?'); args.push(assignee); }
      }
      return sql.prepare(`SELECT * FROM todos WHERE ${where.join(' AND ')} ORDER BY id DESC`).all(...args);
    },
    listAssignees(guildId) {
      // NULL sorts first (SQLite), then alphabetical — the dropdown renders NULL as "Unassigned".
      return sql.prepare(
        `SELECT DISTINCT assignee FROM todos WHERE guild_id = ? ORDER BY assignee IS NOT NULL, assignee`
      ).all(guildId);
    },
```

- [ ] **Step 4: Run, verify PASS.** Then `node --test` (confirm existing `test/todos.test.js` still green — the no-arg/`{open}` call sites are untouched).

- [ ] **Step 5: Commit** — `feat(store): assignee filter on listTodos + listAssignees`.

---

## Task 2: api — `?assignee=` param + `GET /assignees`

**Files:** modify `src/web/api.js` (todos route ~line 38; add assignees route). Test: extend `test/api.test.js`.

**Interfaces:**
- `GET /api/guilds/:g/todos?open=1&assignee=<name>` — `assignee` omitted = all; `assignee=` (empty) or `assignee=__unassigned__` = unassigned rows. (Use a sentinel because an empty query value is ambiguous; pick `__unassigned__`.)
- `GET /api/guilds/:g/assignees` → `[{ assignee }]` (assignee may be `null`).

- [ ] **Step 1: Failing test** (add to `test/api.test.js`, reuse its `appWith`/`listen` helpers):

```js
test('todos assignee filter + assignees endpoint', async () => {
  const db = openDb(':memory:');
  const m = db.createMeeting({ guildId: 'g1', channelId: 'c', channelName: 'g', startedAt: 'now' });
  db.seedTodos(m, 'g1', [{ assignee: 'Alice', task: 'a' }, { assignee: null, task: 'c' }]);
  const { base, close } = await listen(appWith(db));
  try {
    const all = await (await fetch(`${base}/api/guilds/g1/todos`)).json();
    assert.equal(all.length, 2);
    const alice = await (await fetch(`${base}/api/guilds/g1/todos?assignee=Alice`)).json();
    assert.equal(alice.length, 1);
    const un = await (await fetch(`${base}/api/guilds/g1/todos?assignee=__unassigned__`)).json();
    assert.equal(un.length, 1);
    const names = (await (await fetch(`${base}/api/guilds/g1/assignees`)).json()).map((r) => r.assignee);
    assert.deepEqual(names, [null, 'Alice']);
  } finally { close(); }
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement.** Replace the todos GET route and add assignees:

```js
  r.get('/guilds/:g/todos', (req, res) => {
    const { open, assignee } = req.query;
    const opts = { open: open === '1' };
    if (assignee !== undefined) opts.assignee = assignee === '__unassigned__' ? null : assignee;
    res.json(db.listTodos(req.params.g, opts));
  });

  r.get('/guilds/:g/assignees', (req, res) => {
    res.json(db.listAssignees(req.params.g));
  });
```

- [ ] **Step 4: Run, verify PASS** (`node --test test/api.test.js`).

- [ ] **Step 5: Commit** — `feat(web): todos assignee filter + assignees endpoint`.

---

## Task 3: Ask-AI backend — adapter `ask()` + helper + endpoint

**Files:**
- Modify: `src/adapters/summarizer/gemini.js`, `openai.js`, `opencode.js`, `ollama.js`, `fake.js` (add `ask`).
- Create: `src/adapters/summarizer/ask.js` (helper).
- Modify: `src/web/api.js` (add ask import + POST route).
- Test: `test/ask.test.js` (adapter+helper, uses `fake`) and one route case in `test/api.test.js`.

**Interfaces:**
- Each adapter gains `async ask(prompt) → string` (plain-text completion, no JSON schema).
- `askMeeting({ cfg, env, question, transcript, meta }) → Promise<string>` — builds a transcript-grounded prompt and calls `getSummarizer(cfg, env).ask(...)`.
- `POST /api/guilds/:g/meetings/:id/ask` `{question}` → `{answer}`; 404 unknown meeting, 400 empty question, 502 on provider error.

- [ ] **Step 1: Failing test** — `test/ask.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSummarizer } from '../src/adapters/summarizer/fake.js';
import { buildAskPrompt, askMeeting } from '../src/adapters/summarizer/ask.js';

test('fake adapter ask returns text', async () => {
  const s = new FakeSummarizer();
  assert.match(await s.ask('hi'), /fake/i);
});

test('askMeeting builds a grounded prompt and dispatches via getSummarizer', async () => {
  const prompt = buildAskPrompt('Who owns it?', 'Alice: I will.', { attendees: ['Alice'] });
  assert.match(prompt, /Alice: I will\./);
  assert.match(prompt, /Who owns it\?/);
  const ans = await askMeeting({ cfg: { summarizerProvider: 'fake' }, env: {}, question: 'q', transcript: 't', meta: {} });
  assert.equal(typeof ans, 'string');
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Add `ask()` to each adapter.**

`fake.js` — canned, deterministic for tests:
```js
  async ask(prompt) { return this.cannedAnswer || `Fake answer (${String(prompt).length} chars).`; }
```

`gemini.js` — needs a schema-free model handle, so keep `genAI` + model name on the instance. In the constructor add `this.genAI = new GoogleGenerativeAI(apiKey); this.modelName = model;` (reuse `this.genAI` to build the existing summarize model too), then:
```js
  async ask(prompt) {
    const model = this.genAI.getGenerativeModel({ model: this.modelName }); // no responseSchema → free text
    const result = await withRetry(() => model.generateContent(prompt));
    return result.response.text();
  }
```

`openai.js` and `opencode.js` (identical except the `httpError` label — `'OpenAI'` / `'OpenCode'`):
```js
  async ask(prompt) {
    const body = await withRetry(async () => {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw httpError('OpenAI', res.status, await res.text().catch(() => ''));
      return res.json();
    });
    return body.choices?.[0]?.message?.content ?? '';
  }
```

`ollama.js`:
```js
  async ask(prompt) {
    const body = await withRetry(async () => {
      const res = await this.fetchImpl(`${this.url}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, stream: false, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw httpError('Ollama', res.status, await res.text().catch(() => ''));
      return res.json();
    });
    return body.message?.content ?? '';
  }
```

- [ ] **Step 4: Create the helper** — `src/adapters/summarizer/ask.js`:

```js
import { getSummarizer } from './index.js';

export function buildAskPrompt(question, transcript, meta = {}) {
  return `Answer the question using ONLY the meeting transcript below. If the transcript does not contain the answer, say so plainly. Be concise.

Meeting: ${meta.channelName || ''} ${meta.date ? `on ${meta.date}` : ''}
Attendees: ${(meta.attendees || []).join(', ')}

Transcript:
${transcript}

Question: ${question}`;
}

export async function askMeeting({ cfg, env, question, transcript, meta }) {
  const s = getSummarizer(cfg, env);
  if (typeof s.ask !== 'function') throw new Error(`Provider ${cfg.summarizerProvider} does not support Q&A`);
  return s.ask(buildAskPrompt(question, transcript, meta));
}
```

- [ ] **Step 5: Add the endpoint.** In `src/web/api.js`, add import `import { askMeeting } from '../adapters/summarizer/ask.js';` (`getGuildConfig` and `env` are already imported), then inside `apiRouter`:

```js
  r.post('/guilds/:g/meetings/:id/ask', async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    const question = (req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: 'question required' });
    const transcript = db.listUtterances(id).map((u) => `${u.display_name}: ${u.text}`).join('\n');
    try {
      const answer = await askMeeting({
        cfg: getGuildConfig(db, meeting.guild_id), env, question, transcript,
        meta: { channelName: meeting.channel_name, date: meeting.started_at,
          attendees: db.listAttendees(id).map((a) => a.display_name) },
      });
      res.json({ answer });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
```

- [ ] **Step 6: Route test** (add to `test/api.test.js`). Configure the guild to the `fake` provider by writing the config row directly (bypasses `validateSetup`, which rejects `fake`):

```js
test('POST ask returns an answer using the guild provider', async () => {
  const db = openDb(':memory:');
  const id = db.createMeeting({ guildId: 'g1', channelId: 'c', channelName: 'gen', startedAt: 'now' });
  db.addUtterance({ meetingId: id, userId: 'u', displayName: 'Al', startMs: 0, endMs: 5, text: 'ship friday' });
  db.sql.prepare(`INSERT INTO guild_config (guild_id, summarizer_provider) VALUES ('g1', 'fake')`).run();
  const { base, close } = await listen(appWith(db));
  try {
    const r = await fetch(`${base}/api/guilds/g1/meetings/${id}/ask`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'when do we ship?' }),
    });
    assert.equal(r.status, 200);
    assert.equal(typeof (await r.json()).answer, 'string');
    const bad = await fetch(`${base}/api/guilds/g1/meetings/${id}/ask`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '' }),
    });
    assert.equal(bad.status, 400);
  } finally { close(); }
});
```

> If `guild_config` has no `summarizer_provider` column or the row shape differs, read `src/store/config.js` / the SCHEMA and match it; the point is "guild g1 uses provider `fake`."

- [ ] **Step 7: Run all** — `node --test`. Verify PASS.

- [ ] **Step 8: Commit** — `feat(web): ask-this-meeting Q&A endpoint + adapter ask() path`.

---

## Task 4: Frontend — api client + theme system

**Files:** modify `web/src/api.js`; create `web/src/ThemeContext.jsx`; rework `web/src/index.css` + `web/tailwind.config.js`. Add `.catch` to `web/src/GuildContext.jsx` (v1 follow-up).

- [ ] **Step 1: Extend `web/src/api.js`** — assignee-aware todos, assignees, ask:

```js
  todos: (g, { open, assignee } = {}) => {
    const p = new URLSearchParams();
    if (open) p.set('open', '1');
    if (assignee !== undefined) p.set('assignee', assignee === null ? '__unassigned__' : assignee);
    const qs = p.toString();
    return fetch(`/api/guilds/${g}/todos${qs ? `?${qs}` : ''}`).then(json);
  },
  assignees: (g) => fetch(`/api/guilds/${g}/assignees`).then(json),
  ask: (g, id, question) => fetch(`/api/guilds/${g}/meetings/${id}/ask`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }),
  }).then(json),
```
(Keep the existing `meeting`, `search`, `config`, `saveConfig`, `setTodoDone`, `meetings`, `guilds`.)

- [ ] **Step 2: `ThemeContext.jsx`** — `{theme, setTheme, toggle}`; writes `data-theme` on `<html>`; persists to `localStorage` key `parley-theme`; defaults `'dark'`. On mount, read stored value and set `document.documentElement.dataset.theme`.

- [ ] **Step 3: Theme tokens.** In `tailwind.config.js` set `darkMode: ['selector', '[data-theme="dark"]']`. Move the v1 fixed hex palette into CSS variables in `index.css` with a dark set (`[data-theme="dark"]`, the existing landing-page values) and a light set (`[data-theme="light"]` — readable light surfaces, ink/bg inverted, same `primary`/`accent`). Tailwind colors reference the vars (e.g. `bg: 'var(--bg)'`). **Visual values for the light set are chosen with the impeccable skill** — do not hand-pick muddy greys.

- [ ] **Step 4: `GuildContext` `.catch`** — surface a failed `api.guilds()` as an empty list + error flag instead of an unhandled rejection.

- [ ] **Step 5: Build** — `npm --prefix web run build` succeeds. Commit — `feat(web): theme system + ask/assignee api client`.

---

## Task 5: Layout rebuild + MeetingsRail (impeccable)

**Files:** rewrite `web/src/components/Layout.jsx`; create `web/src/components/MeetingsRail.jsx`.

**Behavior (logic — visuals by impeccable):**
- `Layout`: slim header = wordmark · guild picker (from `useGuild`) · theme toggle (☾/☀ via `ThemeContext`) · "Action items" link (`/action-items`) · gear (`/setup`). No 4-tab bar. Below: two-pane shell — `<MeetingsRail/>` + `<main><Outlet/></main>`.
- `MeetingsRail`: fetches `api.meetings(guildId)`; renders the list (active meeting highlighted via route match); a search input at top that navigates to `/search?q=` on submit. Empty guild → quiet "No meetings yet".

**Visual direction (Granola):** hairline dividers not panel boxes, no uppercase micro-labels, generous line-height, single refined type scale, minimal motion. Invoke **impeccable** for the actual craft.

- [ ] Build passes; header + rail + theme toggle render; picking a guild repopulates the rail; toggle persists across reload. Commit — `feat(web): granola-style layout + meetings rail`.

---

## Task 6: Reading page + Ask box (impeccable)

**Files:** create `web/src/pages/Reading.jsx` (successor to `MeetingDetail.jsx`'s note rendering + the old `Meetings.jsx` landing role).

**Behavior:**
- Route `/` → redirect to the latest meeting (`api.meetings(guildId)[0]`) for the selected guild; empty guild → calm empty state. `/meetings/:id` → that meeting.
- Fetch `api.meeting(id)`. Render the note as a document: **TL;DR as an opening paragraph (no label)**, then Topics / Decisions / Open questions, **Action items as checkboxes** (PATCH via `api.setTodoDone` — match each note action item to its todo row; if the bundle lacks todo ids, fetch `api.todos(guildId)` and match by `task`), talk-time bars, **collapsed Transcript** (`▸`).
- **Ask box** at the foot of the note: input + submit → `api.ask(guildId, id, question)`; show a loading state, render `{answer}` inline; on reject show the error message. Stateless one-shot (no history).

**Visual direction:** single column, document-feel, the note is the hero. Impeccable for craft. Note cross-fade on meeting switch (minimal motion).

- [ ] Build passes; landing opens latest note; sections render; action-item checkbox toggles persist; transcript expands; ask returns an answer. Commit — `feat(web): reading view with ask-this-meeting`.

---

## Task 7: ActionItems page (impeccable)

**Files:** create `web/src/pages/ActionItems.jsx` (replaces `Todos.jsx`).

**Behavior:**
- Default: **all open** items for the guild (`api.todos(guildId, { open: true })`).
- Prominent **`Assignee ▾`** dropdown from `api.assignees(guildId)` (render `null` as "Unassigned"; an "All" option clears the filter). Selecting one refetches with `{ open: true, assignee }`.
- Each item checkable (PATCH → refetch) and links to its source meeting (`/meetings/:meeting_id`). Flat list, **not** assignee-grouped.
- A "show completed" affordance (drops `open`).

- [ ] Build passes; default shows all open; assignee filter narrows incl. Unassigned; check removes from open; item links to its meeting. Commit — `feat(web): action-items page with assignee filter`.

---

## Task 8: Search + Setup restyle, routing, cleanup

**Files:** modify `web/src/App.jsx` (routes), restyle `web/src/pages/Search.jsx` + `Setup.jsx`; **delete** `web/src/pages/Todos.jsx` and `web/src/pages/Meetings.jsx` (and `MeetingDetail.jsx` if fully absorbed by `Reading.jsx`).

**Behavior:**
- `App.jsx` routes: `/` → Reading (redirect to latest), `/meetings/:id` → Reading, `/action-items` → ActionItems, `/search` → Search, `/setup` → Setup. Wrap in `GuildProvider` + `ThemeProvider`.
- `Search.jsx`: reads `?q=`, renders results in the main pane with a clear "back to note" control; restyled. Logic unchanged (`api.search`).
- `Setup.jsx`: **logic unchanged** (provider/model/channel/language/toggles, controlled-model + provider-default fix from v1) — restyle only.
- Remove dead imports/links to deleted pages.

- [ ] Build passes; all routes resolve; no import of deleted files; setup still saves and rejects bad input (server 400 surfaces). Commit — `refactor(web): restyle search+setup, route to reading view, drop v1 tabs`.

---

## Task 9: Final polish, build, manual pass

- [ ] **Impeccable polish pass** across the shell (Layout, Reading, ActionItems, Search, Setup) — typography scale, spacing rhythm, light/dark parity, focus states, empty/error/loading states. No templated look.
- [ ] `npm --prefix web run build` clean; `node --test` green (backend Tasks 1–3).
- [ ] `WEB_UI=1 npm start`, open `http://127.0.0.1:3000`: land on latest note, switch guilds, toggle theme (persists), check an action item, filter action-items by assignee, run a search, ask a meeting a question, edit setup. All against live data.
- [ ] Commit — `feat(web): granola-style redesign polish + manual verification`.

---

## Self-review

**Spec coverage:**
- Land on latest note, thin rail + search, single-column doc-feel → Tasks 5, 6. ✓
- Action-items page, default all-open, `Assignee ▾`, in-note checkboxes → Tasks 1, 2, 6, 7. ✓
- Dark-default + light toggle in localStorage → Task 4. ✓
- Ask-this-meeting Q&A reusing per-guild provider, no keys cross API → Task 3 (backend), Task 6 (UI). ✓
- Backend additive only; v1 routes/server/127.0.0.1/validateSetup untouched → Tasks 1–3 only extend. ✓
- Delete v1 4-tab nav + assignee-grouped Todos wall → Tasks 5, 7, 8. ✓
- impeccable for visual craft → Tasks 5–9. ✓

**Backward-compat:** `listTodos` keeps no-arg/`{open}` callers; existing `/todos` route still works without query params; new adapter `ask()` is additive (summarize untouched); ask endpoint is new. `test/todos.test.js` and `test/api.test.js` existing cases stay green.

**Cost note:** Task 3 (ask-AI) is the heaviest backend change — touches 5 adapter files + 1 helper + 1 endpoint. Everything else is small. Frontend is a reskin + 2 new pages + deletes, visual craft delegated to impeccable rather than pre-specified Tailwind (which impeccable would rewrite anyway).
