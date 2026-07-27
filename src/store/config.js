export const DEFAULTS = {
  summarizerProvider: 'gemini',
  summarizerModel: 'gemini-2.5-flash',
  sttProvider: 'sidecar',
  sttModel: null,
  whisperModel: 'small',
  notesChannelId: null,
  useThread: true,
  autoJoin: true,
  autoJoinChannelIds: [],
  keepAudio: false,
  language: 'auto',
  summaryLanguage: 'en',
};

const COLS = {
  summarizerProvider: 'summarizer_provider',
  summarizerModel: 'summarizer_model',
  sttProvider: 'stt_provider',
  sttModel: 'stt_model',
  whisperModel: 'whisper_model',
  notesChannelId: 'notes_channel_id',
  useThread: 'use_thread',
  autoJoin: 'auto_join',
  autoJoinChannelIds: 'auto_join_channel_ids',
  keepAudio: 'keep_audio',
  language: 'language',
  summaryLanguage: 'summary_language',
};

// auto_join_channel_ids is a JSON-encoded array of channel id strings; anything
// unparsable falls back to [] (= no restriction, join any channel).
function parseIdList(raw) {
  if (raw == null) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}

function fromRow(row) {
  return {
    summarizerProvider: row.summarizer_provider ?? DEFAULTS.summarizerProvider,
    summarizerModel: row.summarizer_model ?? DEFAULTS.summarizerModel,
    sttProvider: row.stt_provider ?? DEFAULTS.sttProvider,
    sttModel: row.stt_model ?? DEFAULTS.sttModel,
    whisperModel: row.whisper_model ?? DEFAULTS.whisperModel,
    notesChannelId: row.notes_channel_id ?? DEFAULTS.notesChannelId,
    useThread: row.use_thread == null ? DEFAULTS.useThread : !!row.use_thread,
    autoJoin: row.auto_join == null ? DEFAULTS.autoJoin : !!row.auto_join,
    autoJoinChannelIds: parseIdList(row.auto_join_channel_ids),
    keepAudio: row.keep_audio == null ? DEFAULTS.keepAudio : !!row.keep_audio,
    language: row.language ?? DEFAULTS.language,
    summaryLanguage: row.summary_language ?? DEFAULTS.summaryLanguage,
  };
}

export function getGuildConfig(db, guildId) {
  const row = db.sql.prepare(`SELECT * FROM guild_config WHERE guild_id = ?`).get(guildId);
  return { guildId, ...(row ? fromRow(row) : DEFAULTS) };
}

export function setGuildConfig(db, guildId, patch) {
  const current = getGuildConfig(db, guildId);
  // Drop undefined keys (node:sqlite cannot bind undefined) and pin guildId so a
  // stray patch key can't corrupt the row identity or the returned object.
  const safePatch = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const merged = { ...current, ...safePatch, guildId };
  db.sql.prepare(
    `INSERT OR REPLACE INTO guild_config
       (guild_id, summarizer_provider, summarizer_model, stt_provider, stt_model, whisper_model, notes_channel_id, use_thread, auto_join, auto_join_channel_ids, keep_audio, language, summary_language)
     VALUES (@guildId, @summarizerProvider, @summarizerModel, @sttProvider, @sttModel, @whisperModel, @notesChannelId, @useThread, @autoJoin, @autoJoinChannelIds, @keepAudio, @language, @summaryLanguage)`
  ).run({
    guildId,
    summarizerProvider: merged.summarizerProvider,
    summarizerModel: merged.summarizerModel,
    sttProvider: merged.sttProvider,
    sttModel: merged.sttModel,
    whisperModel: merged.whisperModel,
    notesChannelId: merged.notesChannelId,
    useThread: merged.useThread ? 1 : 0,
    autoJoin: merged.autoJoin ? 1 : 0,
    autoJoinChannelIds: JSON.stringify(merged.autoJoinChannelIds || []),
    keepAudio: merged.keepAudio ? 1 : 0,
    language: merged.language,
    summaryLanguage: merged.summaryLanguage,
  });
  return merged;
}

export const CONFIG_COLS = COLS;
