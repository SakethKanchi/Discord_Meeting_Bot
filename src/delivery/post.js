import { ChannelType } from 'discord.js';
import { renderNotes, chunk } from './discord-notes.js';
import { config as env } from '../config/env.js';

export async function postNotes({ client, meeting, cfg, notes, talktime }) {
  const channelId = cfg.notesChannelId || meeting.channel_id;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  // Throw rather than silently dropping the notes: the pipeline records this as
  // a delivery failure (the meeting is still 'done' with notes in the dashboard)
  // instead of pretending the post succeeded with no trace.
  if (!channel) throw new Error(`Notes channel ${channelId} is unreachable (deleted or missing access).`);

  let md = renderNotes(notes, talktime, { channelName: meeting.channel_name, date: meeting.started_at });
  // Guilds that keep recordings get a link to the meeting's dashboard page
  // (login required), where the mixed WAV can be downloaded. Needs the
  // operator to have set WEB_PUBLIC_URL — no URL, no link.
  if (cfg.keepAudio && env.webPublicUrl) {
    md += `\n\n🎧 Recording & full transcript: ${env.webPublicUrl}/meetings/${meeting.id}`;
  }
  const parts = chunk(md);

  let target = channel;
  if (cfg.useThread && channel.type === ChannelType.GuildText) {
    // Fall back to the channel itself if thread creation fails (e.g. missing perms)
    // so the notes are never silently lost.
    target = await channel.threads
      .create({ name: `Notes — ${meeting.channel_name} ${meeting.started_at.slice(0, 10)}` })
      .catch(() => channel);
  }
  for (const part of parts) await target.send(part);
}
