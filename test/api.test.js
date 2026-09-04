// test/api.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ChannelType } from 'discord.js';
import { openDb } from '../src/store/db.js';
import { apiRouter } from '../src/web/api.js';

function appWith(db) {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter({ db, client: null }));
  return app;
}

// A minimal in-memory sidecar controller stub mirroring SidecarController's
// surface, so we can exercise the /system/sidecar routes + auto start/stop.
function fakeSidecar({ managed = true } = {}) {
  const s = {
    _managed: managed, state: 'stopped', calls: [],
    managed() { return this._managed; },
    status() { return { state: this.state, error: null, running: this.state === 'running', managed: this._managed, external: false, url: 'http://127.0.0.1:8000', log: [] }; },
    async start() { this.calls.push('start'); this.state = 'running'; return { ok: true, state: 'running' }; },
    async stop() { this.calls.push('stop'); this.state = 'stopped'; return { ok: true, state: 'stopped' }; },
    async restart() { this.calls.push('restart'); this.state = 'running'; return { ok: true, state: 'running' }; },
  };
  return s;
}

function appWithSidecar(db, sidecar) {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter({ db, client: null, sidecar }));
  return app;
}

// Mounts apiRouter with a fixed req.user, standing in for attachUser +
// requireAuth in the real server, to exercise requireAdmin gating (D3).
function appWithUser(db, user) {
  const app = express();
  app.use(express.json());
  // Mirror attachUser: set req.authResolved so requireAdmin fails closed for
  // non-admins (the real server always runs attachUser in front of the router).
  app.use('/api', (req, _res, next) => { req.authResolved = true; req.user = user; next(); });
  app.use('/api', apiRouter({ db, client: null }));
  return app;
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('GET /api/guilds and meetings and todos', async () => {
  const db = openDb(':memory:');
  const id = db.createMeeting({ guildId: 'g1', channelId: 'c', channelName: 'gen', startedAt: 'now' });
  db.seedTodos(id, 'g1', [{ assignee: 'Al', task: 'x' }]);
  const { base, close } = await listen(appWith(db));
  try {
    const guilds = await (await fetch(`${base}/api/guilds`)).json();
    assert.deepEqual(guilds, [{ id: 'g1', name: 'g1' }]);
    const meetings = await (await fetch(`${base}/api/guilds/g1/meetings`)).json();
    assert.equal(meetings.length, 1);
    const todos = await (await fetch(`${base}/api/guilds/g1/todos`)).json();
    assert.equal(todos.length, 1);
    const patch = await fetch(`${base}/api/todos/${todos[0].id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ done: true }),
    });
    assert.equal(patch.status, 200);
    assert.equal((await (await fetch(`${base}/api/guilds/g1/todos?open=1`)).json()).length, 0);
  } finally { close(); }
});

test('GET config returns providers + PATCH validates', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db));
  try {
    const cfg = await (await fetch(`${base}/api/guilds/g1/config`)).json();
    assert.ok(Array.isArray(cfg.providers));
    assert.ok(cfg.providers.some((p) => p.provider === 'openrouter'));
    assert.equal('openrouter' in (cfg.secrets || {}), true);
    assert.equal(cfg.defaultModels?.openrouter, 'openai/gpt-4o-mini');
    assert.equal(cfg.config.summarizerProvider, 'gemini'); // default

    // invalid provider rejected with 400
    const bad = await fetch(`${base}/api/guilds/g1/config`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'not-a-provider' }),
    });
    assert.equal(bad.status, 400);

    // valid no-key-required change (whisper model) accepted
    const ok = await fetch(`${base}/api/guilds/g1/config`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ whisperModel: 'base' }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).config.whisperModel, 'base');
  } finally { close(); }
});

test('GET provider models returns a catalog and rejects unknown providers', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db));
  try {
    // ollama is local-only: live when a server is running, curated shortlist
    // when it isn't. Either way the picker gets a usable list.
    const cat = await (await fetch(`${base}/api/providers/ollama/models`)).json();
    assert.equal(cat.provider, 'ollama');
    assert.ok(['live', 'curated'].includes(cat.source));
    assert.ok(cat.models.length > 0);
    assert.ok(cat.models.every((m) => typeof m.id === 'string' && typeof m.label === 'string'));
    assert.equal(cat.default, 'llama3');

    const bad = await fetch(`${base}/api/providers/nope/models`);
    assert.equal(bad.status, 400);
  } finally { close(); }
});

test('GET config includes sttProviders with the sidecar default', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db));
  try {
    const cfg = await (await fetch(`${base}/api/guilds/g1/config`)).json();
    assert.ok(Array.isArray(cfg.sttProviders));
    assert.deepEqual(cfg.sttProviders.map((p) => p.provider), ['sidecar', 'openai']);
    assert.equal(cfg.config.sttProvider, 'sidecar'); // default
  } finally { close(); }
});

test('POST /system/sidecar start/stop drives the controller', async () => {
  const db = openDb(':memory:');
  const sidecar = fakeSidecar();
  const { base, close } = await listen(appWithSidecar(db, sidecar));
  try {
    const started = await fetch(`${base}/api/system/sidecar/start`, { method: 'POST' });
    assert.equal(started.status, 200);
    assert.equal((await started.json()).sidecar.state, 'running');
    const stopped = await fetch(`${base}/api/system/sidecar/stop`, { method: 'POST' });
    assert.equal((await stopped.json()).sidecar.state, 'stopped');
    assert.deepEqual(sidecar.calls, ['start', 'stop']);
    // status surfaces in /system/status too
    const sys = await (await fetch(`${base}/api/system/status`)).json();
    assert.equal(sys.sidecar.state, 'stopped');
  } finally { close(); }
});

test('switching a guild to a cloud STT provider auto-stops the sidecar', async () => {
  const db = openDb(':memory:');
  // Make openai usable so validation passes (presence-only check).
  process.env.OPENAI_API_KEY = 'sk_test';
  const { config: env } = await import('../src/config/env.js');
  const prevOpenai = env.openai.apiKey;
  env.openai.apiKey = 'sk_test';
  const sidecar = fakeSidecar();
  await sidecar.start(); // pretend it was running
  sidecar.calls.length = 0;
  const { base, close } = await listen(appWithSidecar(db, sidecar));
  try {
    const r = await fetch(`${base}/api/guilds/g1/config`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sttProvider: 'openai' }),
    });
    const body = await r.json();
    assert.equal(body.config.sttProvider, 'openai');
    assert.equal(body.sidecar.state, 'stopped');
    assert.ok(sidecar.calls.includes('stop'));

    // switching back to sidecar starts it again
    const back = await fetch(`${base}/api/guilds/g1/config`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sttProvider: 'sidecar' }),
    });
    assert.equal((await back.json()).sidecar.state, 'running');
    assert.ok(sidecar.calls.includes('start'));
  } finally { close(); delete process.env.OPENAI_API_KEY; env.openai.apiKey = prevOpenai; }
});

test('GET /api/guilds merges live client cache with db guilds (no duplicates)', async () => {
  const db = openDb(':memory:');
  // g1 is in db (from a meeting), g2 is only in the bot's guild cache
  db.createMeeting({ guildId: 'g1', channelId: 'c', channelName: 'gen', startedAt: 'now' });

  const stubCache = new Map([
    ['g1', { id: 'g1', name: 'Guild One' }],
    ['g2', { id: 'g2', name: 'Fresh Guild' }],
  ]);
  const stubClient = { guilds: { cache: stubCache } };

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter({ db, client: stubClient }));
  const { base, close } = await listen(app);
  try {
    const guilds = await (await fetch(`${base}/api/guilds`)).json();
    // Both guilds present, no duplicate for g1
    assert.equal(guilds.length, 2);
    const ids = guilds.map((g) => g.id).sort();
    assert.deepEqual(ids, ['g1', 'g2']);
    // Name is resolved via the cache when available
    const g2 = guilds.find((g) => g.id === 'g2');
    assert.equal(g2.name, 'Fresh Guild');
  } finally { close(); }
});

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

test('GET /api/meetings/:id returns bundle', async () => {
  const db = openDb(':memory:');
  const id = db.createMeeting({ guildId: 'g1', channelId: 'c', channelName: 'gen', startedAt: 'now' });
  db.addUtterance({ meetingId: id, userId: 'u', displayName: 'Al', startMs: 0, endMs: 5, text: 'hello' });
  db.saveSummary(id, { tldr: 'hi', actionItems: [] }, [], 'test:m');
  const { base, close } = await listen(appWith(db));
  try {
    const bundle = await (await fetch(`${base}/api/meetings/${id}`)).json();
    assert.equal(bundle.meeting.id, id);
    assert.equal(bundle.summary.notes.tldr, 'hi');
    assert.equal(bundle.utterances.length, 1);
  } finally { close(); }
});

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

test('GET /api/system/status reports bot + connection (managed)', async () => {
  const db = openDb(':memory:');
  // Fake controller standing in for BotController.
  const fakeBot = {
    client: { user: { tag: 'Parley#1', id: 'b1' }, guilds: { cache: new Map([['g', {}]]) } },
    status() {
      return { state: 'ready', connected: true, hasCreds: true,
        user: { tag: 'Parley#1', id: 'b1' }, guildCount: 1, error: null };
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter({ db, bot: fakeBot }));
  const { base, close } = await listen(app);
  try {
    const s = await (await fetch(`${base}/api/system/status`)).json();
    assert.equal(s.managed, true);
    assert.equal(s.bot.connected, true);
    assert.equal(s.bot.user.tag, 'Parley#1');
    // The token presence is reported, never the value.
    assert.ok('connection' in s);
    assert.equal('value' in (s.connection.discordToken || {}), false);
  } finally { close(); }
});

test('PUT /api/system/connection requires a recognized field', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db));
  try {
    const bad = await fetch(`${base}/api/system/connection`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: 'x' }),
    });
    assert.equal(bad.status, 400);
  } finally { close(); }
});

test('POST /api/system/bot/:action is rejected when unmanaged', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db));
  try {
    const r = await fetch(`${base}/api/system/bot/start`, { method: 'POST' });
    assert.equal(r.status, 400);
  } finally { close(); }
});

// D3: requireAdmin gates system/provider-key/destructive-meeting routes.
// PATCH /guilds/:g/config is deliberately NOT gated (stays open to all users).
test('D3: non-admin user gets 403 on admin-gated routes', async () => {
  const db = openDb(':memory:');
  const id = db.createMeeting({ guildId: 'g1', channelId: 'c', channelName: 'gen', startedAt: 'now' });
  const { base, close } = await listen(appWithUser(db, { id: 1, username: 'bob', isAdmin: false }));
  try {
    const putKey = await fetch(`${base}/api/providers/openai/key`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'x' }),
    });
    assert.equal(putKey.status, 403);

    const putConn = await fetch(`${base}/api/system/connection`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sttUrl: 'http://x' }),
    });
    assert.equal(putConn.status, 403);

    const botAction = await fetch(`${base}/api/system/bot/start`, { method: 'POST' });
    assert.equal(botAction.status, 403);

    const sidecarAction = await fetch(`${base}/api/system/sidecar/start`, { method: 'POST' });
    assert.equal(sidecarAction.status, 403);

    const del = await fetch(`${base}/api/meetings/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 403);

    const merge = await fetch(`${base}/api/meetings/${id}/merge`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceIds: [999] }),
    });
    assert.equal(merge.status, 403);

    // Config PATCH is intentionally left open to non-admins.
    const cfg = await fetch(`${base}/api/guilds/g1/config`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(cfg.status, 200);
  } finally { close(); }
});

test('D3: admin user passes the admin-gated routes (rejected downstream, not by requireAdmin)', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWithUser(db, { id: 1, username: 'root', isAdmin: true }));
  try {
    // Unmanaged bot/sidecar/provider paths still 400 for an admin — proves
    // requireAdmin let the request through to the actual handler.
    const putKey = await fetch(`${base}/api/providers/nope/key`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'x' }),
    });
    assert.equal(putKey.status, 400); // unknown provider, past the 403 gate

    const botAction = await fetch(`${base}/api/system/bot/start`, { method: 'POST' });
    assert.equal(botAction.status, 400); // no bot controller attached, past the 403 gate
  } finally { close(); }
});

test('D3: no-auth standalone server (no req.user attached) still passes admin routes', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db)); // no req.user middleware at all
  try {
    const putKey = await fetch(`${base}/api/providers/nope/key`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'x' }),
    });
    assert.equal(putKey.status, 400); // reaches the handler, not blocked by requireAdmin

    const botAction = await fetch(`${base}/api/system/bot/start`, { method: 'POST' });
    assert.equal(botAction.status, 400);
  } finally { close(); }
});


// ── Meeting export (#17) ──────────────────────────────────────────────────────

test('GET /api/meetings/:id/export returns full JSON with all utterances', async () => {
  const db = openDb(':memory:');
  const id = db.createMeeting({ guildId: 'g1', channelId: 'c', channelName: 'planning', startedAt: '2026-01-02T10:00:00Z' });
  db.addAttendee(id, 'u1', 'Alice');
  for (let i = 0; i < 40; i++) db.addUtterance({ meetingId: id, userId: 'u1', displayName: 'Alice', startMs: i * 1000, endMs: i * 1000 + 500, text: `line ${i}` });
  db.saveSummary(id, { tldr: 'did stuff', actionItems: [] }, [], 'fake:m');
  const { base, close } = await listen(appWith(db));
  try {
    const r = await fetch(`${base}/api/meetings/${id}/export`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition') || '', /meeting-\d+-2026-01-02\.json/);
    const body = await r.json();
    assert.equal(body.utterances.length, 40); // not truncated like /raw
    assert.equal(body.attendees[0], 'Alice');
    assert.equal(body.summary.notes.tldr, 'did stuff');
  } finally { close(); }
});

test('GET /api/meetings/:id/export?format=md returns a markdown download', async () => {
  const db = openDb(':memory:');
  const id = db.createMeeting({ guildId: 'g1', channelId: 'c', channelName: 'planning', startedAt: '2026-01-02T10:00:00Z' });
  db.addUtterance({ meetingId: id, userId: 'u1', displayName: 'Alice', startMs: 65000, endMs: 66000, text: 'hello world' });
  db.saveSummary(id, { tldr: 'summary here', actionItems: [] }, [], 'fake:m');
  const { base, close } = await listen(appWith(db));
  try {
    const r = await fetch(`${base}/api/meetings/${id}/export?format=md`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/markdown/);
    const md = await r.text();
    assert.match(md, /# planning/);
    assert.match(md, /\[01:05\] Alice:\*\* hello world/); // timestamped transcript line
  } finally { close(); }
});

test('GET /api/meetings/:id/export 404s for a missing meeting', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db));
  try {
    assert.equal((await fetch(`${base}/api/meetings/9999/export`)).status, 404);
  } finally { close(); }
});
