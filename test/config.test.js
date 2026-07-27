import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db.js';
import { getGuildConfig, setGuildConfig, DEFAULTS } from '../src/store/config.js';

test('getGuildConfig returns defaults for unknown guild', () => {
  const db = openDb(':memory:');
  assert.deepEqual(getGuildConfig(db, 'g'), { guildId: 'g', ...DEFAULTS });
});

test('setGuildConfig merges and persists partial updates', () => {
  const db = openDb(':memory:');
  setGuildConfig(db, 'g', { summarizerProvider: 'ollama', whisperModel: 'medium' });
  const c = getGuildConfig(db, 'g');
  assert.equal(c.summarizerProvider, 'ollama');
  assert.equal(c.whisperModel, 'medium');
  assert.equal(c.autoJoin, DEFAULTS.autoJoin); // untouched default
});

test('setGuildConfig second update keeps prior values', () => {
  const db = openDb(':memory:');
  setGuildConfig(db, 'g', { summarizerProvider: 'ollama' });
  setGuildConfig(db, 'g', { language: 'es' });
  const c = getGuildConfig(db, 'g');
  assert.equal(c.summarizerProvider, 'ollama');
  assert.equal(c.language, 'es');
});

test('setGuildConfig round-trips boolean false', () => {
  const db = openDb(':memory:');
  setGuildConfig(db, 'g', { useThread: false, autoJoin: false });
  const c = getGuildConfig(db, 'g');
  assert.equal(c.useThread, false);
  assert.equal(c.autoJoin, false);
});

test('setGuildConfig ignores undefined patch values and pins guildId', () => {
  const db = openDb(':memory:');
  assert.doesNotThrow(() => setGuildConfig(db, 'g', { summarizerModel: undefined, language: 'es', guildId: 'evil' }));
  const c = getGuildConfig(db, 'g');
  assert.equal(c.language, 'es');
  assert.equal(c.guildId, 'g');               // not 'evil'
  assert.equal(c.summarizerModel, DEFAULTS.summarizerModel); // undefined patch ignored
});

test('setGuildConfig can reset notesChannelId back to null', () => {
  const db = openDb(':memory:');
  setGuildConfig(db, 'g', { notesChannelId: '123' });
  setGuildConfig(db, 'g', { notesChannelId: null });
  assert.equal(getGuildConfig(db, 'g').notesChannelId, null);
});

test('summaryLanguage defaults to en', () => {
  const db = openDb(':memory:');
  assert.equal(getGuildConfig(db, 'g').summaryLanguage, 'en');
});

test('setGuildConfig persists summaryLanguage', () => {
  const db = openDb(':memory:');
  setGuildConfig(db, 'g', { summaryLanguage: 'de' });
  assert.equal(getGuildConfig(db, 'g').summaryLanguage, 'de');
});

test('sttProvider defaults to sidecar', () => {
  const db = openDb(':memory:');
  assert.equal(getGuildConfig(db, 'g').sttProvider, 'sidecar');
  assert.equal(getGuildConfig(db, 'g').sttModel, null);
});

test('setGuildConfig persists sttProvider + sttModel', () => {
  const db = openDb(':memory:');
  setGuildConfig(db, 'g', { sttProvider: 'openai', sttModel: 'whisper-1' });
  const c = getGuildConfig(db, 'g');
  assert.equal(c.sttProvider, 'openai');
  assert.equal(c.sttModel, 'whisper-1');
  assert.equal(c.whisperModel, DEFAULTS.whisperModel); // sidecar model untouched
});

test('autoJoinChannelIds defaults to [] and round-trips a list', () => {
  const db = openDb(':memory:');
  assert.deepEqual(getGuildConfig(db, 'g').autoJoinChannelIds, []);
  setGuildConfig(db, 'g', { autoJoinChannelIds: ['111', '222'] });
  assert.deepEqual(getGuildConfig(db, 'g').autoJoinChannelIds, ['111', '222']);
  // Clearing back to "any channel".
  setGuildConfig(db, 'g', { autoJoinChannelIds: [] });
  assert.deepEqual(getGuildConfig(db, 'g').autoJoinChannelIds, []);
});

test('autoJoinChannelIds survives unrelated updates', () => {
  const db = openDb(':memory:');
  setGuildConfig(db, 'g', { autoJoinChannelIds: ['111'] });
  setGuildConfig(db, 'g', { language: 'de' });
  assert.deepEqual(getGuildConfig(db, 'g').autoJoinChannelIds, ['111']);
});

test('malformed auto_join_channel_ids JSON falls back to []', () => {
  const db = openDb(':memory:');
  setGuildConfig(db, 'g', { autoJoin: true });
  db.sql.prepare(`UPDATE guild_config SET auto_join_channel_ids = 'not json' WHERE guild_id = 'g'`).run();
  assert.deepEqual(getGuildConfig(db, 'g').autoJoinChannelIds, []);
});

test('keepAudio defaults to false and round-trips both values', () => {
  const db = openDb(':memory:');
  assert.equal(getGuildConfig(db, 'g').keepAudio, false);
  setGuildConfig(db, 'g', { keepAudio: true });
  assert.equal(getGuildConfig(db, 'g').keepAudio, true);
  setGuildConfig(db, 'g', { keepAudio: false });
  assert.equal(getGuildConfig(db, 'g').keepAudio, false);
});
