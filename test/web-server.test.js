// test/web-server.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { openDb } from '../src/store/db.js';
import { startWebServer } from '../src/web/server.js';

function occupy(port = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

// Log in as the seeded default admin and immediately move off the default
// password (the API is gated until that happens), returning the fresh session
// cookie so we can hit the now-protected API in these end-to-end checks.
async function loginCookie(base) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  assert.equal(r.status, 200);
  let cookie = r.headers.get('set-cookie').split(';')[0];
  const changed = await fetch(`${base}/api/auth/password`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ newPassword: 'admin-secret-1' }),
  });
  assert.equal(changed.status, 200);
  // Password change rotates the session; use the reissued cookie.
  const rotated = changed.headers.get('set-cookie');
  if (rotated) cookie = rotated.split(';')[0];
  return cookie;
}

test('startWebServer binds 127.0.0.1 and serves api + backfills (authed)', async () => {
  const db = openDb(':memory:');
  const mId = db.createMeeting({ guildId: 'g1', channelId: 'c', channelName: 'g', startedAt: 'now' });
  db.saveSummary(mId, { actionItems: [{ assignee: 'A', task: 'backfilled' }] }, [], 'test:m');
  const server = await startWebServer({ db, client: null, port: 0 });
  const { address, port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal(address, '127.0.0.1');
    // Unauthenticated requests are rejected.
    const noauth = await fetch(`${base}/api/guilds/g1/todos`);
    assert.equal(noauth.status, 401);
    // The default-password admin is blocked from the data API until it changes.
    const preChange = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const defCookie = preChange.headers.get('set-cookie').split(';')[0];
    const gated = await fetch(`${base}/api/guilds/g1/todos`, { headers: { cookie: defCookie } });
    assert.equal(gated.status, 403);
    // After login + password change the backfilled todo is visible.
    const cookie = await loginCookie(base);
    const todos = await (await fetch(`${base}/api/guilds/g1/todos`, { headers: { cookie } })).json();
    assert.equal(todos.length, 1); // backfill ran on start
    assert.equal(todos[0].task, 'backfilled');
  } finally { server.close(); }
});

test('startWebServer falls back to the next port when preferred is in use', async () => {
  const db = openDb(':memory:');
  const blocker = await occupy();
  const taken = blocker.address().port;
  try {
    const server = await startWebServer({ db, client: null, port: taken });
    try {
      const bound = server.address().port;
      assert.notEqual(bound, taken);
      assert.ok(bound > 0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

test('startWebServer rejects when every fallback port is taken', async () => {
  const db = openDb(':memory:');
  const first = await occupy();
  const taken = first.address().port;
  const second = await occupy(taken + 1);
  try {
    await assert.rejects(
      () => startWebServer({ db, client: null, port: taken, maxAttempts: 2 }),
      (err) => err && err.code === 'EADDRINUSE',
    );
  } finally {
    await Promise.all([
      new Promise((r) => first.close(r)),
      new Promise((r) => second.close(r)),
    ]);
  }
});
