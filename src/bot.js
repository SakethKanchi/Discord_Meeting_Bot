// src/bot.js
// All Discord bot wiring. Exported as startBot() so it can be launched lazily —
// the web UI boots first (even with no credentials) and starts the bot once the
// user connects their Discord app. Returns the live client + meeting manager.
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { joinVoiceChannel, getVoiceConnection, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import { rm } from 'node:fs/promises';
import { config, validateEnv } from './config/env.js';
import { getGuildConfig, setGuildConfig } from './store/config.js';
import { deployCommands, clearGlobalCommands } from './commands/deploy.js';
import { MeetingManager } from './voice/meeting-manager.js';
import { TrackRegistry, attachCapture } from './voice/capture.js';
import { processMeeting } from './pipeline/orchestrator.js';
import { getSummarizer } from './adapters/summarizer/index.js';
import { shouldAutoJoin, shouldAutoLeave } from './voice/decisions.js';
import { validateSetup } from './commands/setup-logic.js';
import { renderNotes, chunk } from './delivery/discord-notes.js';
import { postNotes } from './delivery/post.js';

export function startBot({ db, audioRoot }) {
  validateEnv(); // throws with a clear message if token/client id are missing

  // Verbose voice-lifecycle logging (gateway raw packets, [vSU]/[voice]/[join]
  // traces) is noisy in production; gate it behind DEBUG_VOICE=1. Errors,
  // warnings, and the meaningful lifecycle lines (Started/Stopping, Logged in)
  // stay on unconditionally.
  const DEBUG_VOICE = process.env.DEBUG_VOICE === '1';
  const debugLog = (...args) => { if (DEBUG_VOICE) console.log(...args); };

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  client.on('raw', (packet) => {
    if (!DEBUG_VOICE) return;
    if (packet.t === 'VOICE_STATE_UPDATE' || packet.t === 'VOICE_SERVER_UPDATE') {
      console.log(`[gateway] ${packet.t}:`, JSON.stringify(packet.d).substring(0, 200));
    }
  });

  const manager = new MeetingManager({
    db, audioRoot,
    startCapture: ({ meetingId, connection, guild, audioDir }) => {
      const registry = new TrackRegistry();
      const { stopAll } = attachCapture({
        connection, guild, audioDir, registry,
        // Record latecomers the moment they first speak (INSERT OR IGNORE keeps
        // it idempotent), so attendees isn't limited to the start snapshot.
        onSpeaker: (userId, displayName) => db.addAttendee(meetingId, userId, displayName),
      });
      return { registry, stopAll };
    },
    finalize: async (meetingId, tracks, session) => {
      const meeting = db.getMeeting(meetingId);
      const cfg = getGuildConfig(db, meeting.guild_id);
      try {
        const result = await processMeeting(db, meetingId, {
          tracks,
          cfg,
          summarizer: getSummarizer(cfg),
          deliver: async (notes, talktime) => postNotes({ client, meeting, cfg, notes, talktime }),
        });
        // Success: delete the meeting's audio. On failure we keep the PCM for manual retry.
        await rm(session.audioDir, { recursive: true, force: true }).catch(() => {});
        // Nobody spoke — drop the empty meeting record entirely.
        if (result?.empty) db.deleteMeeting(meetingId);
        // Summary succeeded but posting didn't (perms/deleted channel): the notes
        // are safe in the dashboard and the meeting stays 'done'. Best-effort ping
        // the origin channel so people aren't left waiting on a thread that never comes.
        else if (result?.deliveryError) {
          const ch = await client.channels.fetch(meeting.channel_id).catch(() => null);
          if (ch) await ch.send(`⚠️ Meeting ${meetingId} notes are ready in the dashboard, but I couldn't post them here: ${result.deliveryError}`).catch(() => {});
        }
      } catch (err) {
        console.error(`Meeting ${meetingId} failed:`, err.message);
        const reason = err.userMessage || err.message;
        const ch = await client.channels.fetch(cfg.notesChannelId || meeting.channel_id).catch(() => null);
        if (ch) await ch.send(`⚠️ Meeting ${meetingId} failed: ${reason}\nThe transcript is saved — an admin can retry with \`node scripts/reprocess-meeting.mjs ${meetingId}\`.`).catch(() => {});
      }
    },
  });
  const joiningInProgress = new Set(); // "guildId:channelId" strings
  const finalizingLostConnections = new Set(); // "guildId:channelId" strings — guards against stopping a lost session twice
  function humanCount(channel) {
    return channel.members.filter((m) => !m.user.bot).size;
  }
  function setRecIndicator(guild, on) {
    guild.members.me?.setNickname(on ? '[REC] Meeting Bot' : null).catch((e) => {
      console.warn('Nickname change failed:', e.message);
    });
  }
  function hasVoicePermissions(channel) {
    const perms = channel.guild.members.me?.permissionsIn(channel);
    return {
      connect: perms?.has('Connect') ?? false,
      speak: perms?.has('Speak') ?? false,
      useVoiceActivity: perms?.has('UseVAD') ?? false,
    };
  }
  // Shared "the meeting's voice connection is gone for real" path — used both
  // by the normal /leave + auto-leave flow (stopAndLeave) and by the
  // stateChange recovery below (A3). Idempotent: manager.stop() is a no-op if
  // the session already isn't active, and the re-entrancy guard prevents two
  // concurrent callers (e.g. Disconnected-timeout racing a Destroyed event)
  // from both trying to finalize the same key at once.
  async function finalizeLostConnection(guildId, channelId, reason) {
    const key = `${guildId}:${channelId}`;
    if (finalizingLostConnections.has(key)) return;
    if (!manager.isActive(guildId, channelId)) return; // nothing to finalize
    finalizingLostConnections.add(key);
    console.warn(`[voice] ${reason} for ${key} — finalizing the in-progress meeting.`);
    try {
      await stopAndLeave(guildId, channelId);
    } catch (err) {
      console.error(`[voice] failed to finalize lost connection ${key}:`, err.message);
    } finally {
      finalizingLostConnections.delete(key);
    }
  }
  async function joinAndStart(channel) {
    const joinKey = `${channel.guild.id}:${channel.id}`;
    if (joiningInProgress.has(joinKey)) {
      debugLog(`[join] Skipping duplicate join for ${joinKey}`);
      return;
    }
    joiningInProgress.add(joinKey);
    try {
      const permCheck = hasVoicePermissions(channel);
      if (!permCheck.connect) {
        throw new Error('Bot lacks **Connect** permission in this voice channel. Check server roles / channel overrides.');
      }
      if (!permCheck.speak) {
        throw new Error('Bot lacks **Speak** permission in this voice channel. Check server roles / channel overrides.');
      }
      debugLog(`[voice] joinVoiceChannel guild=${channel.guild.id} channel=${channel.id}`);
      const connection = joinVoiceChannel({
        channelId: channel.id, guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: false, selfMute: true,
      });
      debugLog(`[voice] connection initial state: ${connection.state.status}`);
      connection.on('stateChange', (oldState, newState) => {
        debugLog(`[voice] stateChange: ${oldState.status} -> ${newState.status}`);
      });
      connection.on('error', (err) => {
        console.error(`[voice] connection error:`, err.message);
      });
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 25_000);
        debugLog(`[voice] connection reached Ready`);
      } catch (err) {
        console.error(`[voice] entersState failed after 25s. Final state: ${connection.state.status}`);
        connection.destroy();
        throw new Error(
          `Voice connection failed: ${err.message}. Final state was ${connection.state.status}. ` +
          `Common causes: missing Connect/Speak permission, bot role below channel restrictions, ` +
          `or Discord voice region issues. Try moving the bot role higher in Server Settings → Roles.`
        );
      }
      if (manager.isActive(channel.guild.id, channel.id)) {
        connection.destroy();
        return;
      }
      // A3: only wire up disconnect recovery for the connection that's actually
      // about to back a meeting (past the Ready + dedup checks above) — a
      // duplicate/losing connection is destroyed and returned above without
      // ever reaching here, so it can't mistakenly finalize the real session.
      // Per @discordjs/voice guidance, Disconnected can mean "about to
      // reconnect" (region move, brief network blip) or "gone for good"
      // (kicked, voice server closed); racing a short window for the
      // connection to start reconnecting (Signalling/Connecting) tells them apart.
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          debugLog(`[voice] Disconnected looks recoverable for ${channel.guild.id}:${channel.id} (reconnecting)`);
        } catch {
          console.warn(`[voice] Disconnected did not recover within 5s for ${channel.guild.id}:${channel.id}`);
          if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
          await finalizeLostConnection(channel.guild.id, channel.id, 'Voice disconnected (no reconnect)');
        }
      });
      // Safety net: the connection was torn down (e.g. kicked, or destroyed
      // elsewhere) without recovering. If a meeting is still active in memory
      // for this guild/channel, finalize it instead of leaving a phantom
      // "live" session — finalizeLostConnection no-ops if it already isn't active.
      connection.on(VoiceConnectionStatus.Destroyed, async () => {
        await finalizeLostConnection(channel.guild.id, channel.id, 'Voice connection destroyed');
      });
      const attendees = channel.members.filter((m) => !m.user.bot).map((m) => ({ id: m.id, displayName: m.displayName }));
      const meetingId = manager.start({ guildId: channel.guild.id, channelId: channel.id, channelName: channel.name, connection, guild: channel.guild, attendees });
      console.log(`[meeting] Started #${meetingId} in ${channel.name} with ${attendees.length} attendee(s)`);
      setRecIndicator(channel.guild, true);
    } finally {
      // A5: always release the join lock, however we got here (early throws,
      // the Ready timeout, the isActive race, or a clean start) — otherwise a
      // channel that hits one of those paths can never be auto-joined again
      // until restart.
      joiningInProgress.delete(joinKey);
    }
  }
  async function stopAndLeave(guildId, channelId) {
    console.log(`[meeting] Stopping meeting in guild:${guildId} channel:${channelId}`);
    // stop() resolves as soon as capture is flushed; the transcribe/summarize
    // pipeline runs in the background (await result.done only if you must wait).
    await manager.stop(guildId, channelId);
    const conn = getVoiceConnection(guildId);
    if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
    const guild = client.guilds.cache.get(guildId);
    if (guild) setRecIndicator(guild, false);
  }

  client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    // Per-guild registration is instant; global is slow and cache-flaky (the
    // reason newly-added commands like /post showed up intermittently). Clear the
    // old global set so it can't shadow the guild commands, then register to every
    // guild the bot is in.
    await clearGlobalCommands().catch((e) => console.error('clear global commands failed:', e.message));
    for (const [guildId, guild] of client.guilds.cache) {
      // Persist the guild's human name so the web UI can label it even when read
      // without a live Discord client (e.g. the standalone API server).
      db.upsertGuild(guildId, guild.name);
      await deployCommands(config.discordClientId, config.discordToken, guildId)
        .then(() => console.log(`Registered commands in guild ${guildId}`))
        .catch((e) => console.error(`deploy to guild ${guildId} failed:`, e.message));
    }
    // Orphaned-meeting + audio-dir reconciliation now runs at process boot
    // (src/index.js → reconcileOnBoot) so it happens in web-only mode too, not
    // just when the bot logs in.
  });

  // Register commands when the bot joins a new guild, so they're available
  // immediately without waiting for a restart.
  client.on('guildCreate', (guild) => {
    db.upsertGuild(guild.id, guild.name);
    deployCommands(config.discordClientId, config.discordToken, guild.id)
      .then(() => console.log(`Registered commands in new guild ${guild.id}`))
      .catch((e) => console.error(`deploy to new guild ${guild.id} failed:`, e.message));
  });

  // Keep the stored guild name fresh when a server is renamed.
  client.on('guildUpdate', (_old, guild) => db.upsertGuild(guild.id, guild.name));

  client.on('voiceStateUpdate', async (oldState, newState) => {
    const guild = newState.guild;
    const channel = newState.channel || oldState.channel;
    if (!channel || channel.type !== ChannelType.GuildVoice) return;
    const cfg = getGuildConfig(db, guild.id);
    const connected = manager.isActive(guild.id, channel.id);
    const count = humanCount(channel);
    debugLog(`[vSU] guild=${guild.id} channel=${channel.id} user=${newState.id} old=${oldState.channelId} new=${newState.channelId} humans=${count} connected=${connected} autoJoin=${cfg.autoJoin}`);
    if (shouldAutoJoin({ humanCount: count, autoJoin: cfg.autoJoin, connected })) {
      debugLog(`[vSU] auto-join triggered for ${channel.id}`);
      await joinAndStart(channel).catch((e) => console.error('auto-join failed:', e.message));
    } else if (shouldAutoLeave({ humanCount: count, connected })) {
      debugLog(`[vSU] auto-leave triggered for ${channel.id}`);
      await stopAndLeave(guild.id, channel.id).catch((e) => console.error('auto-leave failed:', e.message));
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, guild, member } = interaction;
    try {
      if (commandName === 'join') {
        const vc = member.voice?.channel;
        if (!vc) return interaction.reply({ content: '❌ Join a voice channel first.', ephemeral: true });
        if (manager.isActive(guild.id, vc.id)) return interaction.reply({ content: '✅ Already recording this channel.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        await joinAndStart(vc);
        return interaction.editReply('✅ Recording started.');
      }
      if (commandName === 'leave') {
        const vc = member.voice?.channel;
        const channelId = vc?.id;
        if (!channelId || !manager.isActive(guild.id, channelId)) return interaction.reply({ content: "❌ I'm not recording here.", ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        await stopAndLeave(guild.id, channelId);
        return interaction.editReply('✅ Stopped. Processing — notes will post shortly.');
      }
      if (commandName === 'summary') {
        const id = interaction.options.getInteger('meeting') ?? db.listRecent(guild.id, 1)[0]?.id;
        const s = id ? db.getSummary(id) : null;
        if (!s) return interaction.reply({ content: '❌ No summary found.', ephemeral: true });
        const m = db.getMeeting(id);
        const parts = chunk(renderNotes(s.notes, s.talktime, { channelName: m.channel_name, date: m.started_at }));
        await interaction.reply({ content: parts[0], ephemeral: true });
        for (const p of parts.slice(1)) await interaction.followUp({ content: p, ephemeral: true });
        return;
      }
      if (commandName === 'post') {
        const id = interaction.options.getInteger('meeting') ?? db.listRecent(guild.id, 1)[0]?.id;
        const s = id ? db.getSummary(id) : null;
        if (!s) return interaction.reply({ content: '❌ No summary found.', ephemeral: true });
        const m = db.getMeeting(id);
        const cfg = getGuildConfig(db, guild.id);
        const parts = chunk(renderNotes(s.notes, s.talktime, { channelName: m.channel_name, date: m.started_at }));
        await interaction.deferReply({ ephemeral: true });

        let target = interaction.channel;
        if (cfg.useThread && interaction.channel?.type === ChannelType.GuildText) {
          // Fall back to the channel itself if thread creation fails (e.g. missing perms).
          target = await interaction.channel.threads
            .create({ name: `Notes — ${m.channel_name} ${m.started_at.slice(0, 10)}` })
            .catch(() => interaction.channel);
        }
        for (const p of parts) await target.send(p);
        const where = target === interaction.channel ? 'this channel' : `thread <#${target.id}>`;
        return interaction.editReply(`✅ Posted summary for meeting #${id} in ${where}.`);
      }
      if (commandName === 'history') {
        const rows = db.listRecent(guild.id, 10);
        const text = rows.length ? rows.map((m) => `#${m.id} • ${m.channel_name} • ${m.started_at} • ${m.status}`).join('\n') : 'No meetings yet.';
        return interaction.reply({ content: text, ephemeral: true });
      }
      if (commandName === 'status') {
        const sessions = [...manager.active.entries()];
        const activeText = sessions.length
          ? sessions.map(([k, s]) => `🔴 Recording in <#${s.channelId}> (meeting #${s.meetingId})`).join('\n')
          : '🟢 Not currently recording.';
        const recent = db.listRecent(guild.id, 5);
        const recentText = recent.length
          ? '\n\n**Recent meetings:**\n' + recent.map((m) => `#${m.id} • ${m.channel_name} • ${m.started_at} • ${m.status}`).join('\n')
          : '';
        return interaction.reply({ content: activeText + recentText, ephemeral: true });
      }
      if (commandName === 'raw') {
        const id = interaction.options.getInteger('meeting') ?? db.listRecent(guild.id, 1)[0]?.id;
        const m = id ? db.getMeeting(id) : null;
        if (!m) return interaction.reply({ content: '❌ No meeting found.', ephemeral: true });
        const attendees = db.listAttendees(id);
        const utterances = db.listUtterances(id);
        const summary = db.getSummary(id);
        const payload = {
          meeting: m,
          attendees: attendees.map((a) => ({ user_id: a.user_id, display_name: a.display_name })),
          utteranceCount: utterances.length,
          utterances: utterances.slice(0, 20).map((u) => ({ speaker: u.display_name, start_ms: u.start_ms, end_ms: u.end_ms, text: u.text })),
          summary: summary ? { model: summary.model_used, created: summary.created_at } : null,
        };
        const json = JSON.stringify(payload, null, 2);
        const parts = chunk(json, 1900);
        await interaction.reply({ content: '```json\n' + parts[0] + '\n```', ephemeral: true });
        for (const p of parts.slice(1)) await interaction.followUp({ content: '```json\n' + p + '\n```', ephemeral: true });
        return;
      }
      if (commandName === 'search') {
        const kw = interaction.options.getString('keyword');
        const hits = db.searchUtterances(guild.id, kw);
        if (!hits.length) return interaction.reply({ content: `No matches for "${kw}".`, ephemeral: true });
        const text = hits.slice(0, 10).map((h) => `#${h.meeting_id} ${h.display_name}: ${h.text}`).join('\n');
        return interaction.reply({ content: chunk(text)[0], ephemeral: true });
      }
      if (commandName === 'setup') {
        const input = {
          provider: interaction.options.getString('provider') ?? undefined,
          model: interaction.options.getString('model') ?? undefined,
          fallbackProvider: interaction.options.getString('fallback_provider') ?? undefined,
          fallbackModel: interaction.options.getString('fallback_model') ?? undefined,
          sttProvider: interaction.options.getString('stt_provider') ?? undefined,
          sttModel: interaction.options.getString('stt_model') ?? undefined,
          whisperModel: interaction.options.getString('whisper_model') ?? undefined,
          notesChannelId: interaction.options.getChannel('notes_channel')?.id,
          useThread: interaction.options.getBoolean('thread') ?? undefined,
          autoJoin: interaction.options.getBoolean('autojoin') ?? undefined,
          language: interaction.options.getString('language') ?? undefined,
          summary_language: interaction.options.getString('summary_language') ?? undefined,
        };
        const result = validateSetup(input, config);
        if (!result.ok) return interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
        const merged = setGuildConfig(db, guild.id, result.patch);
        return interaction.reply({ content: `✅ Config updated:\n\`\`\`json\n${JSON.stringify(merged, null, 2)}\n\`\`\``, ephemeral: true });
      }
    } catch (err) {
      console.error('interaction error:', err);
      const msg = `❌ Error: ${err.message}`;
      if (interaction.deferred || interaction.replied) interaction.editReply(msg).catch(() => {});
      else interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  });

  // Log in. A bad/expired token rejects this promise; without a catch that
  // becomes an unhandled rejection and kills the process (taking the web
  // dashboard down with it — the very tool meant to fix the token). Surface it
  // through the client's 'error' channel instead so the controller can report it.
  const loginResult = client.login(config.discordToken).catch((err) => {
    client.emit('error', err instanceof Error ? err : new Error(String(err)));
  });
  return { client, manager, stopAndLeave, loginResult };
}
