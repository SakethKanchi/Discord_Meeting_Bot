// test/secrets.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertEnvLine, setProviderKey, secretStatus, isSecretProvider, connectionStatus, setConnection } from '../src/store/secrets.js';

test('upsertEnvLine replaces an existing key in place', () => {
  const text = 'A=1\nGEMINI_API_KEY=old\nB=2\n';
  const out = upsertEnvLine(text, 'GEMINI_API_KEY', 'new');
  assert.equal(out, 'A=1\nGEMINI_API_KEY=new\nB=2\n');
});

test('upsertEnvLine replaces an empty/commented-style key', () => {
  const text = 'GEMINI_API_KEY=\nB=2\n';
  assert.equal(upsertEnvLine(text, 'GEMINI_API_KEY', 'abc'), 'GEMINI_API_KEY=abc\nB=2\n');
});

test('upsertEnvLine appends a missing key with a trailing newline', () => {
  assert.equal(upsertEnvLine('A=1', 'OPENAI_API_KEY', 'sk'), 'A=1\nOPENAI_API_KEY=sk\n');
  assert.equal(upsertEnvLine('', 'OPENAI_API_KEY', 'sk'), 'OPENAI_API_KEY=sk\n');
});

test('isSecretProvider only true for keyed providers', () => {
  assert.equal(isSecretProvider('gemini'), true);
  assert.equal(isSecretProvider('openai'), true);
  assert.equal(isSecretProvider('opencode'), true);
  assert.equal(isSecretProvider('openrouter'), true);
  assert.equal(isSecretProvider('ollama'), false);
  assert.equal(isSecretProvider('fake'), false);
});

test('setProviderKey updates live config + persists to .env, and clears it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-secrets-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'DISCORD_TOKEN=x\nGEMINI_API_KEY=\n');
  // Fake in-memory config mirroring src/config/env.js shape.
  const env = { gemini: { apiKey: undefined }, openai: {}, opencode: {}, openrouter: {} };

  let status = await setProviderKey('gemini', '  my-key  ', { env, envPath });
  assert.equal(env.gemini.apiKey, 'my-key'); // trimmed + applied live
  assert.equal(status.gemini, true);
  assert.match(readFileSync(envPath, 'utf8'), /GEMINI_API_KEY=my-key/);

  status = await setProviderKey('gemini', '', { env, envPath });
  assert.equal(env.gemini.apiKey, undefined); // cleared live
  assert.equal(status.gemini, false);
  assert.match(readFileSync(envPath, 'utf8'), /GEMINI_API_KEY=\n/);

  rmSync(dir, { recursive: true, force: true });
});

test('setProviderKey rejects a non-keyed provider', async () => {
  await assert.rejects(() => setProviderKey('ollama', 'x', { env: {}, envPath: '/tmp/none' }),
    /no editable API key/);
});

test('connectionStatus reports presence for the token and values for the rest', () => {
  const env = { discordToken: 'abc', discordClientId: '123', sttUrl: 'http://x:8000' };
  const s = connectionStatus(env);
  assert.equal(s.discordToken.set, true);
  assert.equal('value' in s.discordToken, false); // never leaks the token value
  assert.equal(s.discordClientId.value, '123');
  assert.equal(s.sttUrl.value, 'http://x:8000');
});

test('setConnection applies live + persists, ignoring unknown keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-conn-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'DISCORD_TOKEN=\nDISCORD_CLIENT_ID=\n');
  const env = { discordToken: undefined, discordClientId: undefined, sttUrl: undefined };

  const status = await setConnection(
    { discordToken: '  tok  ', discordClientId: '999', sttUrl: 'http://sidecar:8000', bogus: 'nope' },
    { env, envPath },
  );
  assert.equal(env.discordToken, 'tok');          // trimmed + live
  assert.equal(env.discordClientId, '999');
  assert.equal(env.sttUrl, 'http://sidecar:8000');
  assert.equal(status.discordClientId.value, '999');
  const text = readFileSync(envPath, 'utf8');
  assert.match(text, /DISCORD_TOKEN=tok/);
  assert.match(text, /DISCORD_CLIENT_ID=999/);
  assert.match(text, /STT_URL=http:\/\/sidecar:8000/);
  assert.doesNotMatch(text, /bogus/);

  rmSync(dir, { recursive: true, force: true });
});

test('setConnection clearing the STT url falls back to the default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-conn2-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, '');
  const env = { sttUrl: 'http://old:8000' };
  await setConnection({ sttUrl: '' }, { env, envPath });
  assert.equal(env.sttUrl, 'http://127.0.0.1:8000');
  rmSync(dir, { recursive: true, force: true });
});

// ── Injection / SSRF hardening ────────────────────────────────────────────────

test('setProviderKey rejects a value with embedded newlines (.env injection)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-inject-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'OPENAI_API_KEY=\n');
  const env = { gemini: {}, openai: { apiKey: 'safe' }, opencode: {}, openrouter: {} };
  await assert.rejects(
    () => setProviderKey('openai', 'x\nOPENAI_BASE_URL=https://evil.example/v1', { env, envPath }),
    /control characters/,
  );
  // Neither the live config nor the file was mutated by the rejected write.
  assert.equal(env.openai.apiKey, 'safe');
  assert.doesNotMatch(readFileSync(envPath, 'utf8'), /evil\.example/);
  rmSync(dir, { recursive: true, force: true });
});

test('setConnection rejects an STT url pointing at cloud metadata (SSRF)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-ssrf-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, '');
  const env = { sttUrl: 'http://127.0.0.1:8000' };
  await assert.rejects(
    () => setConnection({ sttUrl: 'http://169.254.169.254/latest/meta-data' }, { env, envPath }),
    /blocked address/,
  );
  assert.equal(env.sttUrl, 'http://127.0.0.1:8000'); // unchanged
  rmSync(dir, { recursive: true, force: true });
});

test('setConnection rejects a non-http STT url', async () => {
  const env = { sttUrl: 'http://127.0.0.1:8000' };
  await assert.rejects(
    () => setConnection({ sttUrl: 'file:///etc/passwd' }, { env, envPath: '/tmp/none-xyz' }),
    /http or https/,
  );
});

test('setConnection allows a normal LAN sidecar url', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-lan-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, '');
  const env = { sttUrl: undefined };
  await setConnection({ sttUrl: 'http://192.168.1.50:8000' }, { env, envPath });
  assert.equal(env.sttUrl, 'http://192.168.1.50:8000'); // private ranges are fine
  rmSync(dir, { recursive: true, force: true });
});

test('upsertEnvLine escapes regex metacharacters in the key', () => {
  // A key with regex-special chars must match literally, not as a pattern.
  const text = 'A.B=old\nC=2\n';
  assert.equal(upsertEnvLine(text, 'A.B', 'new'), 'A.B=new\nC=2\n');
});
