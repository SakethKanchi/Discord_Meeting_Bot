// src/web/server.js
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { apiRouter } from './api.js';
import { installUsers } from '../store/users.js';
import { authRouter, attachUser, requireAuth, requirePasswordChanged, sameOrigin } from './auth.js';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');

export function createWebServer({ db, bot = null, client = null, sidecar = null }) {
  const app = express();
  // Trust only the loopback proxy so req.secure / req.ip reflect a *local*
  // reverse proxy's X-Forwarded-* headers. Trusting every hop (`true`) let any
  // direct client spoof X-Forwarded-For and dodge the per-IP login rate limit.
  // Override with TRUSTED_PROXY when a non-loopback proxy fronts the app.
  app.set('trust proxy', process.env.TRUSTED_PROXY || 'loopback');
  app.use(express.json());

  // Auth: seed users (default admin on first run) and resolve the session
  // cookie for every request. Login/logout/me/password are public (or self-only)
  // and mounted first; everything else under /api needs a session, a same-origin
  // request (CSRF guard), and an account that has moved off the default password.
  const users = installUsers(db);
  app.use(attachUser(users));
  app.use('/api', sameOrigin);
  app.use('/api', authRouter({ users }));
  app.use('/api', requireAuth(users), requirePasswordChanged(users), apiRouter({ db, bot, client, sidecar }));

  if (existsSync(DIST)) {
    app.use(express.static(DIST));
    // SPA fallback for client-side routes (but never /api)
    app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(join(DIST, 'index.html')));
  }
  return app;
}

const FALLBACK_ATTEMPTS = 10;

export function startWebServer({ db, bot = null, client = null, sidecar = null, port = 3000, host = process.env.WEB_UI_HOST || '127.0.0.1', maxAttempts = FALLBACK_ATTEMPTS }) {
  db.backfillTodos();
  const app = createWebServer({ db, bot, client, sidecar });
  return listenWithFallback(app, port, host, maxAttempts);
}

// Bind preferred port; on EADDRINUSE walk +1 up to maxAttempts. Port 0
// (OS-assigned) is a single shot — incrementing it would try privileged ports.
function listenWithFallback(app, port, host, maxAttempts) {
  return new Promise((resolve, reject) => {
    const tryListen = (candidate, remaining) => {
      const server = app.listen(candidate, host);
      server.once('listening', () => resolve(server));
      server.once('error', (err) => {
        server.close();
        if (err.code === 'EADDRINUSE' && candidate !== 0 && remaining > 1) {
          console.warn(`[web] port ${candidate} in use, trying ${candidate + 1}`);
          tryListen(candidate + 1, remaining - 1);
        } else {
          reject(err);
        }
      });
    };
    tryListen(port, maxAttempts);
  });
}
