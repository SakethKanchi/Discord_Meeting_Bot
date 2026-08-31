export class MeetingManager {
  constructor({ db, audioRoot, startCapture, finalize, now = () => new Date().toISOString() }) {
    this.db = db;
    this.audioRoot = audioRoot;
    this.startCapture = startCapture;     // (ctx) -> { registry }
    this.finalize = finalize;             // async (meetingId, tracks, ctx) -> void
    this.now = now;
    this.active = new Map();              // key "guild:channel" -> session
    this.processing = new Map();          // meetingId -> post-recording session data
  }

  key(guildId, channelId) { return `${guildId}:${channelId}`; }
  isActive(guildId, channelId) { return this.active.has(this.key(guildId, channelId)); }

  start({ guildId, channelId, channelName, connection, guild, attendees }) {
    const k = this.key(guildId, channelId);
    if (this.active.has(k)) return this.active.get(k).meetingId;

    const startedAt = this.now();
    const meetingId = this.db.createMeeting({ guildId, channelId, channelName, startedAt });
    for (const a of attendees || []) this.db.addAttendee(meetingId, a.id, a.displayName);

    const audioDir = `${this.audioRoot}/${meetingId}`;
    let registry, stopAll;
    try {
      ({ registry, stopAll } = this.startCapture({ meetingId, connection, guild, audioDir }));
    } catch (err) {
      // Capture wiring failed (e.g. mkdir/permission error): don't leave a
      // phantom 'recording' row that the orphan sweep later has to clean up.
      this.db.setMeetingStatus(meetingId, 'transcription_failed');
      throw err;
    }
    this.active.set(k, { meetingId, guildId, channelId, channelName, startedAt, connection, guild, registry, stopAll, audioDir });
    return meetingId;
  }

  /**
   * Stop capture and return fast. Transcription + summarization (finalize) can
   * take minutes, so it runs in the background: the meeting moves to
   * `this.processing` so the live view can show a "Processing" card, and
   * `ended_at` is stamped NOW so durations reflect recording time, not
   * recording + pipeline time.
   * Returns { meetingId, done } — callers that genuinely need to wait for the
   * pipeline (tests, CLI scripts) can await `done`; the API and bot handlers
   * must not, so Stop resolves in ~1s.
   */
  async stop(guildId, channelId) {
    const k = this.key(guildId, channelId);
    const session = this.active.get(k);
    if (!session) return null;
    this.active.delete(k);
    if (session.stopAll) await session.stopAll();  // flush in-flight speaking turns first
    const tracks = session.registry.list();

    const stoppedAt = this.now();
    this.db.setMeetingStatus(session.meetingId, 'processing', stoppedAt);
    this.processing.set(session.meetingId, {
      meetingId: session.meetingId,
      guildId: session.guildId,
      channelId: session.channelId,
      channelName: session.channelName,
      startedAt: session.startedAt,
      stoppedAt,
    });

    // Kick finalize WITHOUT awaiting. It settles (success or failure) → the
    // meeting leaves the processing map, so a failed pipeline can't strand a
    // phantom "Processing" card. finalize owns its own error handling/reporting;
    // if a throw escapes it (an unexpected crash outside its try/catch), fail
    // loud: log prominently AND unstuck the row so the dashboard doesn't show
    // "Processing" until the next boot reconcile (which only runs at process
    // start, so without this a stuck row hangs between restarts).
    const done = Promise.resolve()
      .then(() => this.finalize(session.meetingId, tracks, session))
      .catch((err) => {
        console.error(`[pipeline] meeting ${session.meetingId} finalize threw (unhandled): ${err?.stack || err}`);
        try {
          const m = this.db.getMeeting(session.meetingId);
          if (m && m.status === 'processing') this.db.setMeetingStatus(session.meetingId, 'transcription_failed');
        } catch { /* leave it */ }
        throw err;
      })
      .finally(() => this.processing.delete(session.meetingId));
    done.catch(() => {}); // callers may not await `done` — never leave an unhandled rejection

    return { meetingId: session.meetingId, done };
  }

  // In-progress recordings, as plain data for the web dashboard's live view.
  // No Discord/voice handles leak out — just what the UI needs to render.
  listActive() {
    return [...this.active.values()].map((s) => ({
      meetingId: s.meetingId,
      guildId: s.guildId,
      channelId: s.channelId,
      channelName: s.channelName,
      startedAt: s.startedAt,
    }));
  }

  // Meetings whose recording stopped but whose pipeline (transcribe/summarize/
  // post) is still running. Same plain-data shape as listActive, plus stoppedAt.
  listProcessing() {
    return [...this.processing.values()].map((s) => ({
      meetingId: s.meetingId,
      guildId: s.guildId,
      channelId: s.channelId,
      channelName: s.channelName,
      startedAt: s.startedAt,
      stoppedAt: s.stoppedAt,
    }));
  }
}
