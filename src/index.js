// src/index.js
// Entrypoint. The web dashboard ALWAYS starts (so a fresh self-hoster can open
// it and paste their Discord credentials), and the bot starts as soon as creds
// are available — either from the environment now, or saved later via the UI.
import { join } from 'node:path';
import { config, hasDiscordCreds } from './config/env.js';
import { openDb } from './store/db.js';
import { reconcileOnBoot, sweepAudioDirs } from './store/reconcile.js';
import { BotController } from './bot-controller.js';
import { SidecarController } from './sidecar-controller.js';
import { startWebServer } from './web/server.js';

const db = openDb(join(config.dataDir, 'meetings.db'));
const audioRoot = join(config.dataDir, 'audio');

// Boot housekeeping BEFORE anything starts, so a crash mid-pipeline is recovered
// even in web-only mode (no Discord creds): orphaned meetings become retryable
// and stale audio dirs are swept. Best-effort — never block startup on it.
await reconcileOnBoot(db, audioRoot, { retentionDays: config.audioRetentionDays })
  .catch((e) => console.warn('[reconcile] skipped:', e.message));

// Retained recordings expire on a clock, and a long-running deployment may
// never reboot — re-run the sweep daily so the retention window actually bites.
setInterval(() => {
  sweepAudioDirs(db, audioRoot, { retentionDays: config.audioRetentionDays })
    .catch((e) => console.warn('[reconcile] daily sweep failed:', e.message));
}, 24 * 60 * 60 * 1000).unref();

const bot = new BotController({ db, audioRoot });
// Local STT sidecar lifecycle (start/stop from the dashboard). No-op/unmanaged
// in Docker where the sidecar is its own container.
const sidecar = new SidecarController({ sttUrl: config.sttUrl });

// The web UI is on by default in a hosted/container deploy. Set WEB_UI=0 to run
// headless (CLI-only). It binds 127.0.0.1 unless WEB_UI_HOST overrides it.
const webEnabled = process.env.WEB_UI !== '0' && process.env.WEB_UI !== 'false';
if (webEnabled) {
  const port = Number(process.env.WEB_UI_PORT) || 3000;
  const host = process.env.WEB_UI_HOST || '127.0.0.1';
  startWebServer({ db, bot, sidecar, port, host });
  console.log(`[web] dashboard on http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
  // Loud warning if we're reachable off-box while an account still uses the
  // seeded default password — that combination is a full-takeover risk.
  if (host !== '127.0.0.1' && host !== 'localhost' && defaultPasswordActive(db)) {
    console.warn(
      `[web] ⚠ SECURITY: the dashboard is bound to ${host} (not localhost) and an account still uses the\n` +
      `      default password. Change it immediately, and only expose the dashboard behind a TLS proxy.`
    );
  }
}

// True when any admin still carries the seeded default password (must change).
function defaultPasswordActive(database) {
  try {
    return database.sql.prepare(
      `SELECT COUNT(*) AS c FROM users WHERE is_admin = 1 AND must_change_password = 1`
    ).get().c > 0;
  } catch { return false; }
}

// Auto-start the local sidecar when it's the active transcription backend, so a
// fresh self-hoster gets working transcription without a second terminal. Only
// when we can manage it locally (skipped in Docker / when STT points elsewhere).
if (sidecar.managed() && anyGuildUsesSidecar(db)) {
  sidecar.start().then((r) => {
    if (r.ok) console.log(`[stt] local sidecar ${r.external ? 'detected' : 'started'} at ${config.sttUrl}`);
    else console.log(`[stt] sidecar not started: ${r.error}`);
  });
}

function anyGuildUsesSidecar(database) {
  // Default provider is 'sidecar', so a guild with no row (or an explicit
  // sidecar row) counts. Treat "no configured guilds yet" as sidecar too.
  try {
    const rows = database.sql.prepare(`SELECT stt_provider FROM guild_config`).all();
    if (rows.length === 0) return true;
    return rows.some((r) => (r.stt_provider ?? 'sidecar') === 'sidecar');
  } catch { return true; }
}

if (hasDiscordCreds()) {
  const r = await bot.start();
  if (!r.ok) console.error('[bot] failed to start:', r.error);
} else if (webEnabled) {
  console.log('[bot] no Discord credentials yet — open the dashboard to connect your bot.');
} else {
  // Headless with no creds is a misconfiguration; fail loudly like before.
  console.error('[bot] Missing DISCORD_TOKEN / DISCORD_CLIENT_ID and the web UI is disabled. Nothing to do.');
  process.exit(1);
}
