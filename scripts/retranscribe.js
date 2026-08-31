// Recover a meeting whose audio was captured but never transcribed/summarized
// (e.g. the orchestrator died on a locked DB). Rebuilds tracks from the saved
// PCM files on disk and runs the SAME production pipeline (processMeeting):
// transcribe -> utterances -> summary -> todos -> status=done.
//
// Usage: node --env-file=.env scripts/retranscribe.js <meetingId>
// Requires: the STT sidecar running; ideally NO bot instance writing the DB.
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { config } from '../src/config/env.js';
import { openDb } from '../src/store/db.js';
import { getGuildConfig } from '../src/store/config.js';
import { processMeeting } from '../src/pipeline/orchestrator.js';

const meetingId = Number(process.argv[2]);
if (!meetingId) throw new Error('usage: node --env-file=.env scripts/retranscribe.js <meetingId>');

const db = openDb(join(config.dataDir, 'meetings.db'));
const meeting = db.getMeeting(meetingId);
if (!meeting) throw new Error(`no meeting #${meetingId}`);

// Refuse if utterances already exist — addUtterance is a plain INSERT, so a
// re-run would duplicate. Recovery is for the utt=0 case.
const existing = db.listUtterances(meetingId).length;
if (existing > 0) {
  throw new Error(`#${meetingId} already has ${existing} utterances — use scripts/resummarize.js instead (this would duplicate them)`);
}

// userId -> display name, from the attendees captured during recording.
const names = new Map(db.listAttendees(meetingId).map((a) => [a.user_id, a.display_name]));

// Rebuild tracks from audio/<id>/<userId>_<startMs>.pcm (one file per speaking
// segment). parse: userId is everything before the LAST '_', startMs after it.
const audioDir = join(config.dataDir, 'audio', String(meetingId));
const tracks = readdirSync(audioDir)
  .filter((f) => f.endsWith('.pcm'))
  .map((f) => {
    const base = f.slice(0, -4); // drop .pcm
    const i = base.lastIndexOf('_');
    const userId = base.slice(0, i);
    return {
      userId,
      displayName: names.get(userId) || userId,
      startMs: Number(base.slice(i + 1)),
      pcmPath: join(audioDir, f),
    };
  })
  .sort((a, b) => a.startMs - b.startMs);

if (tracks.length === 0) throw new Error(`no .pcm files in ${audioDir}`);

const cfg = getGuildConfig(db, meeting.guild_id);
console.log(`Recovering #${meetingId} "${meeting.channel_name}": ${tracks.length} audio segments, ` +
  `${names.size} speakers, provider=${cfg.summarizerProvider} whisper=${cfg.whisperModel}. This may take a while…`);

const { notes, talktime } = await processMeeting(db, meetingId, { cfg, tracks });

// Print the recovered notes so they're visible immediately (also saved in DB + todos).
console.log('\n================ RECOVERED NOTES ================');
console.log('TL;DR:', notes.tldr);
for (const t of notes.topics || []) {
  console.log(`\n# ${t.title}`);
  for (const p of t.points || []) console.log(`  - ${p}`);
}
if (notes.decisions?.length) { console.log('\nDecisions:'); notes.decisions.forEach((d) => console.log(`  - ${d}`)); }
if (notes.openQuestions?.length) { console.log('\nOpen questions:'); notes.openQuestions.forEach((q) => console.log(`  - ${q}`)); }
if (notes.actionItems?.length) {
  console.log('\nAction items:');
  notes.actionItems.forEach((a) => console.log(`  - ${a.assignee ? a.assignee + ': ' : ''}${a.task}`));
}
console.log('\nTalk time:', talktime.map((t) => `${t.displayName} ${t.pct}%`).join(', '));
console.log('=================================================');
console.log(`\n✅ #${meetingId} status=done, ${notes.actionItems?.length || 0} action items seeded to todos.`);
