// test/reconcile.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.js';
import { reconcileOnBoot, sweepAudioDirs } from '../src/store/reconcile.js';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'parley-reconcile-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const quiet = { warn: () => {}, log: () => {} };

test('reconcileOnBoot marks mid-pipeline meetings transcription_failed', async () => {
  const { dir, cleanup } = tmp();
  try {
    const db = openDb(':memory:');
    const rec = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'x', startedAt: 't' });
    const proc = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'x', startedAt: 't' });
    db.setMeetingStatus(proc, 'processing');
    const done = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'x', startedAt: 't' });
    db.setMeetingStatus(done, 'done');

    const r = await reconcileOnBoot(db, join(dir, 'audio'), { log: quiet });
    assert.equal(r.orphanMeetings, 2);
    assert.equal(db.getMeeting(rec).status, 'transcription_failed');
    assert.equal(db.getMeeting(proc).status, 'transcription_failed');
    assert.equal(db.getMeeting(done).status, 'done'); // untouched
  } finally { cleanup(); }
});

test('reconcileOnBoot sweeps audio dirs for gone/terminal meetings, keeps retryable', async () => {
  const { dir, cleanup } = tmp();
  try {
    const db = openDb(':memory:');
    const audioRoot = join(dir, 'audio');
    // done → sweep; deleted (no row) → sweep; transcription_failed → keep.
    const doneId = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'x', startedAt: 't' });
    db.setMeetingStatus(doneId, 'done');
    const failId = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'x', startedAt: 't' });
    db.setMeetingStatus(failId, 'transcription_failed');
    const goneId = 9999; // no such meeting

    for (const id of [doneId, failId, goneId]) {
      const d = join(audioRoot, String(id));
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'u1_0.pcm'), 'x');
    }
    // A non-numeric dir we didn't create must be left alone.
    mkdirSync(join(audioRoot, 'notes'), { recursive: true });

    const r = await reconcileOnBoot(db, audioRoot, { log: quiet });
    assert.equal(r.sweptDirs, 2);
    assert.equal(existsSync(join(audioRoot, String(doneId))), false);
    assert.equal(existsSync(join(audioRoot, String(goneId))), false);
    assert.equal(existsSync(join(audioRoot, String(failId))), true); // kept for retry
    assert.equal(existsSync(join(audioRoot, 'notes')), true);        // untouched
  } finally { cleanup(); }
});

test('reconcileOnBoot is a no-op when the audio root does not exist', async () => {
  const db = openDb(':memory:');
  const r = await reconcileOnBoot(db, '/nonexistent/parley/audio', { log: quiet });
  assert.equal(r.sweptDirs, 0);
  assert.equal(r.orphanMeetings, 0);
});

const DAY = 24 * 60 * 60 * 1000;

function meetingWithAudio(db, audioRoot, { status = 'done', endedAt, retained = false } = {}) {
  const id = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'x', startedAt: 't' });
  db.setMeetingStatus(id, status, endedAt);
  if (retained) db.setAudioRetained(id, true);
  const d = join(audioRoot, String(id));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'u1_0.pcm'), 'x');
  return id;
}

test('sweep keeps retained audio inside the retention window, purges expired', async () => {
  const { dir, cleanup } = tmp();
  try {
    const db = openDb(':memory:');
    const audioRoot = join(dir, 'audio');
    const now = Date.parse('2026-07-27T00:00:00Z');
    const fresh = meetingWithAudio(db, audioRoot, { endedAt: new Date(now - 1 * DAY).toISOString(), retained: true });
    const stale = meetingWithAudio(db, audioRoot, { endedAt: new Date(now - 40 * DAY).toISOString(), retained: true });
    const plainDone = meetingWithAudio(db, audioRoot, { endedAt: new Date(now - 1 * DAY).toISOString() });

    const r = await sweepAudioDirs(db, audioRoot, { log: quiet, retentionDays: 30, now: () => now });
    assert.equal(r.sweptDirs, 2);
    assert.equal(existsSync(join(audioRoot, String(fresh))), true);   // retained, in window
    assert.equal(existsSync(join(audioRoot, String(stale))), false);  // retained, expired
    assert.equal(existsSync(join(audioRoot, String(plainDone))), false); // done, not retained
    assert.equal(db.getMeeting(stale).audio_retained, 0); // flag cleared so UI stops offering it
    assert.equal(db.getMeeting(fresh).audio_retained, 1);
  } finally { cleanup(); }
});

test('retentionDays 0 keeps retained audio indefinitely', async () => {
  const { dir, cleanup } = tmp();
  try {
    const db = openDb(':memory:');
    const audioRoot = join(dir, 'audio');
    const now = Date.parse('2026-07-27T00:00:00Z');
    const ancient = meetingWithAudio(db, audioRoot, { endedAt: new Date(now - 900 * DAY).toISOString(), retained: true });

    const r = await sweepAudioDirs(db, audioRoot, { log: quiet, retentionDays: 0, now: () => now });
    assert.equal(r.sweptDirs, 0);
    assert.equal(existsSync(join(audioRoot, String(ancient))), true);
  } finally { cleanup(); }
});

test('retained audio with an unparsable timestamp is kept (fail safe)', async () => {
  const { dir, cleanup } = tmp();
  try {
    const db = openDb(':memory:');
    const audioRoot = join(dir, 'audio');
    // started_at 't', no ended_at → unparsable; must not be swept by mistake.
    const id = meetingWithAudio(db, audioRoot, { retained: true });
    const r = await sweepAudioDirs(db, audioRoot, { log: quiet, retentionDays: 30 });
    assert.equal(r.sweptDirs, 0);
    assert.equal(existsSync(join(audioRoot, String(id))), true);
  } finally { cleanup(); }
});
