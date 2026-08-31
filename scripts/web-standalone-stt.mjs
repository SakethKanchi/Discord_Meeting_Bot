// Dev-only: standalone web server WITH a sidecar controller wired in, so the
// Settings → Transcription sidecar control is exercisable without the bot.
// Mirrors scripts/web-standalone.mjs. Not shipped behavior; handy for testing.
import { join } from 'node:path';
import { resolveDataDir, config } from '../src/config/env.js';
import { openDb } from '../src/store/db.js';
import { startWebServer } from '../src/web/server.js';
import { SidecarController } from '../src/sidecar-controller.js';

const dataDir = resolveDataDir();
const db = openDb(join(dataDir, 'meetings.db'));
const sidecar = new SidecarController({ sttUrl: config.sttUrl });
const port = Number(process.env.WEB_UI_PORT) || 3000;
const server = await startWebServer({ db, bot: null, sidecar, port, host: '127.0.0.1' });
const bound = server.address().port;
console.log(`[web:standalone+stt] http://127.0.0.1:${bound} (sidecar managed=${sidecar.managed()})`);
