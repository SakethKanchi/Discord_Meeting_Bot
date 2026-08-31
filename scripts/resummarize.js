// Re-summarize a stored meeting from its saved utterances (no re-transcribe)
// and overwrite its summary row. Usage: node scripts/resummarize.js <meetingId>
import { join } from 'node:path';
import { config } from '../src/config/env.js';
import { openDb } from '../src/store/db.js';
import { getGuildConfig } from '../src/store/config.js';
import { buildTranscript, computeTalkTime } from '../src/pipeline/summarize.js';
import { getSummarizer } from '../src/adapters/summarizer/index.js';
import { resolveSummaryLanguage } from '../src/adapters/summarizer/languages.js';

const meetingId = Number(process.argv[2]);
if (!meetingId) throw new Error('usage: node scripts/resummarize.js <meetingId>');

const db = openDb(join(config.dataDir, 'meetings.db'));
const meeting = db.getMeeting(meetingId);
if (!meeting) throw new Error(`no meeting #${meetingId}`);

// db rows are snake_case; the pipeline helpers want camelCase.
const utterances = db.listUtterances(meetingId).map((u) => ({
  displayName: u.display_name,
  startMs: u.start_ms,
  endMs: u.end_ms,
  text: u.text,
}));

const cfg = getGuildConfig(db, meeting.guild_id);
const summarizer = getSummarizer(cfg);
const talktime = computeTalkTime(utterances);
const notes = await summarizer.summarize(buildTranscript(utterances), {
  channelName: meeting.channel_name,
  date: meeting.started_at,
  attendees: db.listAttendees(meetingId).map((a) => a.display_name),
  summaryLanguage: resolveSummaryLanguage(cfg),
});

db.saveSummary(meetingId, notes, talktime, `${cfg.summarizerProvider}:${cfg.summarizerModel || ''}`);
console.log(`✅ re-summarized #${meetingId}: ${notes.topics.length} topics, ${notes.actionItems.length} action items, tldr ${notes.tldr.length} chars`);
