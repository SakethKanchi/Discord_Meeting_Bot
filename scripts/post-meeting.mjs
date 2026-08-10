// Deliver an already-summarized meeting's notes to Discord.
// Pairs with reprocess-meeting.mjs, which saves the summary but cannot post
// (that needs a logged-in client). Use after a reprocess to get the notes into
// the configured notes channel, exactly as the live pipeline would.
//
//   node scripts/post-meeting.mjs <meetingId>
import { join } from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../src/config/env.js';
import { openDb } from '../src/store/db.js';
import { getGuildConfig } from '../src/store/config.js';
import { postNotes } from '../src/delivery/post.js';

const meetingId = Number(process.argv[2]);
if (!Number.isInteger(meetingId)) {
  console.error('Usage: node scripts/post-meeting.mjs <meetingId>');
  process.exit(1);
}

const db = openDb(join(config.dataDir, 'meetings.db'));
const meeting = db.getMeeting(meetingId);
if (!meeting) {
  console.error(`Meeting ${meetingId} not found.`);
  process.exit(1);
}
const summary = db.getSummary(meetingId);
if (!summary) {
  console.error(`Meeting ${meetingId} has no saved summary — run reprocess-meeting.mjs first.`);
  process.exit(1);
}
if (!config.discordToken) {
  console.error('DISCORD_TOKEN is not set in .env — cannot post.');
  process.exit(1);
}

const cfg = getGuildConfig(db, meeting.guild_id);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
// discord.js v14 emits 'ready', v15 renames it to 'clientReady'; listen for both.
const ready = new Promise((resolve) => {
  client.once('clientReady', resolve);
  client.once('ready', resolve);
});
await client.login(config.discordToken);
await ready;

try {
  await postNotes({ client, meeting, cfg, notes: summary.notes, talktime: summary.talktime });
  console.log(`Posted meeting ${meetingId} notes to ${cfg.notesChannelId || meeting.channel_id}.`);
} catch (err) {
  console.error(`Delivery failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.destroy();
}
