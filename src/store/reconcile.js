// src/store/reconcile.js
// Boot-time housekeeping that must run whether or not the Discord bot starts
// (web-only mode still needs it). Two jobs:
//
//   1. Orphaned meetings — rows left in 'recording'/'processing' by a crash mid-
//      pipeline. Mark them 'transcription_failed' so the dashboard offers a retry
//      (the PCM is usually still on disk) instead of stranding them forever.
//   2. Orphaned audio dirs — data/audio/<id> directories whose meeting is gone
//      (deleted) or already 'done'/'empty' (audio no longer needed). These
//      accumulate unbounded otherwise. Meetings flagged audio_retained keep
//      their dir until the retention window expires.
//
// Pure-ish: fs access is injectable for tests.
import { readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

// Statuses whose meeting still needs its audio (a retry may retranscribe from PCM).
const KEEP_AUDIO_STATUSES = new Set(['recording', 'processing', 'transcription_failed', 'summary_failed']);

const DAY_MS = 24 * 60 * 60 * 1000;

// Is a retained meeting's audio past the retention window? retentionDays 0 =
// keep forever. An unparsable/missing timestamp keeps the audio (fail safe).
function retentionExpired(meeting, retentionDays, nowMs) {
  if (!retentionDays) return false;
  const stamp = Date.parse(meeting.ended_at || meeting.started_at || '');
  if (!Number.isFinite(stamp)) return false;
  return nowMs - stamp > retentionDays * DAY_MS;
}

// Sweep audio dirs that no meeting still needs. Runs at boot and on a daily
// timer (a long-lived container may never restart, so boot-only sweeping would
// let retained audio outlive its window indefinitely).
export async function sweepAudioDirs(db, audioRoot, {
  readdir = readdirSync, remove = rm, log = console, retentionDays = 30, now = Date.now,
} = {}) {
  const result = { sweptDirs: 0 };
  let dirs = [];
  try { dirs = readdir(audioRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return result; } // no audio root yet → nothing to sweep

  const nowMs = now();
  for (const name of dirs) {
    const id = Number(name);
    if (!Number.isInteger(id)) continue; // ignore non-numeric dirs we didn't create
    const meeting = db.getMeeting(id);
    // Keep dirs for meetings that might still be retried, and retained
    // recordings still inside the retention window. Remove everything else:
    // gone (deleted) meetings and terminal states that no longer need the PCM.
    let keep = false;
    if (meeting && KEEP_AUDIO_STATUSES.has(meeting.status)) keep = true;
    else if (meeting?.audio_retained) {
      if (retentionExpired(meeting, retentionDays, nowMs)) {
        db.setAudioRetained(id, false); // download UI stops offering it
      } else {
        keep = true;
      }
    }
    if (!keep) {
      await remove(join(audioRoot, name), { recursive: true, force: true }).catch(() => {});
      result.sweptDirs += 1;
    }
  }
  if (result.sweptDirs > 0) log.log?.(`[reconcile] swept ${result.sweptDirs} audio dir(s).`);
  return result;
}

export async function reconcileOnBoot(db, audioRoot, opts = {}) {
  const log = opts.log || console;
  const result = { orphanMeetings: 0, sweptDirs: 0 };

  // 1) Orphaned meetings from a crash mid-pipeline.
  for (const m of db.findOrphanedMeetings()) {
    db.setMeetingStatus(m.id, 'transcription_failed');
    result.orphanMeetings += 1;
    log.warn?.(`[reconcile] meeting ${m.id} was mid-pipeline at last shutdown → transcription_failed (retry from the dashboard).`);
  }

  // 2) Sweep audio dirs that no live/failed/retained meeting still needs.
  const swept = await sweepAudioDirs(db, audioRoot, opts);
  result.sweptDirs = swept.sweptDirs;
  return result;
}
