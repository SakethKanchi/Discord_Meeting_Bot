import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoJoin, shouldAutoLeave } from '../src/voice/decisions.js';

test('shouldAutoJoin true when >1 human and autoJoin enabled and not connected', () => {
  assert.equal(shouldAutoJoin({ humanCount: 2, autoJoin: true, connected: false }), true);
});

test('shouldAutoJoin false when autoJoin disabled', () => {
  assert.equal(shouldAutoJoin({ humanCount: 5, autoJoin: false, connected: false }), false);
});

test('shouldAutoJoin false when already connected', () => {
  assert.equal(shouldAutoJoin({ humanCount: 5, autoJoin: true, connected: true }), false);
});

test('shouldAutoJoin false when <=1 human', () => {
  assert.equal(shouldAutoJoin({ humanCount: 1, autoJoin: true, connected: false }), false);
});

test('shouldAutoJoin ignores the allow-list when it is empty or absent', () => {
  assert.equal(shouldAutoJoin({ humanCount: 2, autoJoin: true, connected: false, channelId: 'c1', allowedChannelIds: [] }), true);
  assert.equal(shouldAutoJoin({ humanCount: 2, autoJoin: true, connected: false, channelId: 'c1', allowedChannelIds: undefined }), true);
});

test('shouldAutoJoin true only for channels on the allow-list', () => {
  const base = { humanCount: 2, autoJoin: true, connected: false, allowedChannelIds: ['c1', 'c2'] };
  assert.equal(shouldAutoJoin({ ...base, channelId: 'c1' }), true);
  assert.equal(shouldAutoJoin({ ...base, channelId: 'c3' }), false);
});

test('shouldAutoJoin allow-list does not override the other gates', () => {
  const base = { channelId: 'c1', allowedChannelIds: ['c1'] };
  assert.equal(shouldAutoJoin({ ...base, humanCount: 1, autoJoin: true, connected: false }), false);
  assert.equal(shouldAutoJoin({ ...base, humanCount: 2, autoJoin: false, connected: false }), false);
  assert.equal(shouldAutoJoin({ ...base, humanCount: 2, autoJoin: true, connected: true }), false);
});

test('shouldAutoLeave true when connected and <=1 human', () => {
  assert.equal(shouldAutoLeave({ humanCount: 1, connected: true }), true);
  assert.equal(shouldAutoLeave({ humanCount: 2, connected: true }), false);
  assert.equal(shouldAutoLeave({ humanCount: 0, connected: false }), false);
});
