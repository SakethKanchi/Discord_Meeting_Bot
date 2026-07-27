// test/api-audio.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The audio route resolves meeting dirs from config.dataDir, which is fixed at
// module load — pin DATA_DIR to a temp dir BEFORE importing the router.
const dataDir = mkdtempSync(join(tmpdir(), 'parley-api-audio-'));
process.env.DATA_DIR = dataDir;
const { apiRouter } = await import('../src/web/api.js');
const { openDb } = await import('../src/store/db.js');

after(() => rmSync(dataDir, { recursive: true, force: true }));

function pcm(samples) {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
}

async function listen(db) {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter({ db, client: null }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('GET /meetings/:id/audio streams a mixed WAV and detail reports hasAudio', async () => {
  const db = openDb(':memory:');
  const id = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'gen', startedAt: '2026-07-26T10:00:00Z' });
  db.setMeetingStatus(id, 'done', '2026-07-26T11:00:00Z');
  db.setAudioRetained(id, true);
  const dir = join(dataDir, 'audio', String(id));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'u1_1000.pcm'), pcm([5, 6]));

  const { base, close } = await listen(db);
  try {
    const detail = await (await fetch(`${base}/api/meetings/${id}`)).json();
    assert.equal(detail.hasAudio, true);

    const res = await fetch(`${base}/api/meetings/${id}/audio`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/wav');
    assert.match(res.headers.get('content-disposition'), /meeting-\d+-2026-07-26\.wav/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(buf.length, 44 + 4); // header + 2 samples
    assert.equal(buf.readInt16LE(44), 5);
    assert.equal(buf.readInt16LE(46), 6);
  } finally { close(); }
});

test('GET /meetings/:id/audio is 404 without stored audio, 409 mid-pipeline', async () => {
  // Fresh :memory: db reuses meeting id 1, but dataDir is shared across the
  // file's tests — drop the previous test's audio dirs so ids can't collide.
  rmSync(join(dataDir, 'audio'), { recursive: true, force: true });
  const db = openDb(':memory:');
  const done = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'gen', startedAt: 't' });
  db.setMeetingStatus(done, 'done');
  const rec = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'gen', startedAt: 't' });

  const { base, close } = await listen(db);
  try {
    assert.equal((await fetch(`${base}/api/meetings/${done}/audio`)).status, 404); // no dir on disk
    assert.equal((await fetch(`${base}/api/meetings/${rec}/audio`)).status, 409);  // still recording
    assert.equal((await fetch(`${base}/api/meetings/999/audio`)).status, 404);     // no such meeting
    const detail = await (await fetch(`${base}/api/meetings/${done}`)).json();
    assert.equal(detail.hasAudio, false);
  } finally { close(); }
});

test('GET /guilds/:g/config includes a voiceChannels key (empty without a client)', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(db);
  try {
    const cfg = await (await fetch(`${base}/api/guilds/g/config`)).json();
    assert.deepEqual(cfg.voiceChannels, []);
    assert.deepEqual(cfg.config.autoJoinChannelIds, []);
    assert.equal(cfg.config.keepAudio, false);
  } finally { close(); }
});
