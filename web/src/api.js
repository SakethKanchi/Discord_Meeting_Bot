// Optional hook the app installs so a 401 anywhere (an expired/cleared session)
// can drop the UI back to the login screen instead of surfacing a raw
// "Not authenticated" error string on whatever page the user was on.
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

const json = async (r) => {
  // Surface auth failures distinctly so the app can redirect to /login.
  if (r.status === 401) {
    if (onUnauthorized) { try { onUnauthorized(); } catch { /* ignore */ } }
    const err = new Error('Not authenticated');
    err.status = 401;
    return Promise.reject(err);
  }
  if (!r.ok) {
    // Try to read a JSON {error}, but fall back cleanly when the body is HTML
    // (e.g. an older server's 404 page) so callers never see a raw
    // "JSON.parse: unexpected character" error.
    let message = r.statusText || `Request failed (${r.status})`;
    try { const body = await r.json(); if (body?.error) message = body.error; } catch { /* non-JSON body */ }
    const err = new Error(message);
    err.status = r.status;
    return Promise.reject(err);
  }
  return r.json();
};

const jsonBody = (method, body) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  guilds: () => fetch('/api/guilds').then(json),
  meetings: (g) => fetch(`/api/guilds/${g}/meetings`).then(json),
  live: (g) => fetch(`/api/guilds/${g}/live`).then(json),
  stopLive: (g, channelId) => fetch(`/api/guilds/${g}/live/${channelId}/stop`, { method: 'POST' }).then(json),
  stats: (g) => fetch(`/api/guilds/${g}/stats`).then(json),
  meeting: (id) => fetch(`/api/meetings/${id}`).then(json),
  // Export URL for a download link/button (md or json). Not fetched via json().
  exportMeetingUrl: (id, format = 'md') => `/api/meetings/${id}/export?format=${format}`,
  todos: (g, { open, assignee } = {}) => {
    const p = new URLSearchParams();
    if (open) p.set('open', '1');
    if (assignee !== undefined) p.set('assignee', assignee === null ? '__unassigned__' : assignee);
    const qs = p.toString();
    return fetch(`/api/guilds/${g}/todos${qs ? `?${qs}` : ''}`).then(json);
  },
  assignees: (g) => fetch(`/api/guilds/${g}/assignees`).then(json),
  ask: (g, id, question) => fetch(`/api/guilds/${g}/meetings/${id}/ask`, jsonBody('POST', { question })).then(json),
  setTodoDone: (id, done) => fetch(`/api/todos/${id}`, jsonBody('PATCH', { done })).then(json),
  deleteMeeting: (id) => fetch(`/api/meetings/${id}`, { method: 'DELETE' }).then(json),
  mergeMeetings: (id, sourceIds) => fetch(`/api/meetings/${id}/merge`, jsonBody('POST', { sourceIds })).then(json),
  search: (g, q) => fetch(`/api/guilds/${g}/search?q=${encodeURIComponent(q)}`).then(json),
  retryMeeting: (id) => fetch(`/api/meetings/${id}/retry`, { method: 'POST' }).then(json),
  commands: () => fetch('/api/commands').then(json),
  config: (g) => fetch(`/api/guilds/${g}/config`).then(json),
  saveConfig: (g, patch) => fetch(`/api/guilds/${g}/config`, jsonBody('PATCH', patch)).then(json),
  providerModels: (provider, refresh = false) => fetch(`/api/providers/${provider}/models${refresh ? '?refresh=1' : ''}`).then(json),
  setProviderKey: (provider, key) => fetch(`/api/providers/${provider}/key`, jsonBody('PUT', { key })).then(json),
  systemStatus: () => fetch('/api/system/status').then(json),
  setConnection: (patch) => fetch('/api/system/connection', jsonBody('PUT', patch)).then(json),
  botAction: (action) => fetch(`/api/system/bot/${action}`, { method: 'POST' }).then(json),
  sidecarAction: (action) => fetch(`/api/system/sidecar/${action}`, { method: 'POST' }).then(json),

  // ── Auth ──────────────────────────────────────────────────────────────────
  me: () => fetch('/api/auth/me').then(json),
  login: (username, password) => fetch('/api/auth/login', jsonBody('POST', { username, password })).then(json),
  logout: () => fetch('/api/auth/logout', { method: 'POST' }).then(json),
  changePassword: (currentPassword, newPassword) =>
    fetch('/api/auth/password', jsonBody('POST', { currentPassword, newPassword })).then(json),
  users: () => fetch('/api/users').then(json),
  createUser: (payload) => fetch('/api/users', jsonBody('POST', payload)).then(json),
  updateUser: (id, patch) => fetch(`/api/users/${id}`, jsonBody('PATCH', patch)).then(json),
  resetUserPassword: (id, password) => fetch(`/api/users/${id}/password`, jsonBody('POST', { password })).then(json),
  deleteUser: (id) => fetch(`/api/users/${id}`, { method: 'DELETE' }).then(json),
};
