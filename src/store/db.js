import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT, channel_id TEXT, channel_name TEXT,
  started_at TEXT, ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'recording',
  audio_retained INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS attendees (
  meeting_id INTEGER, user_id TEXT, display_name TEXT,
  UNIQUE(meeting_id, user_id)
);
CREATE TABLE IF NOT EXISTS utterances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER, user_id TEXT, display_name TEXT,
  start_ms INTEGER, end_ms INTEGER, text TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS utterances_fts USING fts5(
  text, meeting_id UNINDEXED, content='utterances', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS utterances_ai AFTER INSERT ON utterances BEGIN
  INSERT INTO utterances_fts(rowid, text, meeting_id) VALUES (new.id, new.text, new.meeting_id);
END;
CREATE TRIGGER IF NOT EXISTS utterances_ad AFTER DELETE ON utterances BEGIN
  INSERT INTO utterances_fts(utterances_fts, rowid, text, meeting_id) VALUES ('delete', old.id, old.text, old.meeting_id);
END;
CREATE TABLE IF NOT EXISTS summaries (
  meeting_id INTEGER PRIMARY KEY,
  notes_json TEXT, talktime_json TEXT, model_used TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT PRIMARY KEY,
  summarizer_provider TEXT, summarizer_model TEXT,
  stt_provider TEXT, stt_model TEXT,
  whisper_model TEXT, notes_channel_id TEXT,
  use_thread INTEGER, auto_join INTEGER, language TEXT, summary_language TEXT,
  auto_join_channel_ids TEXT, keep_audio INTEGER
);
CREATE TABLE IF NOT EXISTS guilds (
  guild_id TEXT PRIMARY KEY,
  name TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  meeting_id INTEGER,
  assignee TEXT,
  task TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS todos_dedup ON todos(meeting_id, COALESCE(assignee, ''), task);
CREATE INDEX IF NOT EXISTS utterances_meeting ON utterances(meeting_id);
CREATE INDEX IF NOT EXISTS todos_meeting ON todos(meeting_id);
CREATE INDEX IF NOT EXISTS todos_guild ON todos(guild_id);
CREATE INDEX IF NOT EXISTS meetings_guild ON meetings(guild_id);
`;

export function openDb(path) {
  const sql = new DatabaseSync(path);
  sql.exec('PRAGMA journal_mode = WAL');
  // Wait up to 5s for a held write lock instead of failing instantly with
  // SQLITE_BUSY ("database is locked"). WAL gives many readers + one writer;
  // this covers brief writer/writer or writer/checkpoint overlap (e.g. the web
  // UI reading while the bot writes on meeting-end). ponytail: 5s ceiling, not a
  // fix for two concurrent bot instances — run one.
  sql.exec('PRAGMA busy_timeout = 5000');
  sql.exec(SCHEMA);

  // Migration: add summary_language to dbs created before the column existed.
  const cols = sql.prepare(`PRAGMA table_info(guild_config)`).all();
  if (!cols.some((c) => c.name === 'summary_language')) {
    sql.exec(`ALTER TABLE guild_config ADD COLUMN summary_language TEXT`);
  }
  // Migration: add cloud STT columns to dbs created before they existed.
  if (!cols.some((c) => c.name === 'stt_provider')) {
    sql.exec(`ALTER TABLE guild_config ADD COLUMN stt_provider TEXT`);
  }
  if (!cols.some((c) => c.name === 'stt_model')) {
    sql.exec(`ALTER TABLE guild_config ADD COLUMN stt_model TEXT`);
  }
  // Migration: add per-stage timing metrics to dbs created before this column
  // existed (Measurement section of the speed plan).
  const summaryCols = sql.prepare(`PRAGMA table_info(summaries)`).all();
  if (!summaryCols.some((c) => c.name === 'timings_json')) {
    sql.exec(`ALTER TABLE summaries ADD COLUMN timings_json TEXT`);
  }
  // Migration: auto-join channel allow-list (JSON array) + keep-recordings toggle.
  if (!cols.some((c) => c.name === 'auto_join_channel_ids')) {
    sql.exec(`ALTER TABLE guild_config ADD COLUMN auto_join_channel_ids TEXT`);
  }
  if (!cols.some((c) => c.name === 'keep_audio')) {
    sql.exec(`ALTER TABLE guild_config ADD COLUMN keep_audio INTEGER`);
  }
  // Migration: per-meeting audio retention flag (audio kept for download).
  const meetingCols = sql.prepare(`PRAGMA table_info(meetings)`).all();
  if (!meetingCols.some((c) => c.name === 'audio_retained')) {
    sql.exec(`ALTER TABLE meetings ADD COLUMN audio_retained INTEGER NOT NULL DEFAULT 0`);
  }

  return {
    sql,
    createMeeting({ guildId, channelId, channelName, startedAt }) {
      const r = sql.prepare(
        `INSERT INTO meetings (guild_id, channel_id, channel_name, started_at, status)
         VALUES (?, ?, ?, ?, 'recording')`
      ).run(guildId, channelId, channelName, startedAt);
      return r.lastInsertRowid;
    },
    getMeeting(id) { return sql.prepare(`SELECT * FROM meetings WHERE id = ?`).get(id); },
    // Remove a meeting and everything attached to it. The AFTER DELETE trigger
    // on utterances keeps the FTS index in sync. Audio files are removed by the
    // caller (db layer has no fs). Wrapped in a transaction — all or nothing.
    deleteMeeting(id) {
      sql.exec('BEGIN');
      try {
        sql.prepare(`DELETE FROM utterances WHERE meeting_id = ?`).run(id);
        sql.prepare(`DELETE FROM attendees WHERE meeting_id = ?`).run(id);
        sql.prepare(`DELETE FROM summaries WHERE meeting_id = ?`).run(id);
        sql.prepare(`DELETE FROM todos WHERE meeting_id = ?`).run(id);
        sql.prepare(`DELETE FROM meetings WHERE id = ?`).run(id);
        sql.exec('COMMIT');
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
    // Move all utterances + attendees from sourceIds into targetId, then delete
    // the source meetings (and their summaries/todos). Re-summarizing the merged
    // transcript is the caller's job. Returns the ids actually merged.
    mergeMeetings(targetId, sourceIds) {
      const sources = (sourceIds || []).map(Number).filter((s) => s && s !== targetId);
      if (sources.length === 0) return [];
      const placeholders = sources.map(() => '?').join(',');
      sql.exec('BEGIN');
      try {
        sql.prepare(`UPDATE utterances SET meeting_id = ? WHERE meeting_id IN (${placeholders})`).run(targetId, ...sources);
        // Carry over attendees not already on the target.
        sql.prepare(
          `INSERT OR IGNORE INTO attendees (meeting_id, user_id, display_name)
           SELECT ?, user_id, display_name FROM attendees WHERE meeting_id IN (${placeholders})`
        ).run(targetId, ...sources);
        sql.prepare(`DELETE FROM attendees WHERE meeting_id IN (${placeholders})`).run(...sources);
        sql.prepare(`DELETE FROM summaries WHERE meeting_id IN (${placeholders})`).run(...sources);
        sql.prepare(`DELETE FROM todos WHERE meeting_id IN (${placeholders})`).run(...sources);
        sql.prepare(`DELETE FROM meetings WHERE id IN (${placeholders})`).run(...sources);
        sql.exec('COMMIT');
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
      return sources;
    },
    // Drop a meeting's existing summary + auto-seeded todos (before re-summarizing on merge).
    clearSummary(meetingId) {
      sql.prepare(`DELETE FROM summaries WHERE meeting_id = ?`).run(meetingId);
      sql.prepare(`DELETE FROM todos WHERE meeting_id = ?`).run(meetingId);
    },
    setMeetingStatus(id, status, endedAt = null) {
      // ended_at only fills in when still null: the recording-stop timestamp
      // (stamped at 'processing') must win over the pipeline-finish timestamp
      // passed at 'done', so durations reflect recording time, not pipeline time.
      sql.prepare(`UPDATE meetings SET status = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ?`)
        .run(status, endedAt, id);
    },
    setAudioRetained(id, retained) {
      sql.prepare(`UPDATE meetings SET audio_retained = ? WHERE id = ?`).run(retained ? 1 : 0, id);
    },
    listRecent(guildId, limit = 10) {
      return sql.prepare(
        `SELECT m.*, (SELECT COUNT(*) FROM utterances u WHERE u.meeting_id = m.id) AS utterance_count
         FROM meetings m WHERE m.guild_id = ? ORDER BY m.id DESC LIMIT ?`
      ).all(guildId, limit);
    },
    findOrphanedMeetings() {
      return sql.prepare(`SELECT * FROM meetings WHERE status IN ('recording','processing') ORDER BY id`).all();
    },
    addAttendee(meetingId, userId, displayName) {
      sql.prepare(`INSERT OR IGNORE INTO attendees (meeting_id, user_id, display_name) VALUES (?, ?, ?)`)
        .run(meetingId, userId, displayName);
    },
    listAttendees(meetingId) {
      return sql.prepare(`SELECT * FROM attendees WHERE meeting_id = ?`).all(meetingId);
    },
    addUtterance({ meetingId, userId, displayName, startMs, endMs, text }) {
      sql.prepare(`INSERT INTO utterances (meeting_id, user_id, display_name, start_ms, end_ms, text)
                   VALUES (?, ?, ?, ?, ?, ?)`).run(meetingId, userId, displayName, startMs, endMs, text);
    },
    listUtterances(meetingId) {
      return sql.prepare(`SELECT * FROM utterances WHERE meeting_id = ? ORDER BY start_ms`).all(meetingId);
    },
    searchUtterances(guildId, keyword) {
      // Bind user input as a quoted FTS5 phrase literal so operator chars never throw.
      const safe = `"${String(keyword).replace(/"/g, '""')}"`;
      return sql.prepare(
        `SELECT u.* FROM utterances_fts f
         JOIN utterances u ON u.id = f.rowid
         JOIN meetings m ON m.id = u.meeting_id
         WHERE m.guild_id = ? AND utterances_fts MATCH ?
         ORDER BY u.meeting_id DESC LIMIT 50`
      ).all(guildId, safe);
    },
    // `createdAt` and `timings` are both optional and backward-compatible:
    // existing callers (retry.js/api.js pass 4 args; a couple of scripts/tests
    // pass a 5th createdAt override for backfilled data) keep working
    // unchanged. `timings` (transcribeMs/summarizeMs/tracks/audioMs) is a new,
    // purely additive 6th arg from the orchestrator's per-stage measurement.
    saveSummary(meetingId, notes, talktime, modelUsed, createdAt = new Date().toISOString(), timings = null) {
      sql.prepare(
        `INSERT OR REPLACE INTO summaries (meeting_id, notes_json, talktime_json, model_used, timings_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(meetingId, JSON.stringify(notes), JSON.stringify(talktime), modelUsed, timings ? JSON.stringify(timings) : null, createdAt);
    },
    getSummary(meetingId) {
      const row = sql.prepare(`SELECT * FROM summaries WHERE meeting_id = ?`).get(meetingId);
      if (!row) return null;
      const { notes_json, talktime_json, timings_json, ...rest } = row;
      let timings = null;
      try { if (timings_json) timings = JSON.parse(timings_json); } catch { /* null-safe */ }
      return { ...rest, notes: JSON.parse(notes_json), talktime: JSON.parse(talktime_json), timings };
    },
    seedTodos(meetingId, guildId, actionItems, createdAt = new Date().toISOString()) {
      const stmt = sql.prepare(
        `INSERT OR IGNORE INTO todos (guild_id, meeting_id, assignee, task, created_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      let n = 0;
      for (const a of actionItems || []) {
        if (!a || !a.task) continue;
        const r = stmt.run(guildId, meetingId, a.assignee ?? null, a.task, createdAt);
        n += r.changes;
      }
      return n;
    },
    listTodos(guildId, { open = false, assignee } = {}) {
      const where = ['guild_id = ?'];
      const args = [guildId];
      if (open) where.push('done = 0');
      if (assignee !== undefined) {
        if (assignee === null) where.push('assignee IS NULL');
        else { where.push('assignee = ?'); args.push(assignee); }
      }
      return sql.prepare(`SELECT * FROM todos WHERE ${where.join(' AND ')} ORDER BY id DESC`).all(...args);
    },
    listAssignees(guildId) {
      // NULL sorts first (SQLite), then alphabetical — the dropdown renders NULL as "Unassigned".
      return sql.prepare(
        `SELECT DISTINCT assignee FROM todos WHERE guild_id = ? ORDER BY assignee IS NOT NULL, assignee`
      ).all(guildId);
    },
    setTodoDone(id, done) {
      sql.prepare(`UPDATE todos SET done = ? WHERE id = ?`).run(done ? 1 : 0, id);
    },
    listGuilds() {
      return sql.prepare(
        `SELECT guild_id FROM meetings WHERE guild_id IS NOT NULL
         UNION SELECT guild_id FROM guild_config WHERE guild_id IS NOT NULL
         UNION SELECT guild_id FROM guilds WHERE guild_id IS NOT NULL`
      ).all();
    },
    // Persist a guild's human name so the web UI can label it without a live
    // Discord client (e.g. the standalone API server). Called on bot ready /
    // guildCreate. Idempotent; updates the name if it changed.
    upsertGuild(guildId, name) {
      if (!guildId) return;
      sql.prepare(
        `INSERT INTO guilds (guild_id, name, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`
      ).run(guildId, name ?? null, new Date().toISOString());
    },
    // Map of guild_id -> name for every guild we've seen a name for.
    getGuildNames() {
      const rows = sql.prepare(`SELECT guild_id, name FROM guilds WHERE name IS NOT NULL`).all();
      return Object.fromEntries(rows.map((r) => [r.guild_id, r.name]));
    },
    backfillTodos() {
      // Seed any todos missing from summaries. Use each summary's own created_at
      // (falling back to the meeting's start) so backfilled todos carry the real
      // meeting date — not the time the backfill happened to run. Otherwise every
      // backfilled item collapses onto one day in the Action items view.
      const rows = sql.prepare(
        `SELECT s.meeting_id, m.guild_id, s.notes_json,
                COALESCE(s.created_at, m.started_at) AS created_at
           FROM summaries s JOIN meetings m ON m.id = s.meeting_id`
      ).all();
      let n = 0;
      for (const row of rows) {
        const notes = JSON.parse(row.notes_json);
        n += this.seedTodos(row.meeting_id, row.guild_id, notes.actionItems || [], row.created_at);
      }
      // Repair pass: realign any existing todo whose created_at drifted from its
      // summary date (e.g. seeded by an older backfill that used now()).
      this.realignTodoDates();
      return n;
    },

    // Re-stamp every todo's created_at to its summary's created_at (or the
    // meeting's started_at). Fixes historical rows that were all seeded with the
    // backfill run time. Returns the number of rows changed.
    realignTodoDates() {
      const r = sql.prepare(
        `UPDATE todos
            SET created_at = COALESCE(
              (SELECT s.created_at FROM summaries s WHERE s.meeting_id = todos.meeting_id),
              (SELECT m.started_at FROM meetings m WHERE m.id = todos.meeting_id),
              created_at
            )
          WHERE meeting_id IS NOT NULL
            AND created_at IS NOT (
              SELECT COALESCE(s.created_at, m.started_at)
                FROM meetings m LEFT JOIN summaries s ON s.meeting_id = m.id
               WHERE m.id = todos.meeting_id
            )`
      ).run();
      return r.changes;
    },

    // ── Dashboard aggregates ────────────────────────────────────────────────
    // Meetings enriched with per-row counts + a short summary preview, in one
    // pass. Used by the meetings overview + dashboard cards so the client never
    // needs N detail fetches just to render a list.
    listRecentRich(guildId, limit = 50) {
      const rows = sql.prepare(
        `SELECT m.*,
            (SELECT COUNT(*) FROM utterances u WHERE u.meeting_id = m.id) AS utterance_count,
            (SELECT COUNT(*) FROM attendees a WHERE a.meeting_id = m.id) AS attendee_count,
            (SELECT COUNT(*) FROM todos t WHERE t.meeting_id = m.id) AS action_count,
            (SELECT COUNT(*) FROM todos t WHERE t.meeting_id = m.id AND t.done = 0) AS open_action_count,
            s.notes_json, s.talktime_json
         FROM meetings m
         LEFT JOIN summaries s ON s.meeting_id = m.id
         WHERE m.guild_id = ? ORDER BY m.id DESC LIMIT ?`
      ).all(guildId, limit);
      return rows.map(({ notes_json, talktime_json, ...m }) => {
        let tldr = null, topic_count = 0, decision_count = 0;
        let talktime = [];
        try { if (notes_json) {
          const n = JSON.parse(notes_json);
          tldr = n.tldr ?? null;
          topic_count = Array.isArray(n.topics) ? n.topics.length : 0;
          decision_count = Array.isArray(n.decisions) ? n.decisions.length : 0;
        } } catch { /* keep defaults */ }
        try { if (talktime_json) talktime = JSON.parse(talktime_json) || []; } catch { /* [] */ }
        const attendee_names = sql.prepare(
          `SELECT display_name FROM attendees WHERE meeting_id = ? ORDER BY display_name`
        ).all(m.id).map((a) => a.display_name);
        return { ...m, tldr, topic_count, decision_count, talktime, attendee_names,
          has_summary: notes_json != null,
          // Failed/stuck meetings the dashboard can offer a retry for. The
          // detail endpoint refines this with a precise plan (audio on disk?).
          failed: ['transcription_failed', 'summary_failed', 'processing'].includes(m.status) };
      });
    },

    // Headline numbers for a guild's dashboard.
    guildStats(guildId) {
      const base = sql.prepare(
        `SELECT
           COUNT(*) AS total_meetings,
           SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_meetings,
           MIN(started_at) AS first_meeting,
           MAX(started_at) AS last_meeting
         FROM meetings WHERE guild_id = ?`
      ).get(guildId) || {};
      const utt = sql.prepare(
        `SELECT COUNT(*) AS c FROM utterances u JOIN meetings m ON m.id = u.meeting_id WHERE m.guild_id = ?`
      ).get(guildId) || { c: 0 };
      const todoCounts = sql.prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN done = 0 THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN done = 1 THEN 1 ELSE 0 END) AS done
         FROM todos WHERE guild_id = ?`
      ).get(guildId) || {};
      const people = sql.prepare(
        `SELECT COUNT(DISTINCT user_id) AS c FROM attendees a JOIN meetings m ON m.id = a.meeting_id WHERE m.guild_id = ?`
      ).get(guildId) || { c: 0 };

      // Total talk-time ms summed from stored talktime JSON.
      const tt = sql.prepare(
        `SELECT s.talktime_json FROM summaries s JOIN meetings m ON m.id = s.meeting_id WHERE m.guild_id = ?`
      ).all(guildId);
      let total_talk_ms = 0;
      for (const row of tt) {
        try { for (const p of JSON.parse(row.talktime_json) || []) total_talk_ms += p.ms || 0; }
        catch { /* skip */ }
      }
      return {
        totalMeetings: base.total_meetings || 0,
        doneMeetings: base.done_meetings || 0,
        firstMeeting: base.first_meeting || null,
        lastMeeting: base.last_meeting || null,
        totalUtterances: utt.c || 0,
        totalTalkMs: total_talk_ms,
        people: people.c || 0,
        todos: { total: todoCounts.total || 0, open: todoCounts.open || 0, done: todoCounts.done || 0 },
      };
    },

    // Per-person talk-time + meeting count across the guild, descending by ms.
    talkTimeLeaderboard(guildId) {
      const rows = sql.prepare(
        `SELECT s.talktime_json FROM summaries s JOIN meetings m ON m.id = s.meeting_id WHERE m.guild_id = ?`
      ).all(guildId);
      const by = new Map(); // name -> { ms, words, meetings }
      for (const row of rows) {
        let parsed;
        try { parsed = JSON.parse(row.talktime_json) || []; } catch { continue; }
        for (const p of parsed) {
          const name = p.displayName || 'Unknown';
          const cur = by.get(name) || { displayName: name, ms: 0, words: 0, meetings: 0 };
          cur.ms += p.ms || 0;
          cur.words += p.words || 0;
          cur.meetings += 1;
          by.set(name, cur);
        }
      }
      return [...by.values()].sort((a, b) => b.ms - a.ms);
    },

    // Meetings-per-local-day for the timeline chart (last `days` days inclusive).
    meetingsTimeline(guildId, days = 30) {
      const rows = sql.prepare(
        `SELECT started_at FROM meetings WHERE guild_id = ? AND started_at IS NOT NULL`
      ).all(guildId);
      const counts = new Map();
      for (const { started_at } of rows) {
        const d = new Date(String(started_at).replace(' ', 'T'));
        if (Number.isNaN(d.getTime())) continue;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const out = [];
      const today = new Date();
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        out.push({ date: key, count: counts.get(key) || 0 });
      }
      return out;
    },
  };
}
