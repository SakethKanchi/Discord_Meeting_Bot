// src/web/api.js
import { Router } from 'express';
import { ChannelType } from 'discord.js';
import { rm, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureMixedWav } from '../voice/mix.js';
import { getGuildConfig, setGuildConfig } from '../store/config.js';
import { validateSetup, availableProviders } from '../commands/setup-logic.js';
import { config as env } from '../config/env.js';
import { askMeeting } from '../adapters/summarizer/ask.js';
import { getSummarizer } from '../adapters/summarizer/index.js';
import { buildTranscript, computeTalkTime } from '../pipeline/summarize.js';
import { resolveSummaryLanguage } from '../adapters/summarizer/languages.js';
import { MODEL_SUGGESTIONS, fetchOllamaModels } from '../adapters/summarizer/models.js';
import { secretStatus, setProviderKey, isSecretProvider, connectionStatus, setConnection } from '../store/secrets.js';
import { COMMAND_CATALOG } from '../commands/definitions.js';
import { retryMeeting, retryPlan, RETRYABLE_STATUSES } from '../pipeline/retry.js';
import { availableSttProviders } from '../adapters/stt/index.js';
import { requireAdmin } from './auth.js';

function audioDir(id) {
  return join(env.dataDir, 'audio', String(id));
}

function guildName(client, id, dbNames = {}) {
  return client?.guilds?.cache?.get(id)?.name || dbNames[id] || id;
}

// Does any configured guild still use the local sidecar for transcription?
// Default provider is 'sidecar', so an unconfigured guild counts as sidecar.
function anyGuildUsesSidecar(db) {
  try {
    const rows = db.sql.prepare(`SELECT stt_provider FROM guild_config`).all();
    if (rows.length === 0) return true;
    return rows.some((row) => (row.stt_provider ?? 'sidecar') === 'sidecar');
  } catch { return true; }
}

export function apiRouter({ db, bot = null, client = null, sidecar = null }) {
  const r = Router();
  // The live Discord client may not exist yet (bot starts lazily once creds are
  // set). Always resolve it fresh from the controller so routes pick it up the
  // moment the bot connects, without rebuilding the router. `client` is still
  // accepted directly for tests and the standalone server.
  const liveClient = () => bot?.client || client;

  // Active recordings for a guild, enriched with the voice channel's current
  // members (so the UI can show who's live). Reads in-memory bot sessions; empty
  // when no bot is attached (e.g. the standalone read-only server). Sessions
  // carry a `phase`: 'recording' (capture in progress) or 'processing'
  // (recording stopped, transcribe/summarize pipeline still running).
  function liveMeetings(guildId) {
    const sessions = (bot && typeof bot.liveMeetings === 'function' ? bot.liveMeetings() : [])
      .filter((s) => s.guildId === guildId);
    const c = liveClient();
    return sessions.map((s) => {
      let attendees = db.listAttendees(s.meetingId).map((a) => ({ id: a.user_id, displayName: a.display_name }));
      // Once the bot has left the channel (phase 'processing'), the live voice
      // roster is irrelevant — stick with the stored attendees.
      if (s.phase !== 'processing') {
        const channel = c?.guilds?.cache?.get(s.guildId)?.channels?.cache?.get(s.channelId);
        if (channel?.members) {
          // Prefer the live voice-channel roster (people who joined mid-meeting).
          const live = [...channel.members.values()].filter((m) => !m.user?.bot)
            .map((m) => ({ id: m.id, displayName: m.displayName }));
          if (live.length) attendees = live;
        }
      }
      return { ...s, attendees };
    });
  }

  r.get('/guilds', (_req, res) => {
    const c = liveClient();
    const fromDb = db.listGuilds().map(({ guild_id }) => guild_id);
    const fromCache = c ? [...c.guilds.cache.values()].map((g) => g.id) : [];
    const allIds = [...new Set([...fromDb, ...fromCache])];
    const dbNames = db.getGuildNames();
    res.json(allIds.map((id) => ({ id, name: guildName(c, id, dbNames) })));
  });

  r.get('/guilds/:g/meetings', (req, res) => {
    res.json(db.listRecentRich(req.params.g, 100));
  });

  // In-progress recordings for this guild, enriched with the channel's current
  // voice members (live attendees) when a Discord client is connected. The bot
  // holds active sessions in memory, so this is empty unless the bot is running.
  r.get('/guilds/:g/live', (req, res) => {
    res.json({ live: liveMeetings(req.params.g) });
  });

  // Stop a live recording from the dashboard. Finalizes the meeting (transcribe
  // + summarize + deliver) and disconnects the bot from the voice channel.
  r.post('/guilds/:g/live/:channelId/stop', async (req, res) => {
    if (!bot || typeof bot.stopMeeting !== 'function') {
      return res.status(400).json({ error: 'Live recording is not managed by this server.' });
    }
    try {
      const result = await bot.stopMeeting(req.params.g, req.params.channelId);
      if (!result.ok) return res.status(404).json(result);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Dashboard aggregates — headline stats, talk-time leaderboard, timeline.
  r.get('/guilds/:g/stats', (req, res) => {
    res.json({
      stats: db.guildStats(req.params.g),
      leaderboard: db.talkTimeLeaderboard(req.params.g),
      timeline: db.meetingsTimeline(req.params.g, 30),
    });
  });

  r.get('/meetings/:id', (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    const plan = retryPlan(db, id, { dataDir: env.dataDir });
    res.json({
      meeting,
      summary: db.getSummary(id),
      attendees: db.listAttendees(id),
      utterances: db.listUtterances(id),
      retry: { eligible: RETRYABLE_STATUSES.has(meeting.status) && plan.ok, action: plan.action, reason: plan.reason || null },
      // Recording kept for download (keep_audio guilds) and still on disk.
      hasAudio: !!meeting.audio_retained && existsSync(audioDir(id)),
    });
  });

  // Full export of a meeting for archiving/backup — the whole transcript (not the
  // 20-line preview /raw shows) plus notes. `?format=md` returns a self-contained
  // markdown document as a file download; the default returns JSON. Complements
  // the lack of any retention/backup story.
  r.get('/meetings/:id/export', async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    const summary = db.getSummary(id);
    const attendees = db.listAttendees(id).map((a) => a.display_name);
    const utterances = db.listUtterances(id);
    const date = (meeting.started_at || '').slice(0, 10);
    if (req.query.format === 'md') {
      const { renderNotes } = await import('../delivery/discord-notes.js');
      const lines = [`# ${meeting.channel_name || 'Meeting'} — ${date}`, ''];
      if (attendees.length) lines.push(`**Attendees:** ${attendees.join(', ')}`, '');
      if (summary?.notes) lines.push(renderNotes(summary.notes, summary.talktime || [],
        { channelName: meeting.channel_name, date: meeting.started_at }), '');
      lines.push('## Full transcript', '');
      for (const u of utterances) {
        const t = Math.floor((u.start_ms || 0) / 1000);
        const mm = String(Math.floor(t / 60)).padStart(2, '0');
        const ss = String(t % 60).padStart(2, '0');
        lines.push(`**[${mm}:${ss}] ${u.display_name}:** ${u.text}`);
      }
      const md = lines.join('\n');
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="meeting-${id}-${date}.md"`);
      return res.send(md);
    }
    res.setHeader('Content-Disposition', `attachment; filename="meeting-${id}-${date}.json"`);
    res.json({ meeting, summary, attendees, utterances });
  });

  // Download a meeting's recording as one mixed WAV (per-speaker tracks summed
  // on a shared timeline). Mixed lazily on first request and cached in the
  // meeting's audio dir. Only exists for guilds with "keep recordings" on —
  // otherwise the PCM was deleted right after the notes were posted.
  r.get('/meetings/:id/audio', async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    // A live/processing meeting is still growing its track set; a mix made now
    // would be partial AND get cached. Wait for the pipeline to finish.
    if (meeting.status === 'recording' || meeting.status === 'processing') {
      return res.status(409).json({ error: 'Meeting is still being recorded/processed — try again when it finishes.' });
    }
    try {
      const wav = await ensureMixedWav(audioDir(id));
      if (!wav) return res.status(404).json({ error: 'No audio is stored for this meeting.' });
      const { size } = await stat(wav);
      const date = (meeting.started_at || '').slice(0, 10);
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Length', size);
      res.setHeader('Content-Disposition', `attachment; filename="meeting-${id}-${date}.wav"`);
      createReadStream(wav).pipe(res);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Retry a failed/stuck meeting: re-summarize if the transcript survived, else
  // re-transcribe from the saved PCM. Posts to Discord too when a live client
  // is attached. Returns the new status so the UI can refresh.
  r.post('/meetings/:id/retry', async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    const c = liveClient();
    const deliver = c
      ? async (notes, talktime) => {
          const cfg = getGuildConfig(db, meeting.guild_id);
          const { postNotes } = await import('../delivery/post.js');
          await postNotes({ client: c, meeting, cfg, notes, talktime });
        }
      : null;
    try {
      const result = await retryMeeting(db, id, { dataDir: env.dataDir, deliver });
      if (!result.ok) return res.status(502).json({ error: result.reason || 'Retry failed.', ...result });
      res.json({ ok: true, ...result, meeting: db.getMeeting(id) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.delete('/meetings/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    db.deleteMeeting(id);
    await rm(audioDir(id), { recursive: true, force: true }).catch(() => {});
    res.json({ ok: true });
  });

  // Merge sourceIds into the target meeting, then re-summarize the combined
  // transcript. Sources must share the target's guild.
  r.post('/meetings/:id/merge', requireAdmin, async (req, res) => {
    const targetId = Number(req.params.id);
    const target = db.getMeeting(targetId);
    if (!target) return res.status(404).json({ error: 'meeting not found' });
    const sourceIds = (Array.isArray(req.body?.sourceIds) ? req.body.sourceIds : [])
      .map(Number).filter((s) => s && s !== targetId);
    if (sourceIds.length === 0) return res.status(400).json({ error: 'sourceIds required' });
    for (const sid of sourceIds) {
      const m = db.getMeeting(sid);
      if (!m) return res.status(404).json({ error: `meeting ${sid} not found` });
      if (m.guild_id !== target.guild_id) return res.status(400).json({ error: 'meetings belong to different guilds' });
    }

    const merged = db.mergeMeetings(targetId, sourceIds);

    // Re-summarize the now-combined transcript and replace the target's notes.
    const utterances = db.listUtterances(targetId).map((u) => ({
      displayName: u.display_name, userId: u.user_id, text: u.text,
      startMs: u.start_ms, endMs: u.end_ms,
    }));
    const cfg = getGuildConfig(db, target.guild_id);
    const transcript = buildTranscript(utterances);
    const talktime = computeTalkTime(utterances);
    const meta = {
      channelName: target.channel_name, date: target.started_at,
      attendees: db.listAttendees(targetId).map((a) => a.display_name),
      summaryLanguage: resolveSummaryLanguage(cfg),
    };
    try {
      const notes = await getSummarizer(cfg).summarize(transcript, meta);
      db.clearSummary(targetId);
      db.saveSummary(targetId, notes, talktime, `${cfg.summarizerProvider}:${cfg.summarizerModel || ''}`);
      db.seedTodos(targetId, target.guild_id, notes.actionItems || []);
    } catch (e) {
      // Data is already merged; surface the summarize failure but don't unwind.
      return res.status(502).json({ error: e.message, merged });
    }
    for (const sid of merged) await rm(audioDir(sid), { recursive: true, force: true }).catch(() => {});
    res.json({ ok: true, merged });
  });

  r.get('/guilds/:g/todos', (req, res) => {
    const { open, assignee } = req.query;
    const opts = { open: open === '1' };
    if (assignee !== undefined) opts.assignee = assignee === '__unassigned__' ? null : assignee;
    res.json(db.listTodos(req.params.g, opts));
  });

  r.get('/guilds/:g/assignees', (req, res) => {
    res.json(db.listAssignees(req.params.g));
  });

  r.patch('/todos/:id', (req, res) => {
    db.setTodoDone(Number(req.params.id), !!req.body.done);
    res.json({ ok: true });
  });

  r.get('/guilds/:g/search', (req, res) => {
    const q = (req.query.q || '').trim();
    res.json(q ? db.searchUtterances(req.params.g, q) : []);
  });

  r.get('/guilds/:g/config', (req, res) => {
    const guild = liveClient()?.guilds?.cache?.get(req.params.g);
    const channels = guild
      ? [...guild.channels.cache.filter((c) => c.type === ChannelType.GuildText).values()]
          .map((c) => ({ id: c.id, name: c.name }))
      : [];
    // Separate key so the notes-channel picker (text channels) stays untouched.
    const voiceChannels = guild
      ? [...guild.channels.cache.filter((c) => c.type === ChannelType.GuildVoice).values()]
          .map((c) => ({ id: c.id, name: c.name }))
      : [];
    res.json({
      config: getGuildConfig(db, req.params.g),
      providers: availableProviders(env),
      sttProviders: availableSttProviders(env),
      channels,
      voiceChannels,
      models: MODEL_SUGGESTIONS,
      secrets: secretStatus(env),
    });
  });

  r.patch('/guilds/:g/config', async (req, res) => {
    const result = validateSetup(req.body, env);
    if (!result.ok) return res.status(400).json({ error: result.error });
    const config = setGuildConfig(db, req.params.g, result.patch);
    // Follow the transcription backend with the local sidecar process: start it
    // when a guild switches to the sidecar, and stop it when no guild needs it
    // anymore (switched everything to a cloud API). Best-effort, non-blocking.
    let sidecarStatus = sidecar ? sidecar.status() : null;
    if (sidecar && sidecar.managed() && result.patch.sttProvider !== undefined) {
      try {
        if (result.patch.sttProvider === 'sidecar') {
          await sidecar.start();
        } else if (!anyGuildUsesSidecar(db)) {
          await sidecar.stop();
        }
        sidecarStatus = sidecar.status();
      } catch { /* surface via status only */ }
    }
    res.json({ ok: true, config, sidecar: sidecarStatus });
  });

  // Live model list for the chosen provider (Ollama is queried for installed tags).
  r.get('/providers/:provider/models', async (req, res) => {
    const { provider } = req.params;
    const suggested = MODEL_SUGGESTIONS[provider] || [];
    if (provider === 'ollama') {
      const installed = await fetchOllamaModels(env.ollama.url);
      // Installed first (what the user actually has), then suggestions not already listed.
      const merged = [...installed, ...suggested.filter((m) => !installed.includes(m))];
      return res.json({ models: merged, installed });
    }
    res.json({ models: suggested, installed: [] });
  });

  // Set or clear a provider's API key. Persists to .env and updates the live
  // config so it takes effect immediately. Never returns the key value.
  r.put('/providers/:provider/key', requireAdmin, async (req, res) => {
    const { provider } = req.params;
    if (!isSecretProvider(provider)) {
      return res.status(400).json({ error: `Provider "${provider}" has no editable API key.` });
    }
    const value = typeof req.body?.key === 'string' ? req.body.key : '';
    try {
      const secrets = await setProviderKey(provider, value, { env });
      res.json({ ok: true, secrets, providers: availableProviders(env) });
    } catch (e) {
      // Validation failures (control chars in the key) are the client's fault.
      res.status(400).json({ error: e.message });
    }
  });

  // ── System / connection ─────────────────────────────────────────────────
  // The slash-command reference for the dashboard's Commands page.
  r.get('/commands', (_req, res) => {
    res.json({ commands: COMMAND_CATALOG });
  });

  // Overall onboarding + bot connection state for the UI. Never leaks secrets.
  r.get('/system/status', (_req, res) => {
    const c = liveClient();
    res.json({
      connection: connectionStatus(env),
      providers: availableProviders(env),
      sttProviders: availableSttProviders(env),
      secrets: secretStatus(env),
      bot: bot
        ? bot.status()
        // No controller (standalone server): report live client if present.
        : { state: c ? 'ready' : 'stopped', connected: !!c, hasCreds: !!env.discordToken,
            user: c?.user ? { tag: c.user.tag, id: c.user.id } : null, guildCount: c?.guilds?.cache?.size ?? 0 },
      managed: !!bot,
      sttUrl: env.sttUrl,
      sidecar: sidecar ? sidecar.status() : null,
    });
  });

  // Save Discord token / client id / STT url (any subset), persist to .env,
  // apply live, and (re)start the bot if it's managed and creds are present.
  r.put('/system/connection', requireAdmin, async (req, res) => {
    const patch = {};
    for (const k of ['discordToken', 'discordClientId', 'sttUrl']) {
      if (typeof req.body?.[k] === 'string') patch[k] = req.body[k];
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No recognized settings to update.' });
    let connection;
    try {
      connection = await setConnection(patch, { env });
    } catch (e) {
      // Invalid input (bad STT URL, control chars) → 400, not a server error.
      return res.status(400).json({ error: e.message });
    }
    try {
      let botResult = null;
      // Restart the bot when Discord creds changed and we manage it.
      if (bot && (patch.discordToken !== undefined || patch.discordClientId !== undefined)) {
        botResult = await bot.restart();
      }
      res.json({ ok: true, connection, bot: bot ? bot.status() : null, botResult });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Manually (re)start or stop the bot.
  r.post('/system/bot/:action', requireAdmin, async (req, res) => {
    if (!bot) return res.status(400).json({ error: 'Bot is not managed by this server.' });
    const { action } = req.params;
    try {
      if (action === 'start') await bot.start();
      else if (action === 'restart') await bot.restart();
      else if (action === 'stop') await bot.stop();
      else return res.status(400).json({ error: `Unknown action "${action}".` });
      res.json({ ok: true, bot: bot.status() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Start/stop/restart the local STT sidecar process from the dashboard. The
  // sidecar is a single global process (transcription backend), so this is not
  // per-guild. Unmanaged in Docker (separate container) — report that clearly.
  r.post('/system/sidecar/:action', requireAdmin, async (req, res) => {
    if (!sidecar) return res.status(400).json({ error: 'Sidecar is not managed by this server.' });
    const { action } = req.params;
    if (!sidecar.managed() && action !== 'status') {
      return res.status(400).json({ error: sidecar.status().error || 'Local sidecar is not manageable here (running in Docker or STT_URL is remote).', sidecar: sidecar.status() });
    }
    try {
      let result = { ok: true };
      if (action === 'start') result = await sidecar.start();
      else if (action === 'restart') result = await sidecar.restart();
      else if (action === 'stop') result = await sidecar.stop();
      else if (action !== 'status') return res.status(400).json({ error: `Unknown action "${action}".` });
      const status = sidecar.status();
      if (!result.ok) return res.status(502).json({ error: result.error || 'Sidecar action failed.', sidecar: status });
      res.json({ ok: true, sidecar: status });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/guilds/:g/meetings/:id/ask', async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    const question = (req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: 'question required' });
    const transcript = db.listUtterances(id).map((u) => `${u.display_name}: ${u.text}`).join('\n');
    try {
      const answer = await askMeeting({
        cfg: getGuildConfig(db, meeting.guild_id), env, question, transcript,
        meta: { channelName: meeting.channel_name, date: meeting.started_at,
          attendees: db.listAttendees(id).map((a) => a.display_name) },
      });
      res.json({ answer });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  return r;
}
