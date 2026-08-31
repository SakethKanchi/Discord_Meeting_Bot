// Standalone web server: serves the Parley admin API + built UI against the
// existing meetings.db WITHOUT the Discord bot/gateway. Lets us develop and
// test the dashboard against real data with no token.
//
//   node scripts/web-standalone.mjs            # port 3000
//   WEB_UI_PORT=3001 node scripts/web-standalone.mjs
//
// Guild names + channel lists come from Discord at runtime, so without a client
// the guild picker shows raw ids and Setup's channel dropdown is empty — every
// other view (meetings, notes, action items, search, ask) works fully.
import { join } from 'node:path';
import { resolveDataDir } from '../src/config/env.js';
import { openDb } from '../src/store/db.js';
import { startWebServer } from '../src/web/server.js';

const dataDir = resolveDataDir();
const db = openDb(join(dataDir, 'meetings.db'));
const port = Number(process.env.WEB_UI_PORT) || 3000;
const server = await startWebServer({ db, bot: null, client: null, port });
const bound = server.address().port;
console.log(`[web:standalone] API + UI on http://127.0.0.1:${bound} (db: ${join(dataDir, 'meetings.db')})`);
