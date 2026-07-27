import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDataDir, resolveAudioRetentionDays, validateEnv } from '../src/config/env.js';

test('resolveDataDir prefers explicit DATA_DIR', () => {
  assert.equal(resolveDataDir({ DATA_DIR: '/tmp/x' }, () => false), '/tmp/x');
});

test('resolveDataDir falls back to /data when it exists', () => {
  assert.equal(resolveDataDir({}, (p) => p === '/data'), '/data');
});

test('resolveDataDir falls back to cwd when no /data', () => {
  assert.equal(resolveDataDir({}, () => false, '/work'), '/work');
});

test('validateEnv throws when required key missing', () => {
  assert.throws(() => validateEnv({ DISCORD_CLIENT_ID: 'x' }), /DISCORD_TOKEN/);
});

test('validateEnv passes with required keys', () => {
  assert.doesNotThrow(() => validateEnv({ DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: 'c' }));
});

test('resolveAudioRetentionDays defaults to 30 when unset, empty, or invalid', () => {
  assert.equal(resolveAudioRetentionDays({}), 30);
  assert.equal(resolveAudioRetentionDays({ AUDIO_RETENTION_DAYS: '' }), 30);   // empty ≠ 0/forever
  assert.equal(resolveAudioRetentionDays({ AUDIO_RETENTION_DAYS: ' ' }), 30);
  assert.equal(resolveAudioRetentionDays({ AUDIO_RETENTION_DAYS: 'soon' }), 30);
  assert.equal(resolveAudioRetentionDays({ AUDIO_RETENTION_DAYS: '-5' }), 30);
});

test('resolveAudioRetentionDays honors explicit values including 0 (keep forever)', () => {
  assert.equal(resolveAudioRetentionDays({ AUDIO_RETENTION_DAYS: '0' }), 0);
  assert.equal(resolveAudioRetentionDays({ AUDIO_RETENTION_DAYS: '90' }), 90);
});
