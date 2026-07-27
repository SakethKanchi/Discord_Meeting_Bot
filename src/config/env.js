import { existsSync } from 'node:fs';
import { join } from 'node:path';
import dotenv from 'dotenv';
const REQUIRED = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID'];
export function resolveDataDir(env = process.env, exists = existsSync, cwd = process.cwd()) {
  if (env.DATA_DIR) return env.DATA_DIR;
  if (exists('/data')) return '/data';
  return cwd;
}
// The single .env the app reads at boot AND writes to from the web UI. Lives in
// DATA_DIR so edits persist across restarts (critical when DATA_DIR is a Docker
// volume; in local dev DATA_DIR is the cwd, so this is just ./.env as before).
export function resolveEnvFile(env = process.env) {
  return env.PARLEY_ENV_FILE || join(resolveDataDir(env), '.env');
}
// Load the cwd .env first (back-compat / `node --env-file`), then overlay the
// persistent DATA_DIR/.env so values saved from the web UI win.
dotenv.config({ override: true });
{
  const dataEnv = resolveEnvFile();
  if (existsSync(dataEnv)) dotenv.config({ path: dataEnv, override: true });
}
export function hasDiscordCreds(env = config) {
  return !!(env.discordToken && env.discordClientId);
}
export function validateEnv(env = process.env) {
  const empty = REQUIRED.filter((k) => !env[k] || env[k].trim() === '');
  if (empty.length) throw new Error(`Missing or empty required env: ${empty.join(', ')}`);
  return true;
}

// How long retained meeting audio (keep_audio guilds) survives before the
// sweep purges it. 0 = keep until the meeting is deleted. Invalid → default 30.
export function resolveAudioRetentionDays(env = process.env) {
  const n = Number(env.AUDIO_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

export const config = {
  dataDir: resolveDataDir(),
  discordToken: process.env.DISCORD_TOKEN,
  discordClientId: process.env.DISCORD_CLIENT_ID,
  sttUrl: process.env.STT_URL || 'http://127.0.0.1:8000',
  audioRetentionDays: resolveAudioRetentionDays(),
  // Public base URL of the dashboard (e.g. https://parley.example.com). Only
  // used to link Discord notes back to the meeting page; unset = no links.
  webPublicUrl: (process.env.WEB_PUBLIC_URL || '').replace(/\/+$/, '') || null,
  gemini: { apiKey: process.env.GEMINI_API_KEY },
  openai: { apiKey: process.env.OPENAI_API_KEY, baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1' },
  opencode: { apiKey: process.env.OPENCODE_API_KEY, baseUrl: process.env.OPENCODE_BASE_URL || 'https://opencode.ai/zen/go/v1' },
  ollama: { url: process.env.OLLAMA_URL || 'http://127.0.0.1:11434' },
};
