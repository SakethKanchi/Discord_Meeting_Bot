import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useGuild } from '../GuildContext.jsx';
import { useSystem } from '../SystemContext.jsx';
import { Page, PageHead } from '../components/Page.jsx';
import { Icon, Empty } from '../components/ui.jsx';
import { ModelPicker } from '../components/ModelPicker.jsx';
import { ConnectionForm, BotStatusBadge } from '../components/Connection.jsx';

const WHISPER = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'];
const LANGS = [['auto', 'Auto-detect'], ['en', 'English'], ['de', 'German'], ['es', 'Spanish'], ['fr', 'French'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['ru', 'Russian'], ['ja', 'Japanese'], ['zh', 'Chinese']];
const SUMMARY_LANGS = [['match', 'Match transcription'], ...LANGS.filter(([c]) => c !== 'auto')];

// Model defaults come from the server (adapters/summarizer/models.js) so the
// dashboard, /setup and the adapters can't drift apart.
// Providers whose key is editable from the UI (Ollama is keyless/local).
const KEYED = {
  gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', opencode: 'OPENCODE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};
const KEY_HELP = {
  gemini: 'aistudio.google.com/apikey',
  openai: 'platform.openai.com/api-keys',
  opencode: 'opencode.ai/zen',
  openrouter: 'openrouter.ai/keys',
};
// Which env secret each STT provider needs (sidecar is keyless/local).
const STT_KEY = { openai: 'openai' };
const STT_HELP = {
  sidecar: 'Runs the local faster-whisper container. Free and fully offline, but uses your CPU.',
  openai: 'OpenAI (or any OpenAI-compatible) transcription endpoint.',
};
// The provider's model catalog, fetched live (and re-fetchable with refresh,
// which bypasses the server's cache). `seq` drops responses that land after the
// provider already changed.
function useCatalog(provider) {
  const [state, setState] = useState({ catalog: null, loading: !!provider });
  const seq = useRef(0);
  const load = useCallback((refresh) => {
    const mine = ++seq.current;
    if (!provider) { setState({ catalog: null, loading: false }); return; }
    setState((s) => ({ ...s, loading: true }));
    api.providerModels(provider, refresh)
      .then((catalog) => { if (seq.current === mine) setState({ catalog, loading: false }); })
      .catch(() => { if (seq.current === mine) setState({ catalog: null, loading: false }); });
  }, [provider]);
  useEffect(() => { load(false); }, [load]);
  return { catalog: state.catalog, loading: state.loading, reload: () => load(true) };
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-[13px] font-medium text-ink mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted mt-1.5">{hint}</p>}
    </div>
  );
}

function Card({ title, desc, children }) {
  return (
    <section className="card p-5">
      <div className="mb-4">
        <h2 className="text-sm font-bold text-ink">{title}</h2>
        {desc && <p className="text-xs text-muted mt-0.5">{desc}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Switch({ checked, onChange, label, desc }) {
  return (
    <label className="flex items-start justify-between gap-4 cursor-pointer select-none">
      <span>
        <span className="block text-[13px] font-medium text-ink">{label}</span>
        {desc && <span className="block text-xs text-muted mt-0.5">{desc}</span>}
      </span>
      <span className="relative shrink-0 mt-0.5">
        <input type="checkbox" checked={checked} onChange={onChange} className="peer sr-only" />
        <span className="block h-6 w-10 rounded-full bg-surface-3 peer-checked:bg-primary transition-colors" />
        <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
      </span>
    </label>
  );
}

function Chevron() {
  return <Icon.Chevron width={14} height={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rotate-90 text-muted" />;
}

/* ── API key editor ───────────────────────────────────────────────────────
   Shows a "set / not set" badge; lets the user paste a new key (saved to .env,
   applied live) or clear it. The value is never read back from the server. */
function KeyEditor({ provider, present, onChanged, autoEdit = false }) {
  const envVar = KEYED[provider];
  const [editing, setEditing] = useState(autoEdit && !present);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [err, setErr] = useState(null);

  async function save() {
    setBusy(true); setErr(null);
    try { await api.setProviderKey(provider, value.trim()); setValue(''); setEditing(false); onChanged?.(); }
    catch (e) { setErr(e?.message || 'Failed to save key'); }
    finally { setBusy(false); }
  }
  async function clear() {
    if (!window.confirm(`Remove the ${provider} API key from .env?`)) return;
    setBusy(true); setErr(null);
    try { await api.setProviderKey(provider, ''); setValue(''); setEditing(false); onChanged?.(); }
    catch (e) { setErr(e?.message || 'Failed to clear key'); }
    finally { setBusy(false); }
  }

  return (
    <Field label="API key" hint={err ? undefined : <>Stored in <code className="text-ink-2">.env</code> as <code className="text-ink-2">{envVar}</code> · get one at {KEY_HELP[provider]}</>}>
      {!editing ? (
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 text-[13px] font-medium px-2.5 py-1.5 rounded-sm ${present ? 'text-accent bg-accent-soft' : 'text-warn bg-warn-soft'}`}>
            <span style={{ width: 6, height: 6, borderRadius: 6, background: 'currentColor' }} />
            {present ? 'Key set' : 'No key'}
          </span>
          <button onClick={() => setEditing(true)} className="btn btn-ghost !py-1.5">{present ? 'Replace' : 'Add key'}</button>
          {present && <button onClick={clear} disabled={busy} className="btn btn-ghost !py-1.5 !text-error">Remove</button>}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type={reveal ? 'text' : 'password'} value={value} autoFocus
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setEditing(false); setValue(''); } }}
              placeholder={`Paste ${provider} API key…`} className="input !pr-10" />
            <button type="button" onClick={() => setReveal((r) => !r)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-ink text-xs">{reveal ? 'Hide' : 'Show'}</button>
          </div>
          <button onClick={save} disabled={!value.trim() || busy} className="btn btn-primary !py-2">{busy ? 'Saving…' : 'Save'}</button>
          <button onClick={() => { setEditing(false); setValue(''); }} disabled={busy} className="btn btn-ghost !py-2">Cancel</button>
        </div>
      )}
      {err && <p className="text-xs text-error mt-1.5">{err}</p>}
    </Field>
  );
}

/* ── Local sidecar status + on/off control ─────────────────────────────────
   The sidecar is the local faster-whisper process. It's a single global backend
   (not per-guild), so this lives off `sys.sidecar` from /system/status. Shows a
   live state pill and a Start/Stop button; hidden entirely when the sidecar is
   unmanaged here (e.g. running as its own Docker container). */
function SidecarControl({ sys, onChanged }) {
  const sc = sys?.sidecar;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (!sc) return null; // standalone web server with no controller attached

  const map = {
    running: { label: 'Running', color: 'var(--accent)', bg: 'var(--accent-soft)' },
    starting: { label: 'Starting…', color: 'var(--warn)', bg: 'var(--warn-soft)' },
    error: { label: 'Stopped', color: 'var(--error)', bg: 'var(--error-soft)' },
    stopped: { label: 'Stopped', color: 'var(--muted)', bg: 'var(--surface-3)' },
  };
  const s = map[sc.state] || map.stopped;
  const running = sc.state === 'running';

  async function act(action) {
    setBusy(true); setErr(null);
    try { await api.sidecarAction(action); await onChanged?.(); }
    catch (e) { setErr(e?.message || `Failed to ${action} sidecar`); }
    finally { setBusy(false); }
  }

  if (!sc.managed) {
    return (
      <div className="rounded-md bg-surface-2 px-3.5 py-3 text-xs text-muted">
        The local whisper sidecar is managed outside this process
        {sc.url ? <> (<code className="text-ink-2">{sc.url}</code>)</> : null}. In Docker it runs as its
        own container and starts/stops with <code className="text-ink-2">docker compose</code>.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border px-3.5 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-ink">Local sidecar</span>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full" style={{ color: s.color, background: s.bg }}>
            <span style={{ width: 6, height: 6, borderRadius: 6, background: s.color }} />
            {s.label}{sc.external ? ' · external' : ''}
          </span>
          {running && sc.device && <DeviceBadge device={sc.device} model={sc.model} batchSize={sc.batchSize} />}
        </div>
        <div className="flex items-center gap-2">
          {running
            ? <button onClick={() => act('stop')} disabled={busy} className="btn btn-ghost !py-1.5">{busy ? '…' : 'Stop'}</button>
            : <button onClick={() => act('start')} disabled={busy} className="btn btn-primary !py-1.5">{busy ? 'Starting…' : 'Start sidecar'}</button>}
          {running && <button onClick={() => act('restart')} disabled={busy} className="btn btn-ghost !py-1.5">Restart</button>}
        </div>
      </div>
      <p className="text-xs text-muted mt-2">
        {running
          ? 'Transcribing locally on this machine. Turn it off to free CPU/RAM when using a cloud API.'
          : 'Off. Start it to transcribe locally without a cloud API.'}
      </p>
      {running && sc.device === 'cpu' && (
        <p className="text-xs mt-2 rounded-sm px-2.5 py-2" style={{ color: 'var(--warn)', background: 'var(--warn-soft)' }}>
          ⚠ Running on <b>CPU</b> — transcription is roughly 7x slower than GPU and is the usual cause of
          lag on longer meetings. If this machine has an NVIDIA GPU, install the CUDA libraries so the
          sidecar can use it (see the README GPU section).
        </p>
      )}
      {(err || sc.error) && <p className="text-xs text-error mt-1.5">{err || sc.error}</p>}
    </div>
  );
}

// Small pill showing the STT compute backend + model + batch size, so users can
// see at a glance whether transcription is GPU-accelerated (fast) or on the CPU
// fallback (slow). Green for cuda, muted/amber for cpu.
function DeviceBadge({ device, model, batchSize }) {
  const gpu = device === 'cuda';
  const color = gpu ? 'var(--accent)' : 'var(--warn)';
  const bg = gpu ? 'var(--accent-soft)' : 'var(--warn-soft)';
  const label = gpu ? 'GPU' : device === 'cpu' ? 'CPU' : device;
  const detail = [model, batchSize ? `batch ${batchSize}` : null].filter(Boolean).join(' · ');
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full"
      style={{ color, background: bg }} title={`STT on ${device}${detail ? ` (${detail})` : ''}`}>
      {label}{detail ? <span className="opacity-70">· {detail}</span> : null}
    </span>
  );
}

/* ── Connection card (server-wide Discord + STT settings) ────────────────── */
function ConnectionCard({ sys, onChanged }) {
  const [open, setOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const bot = sys?.bot;
  const conn = sys?.connection;
  if (!sys?.managed) {
    return (
      <Card title="Connection" desc="Discord bot connection.">
        <p className="text-sm text-muted">
          This dashboard is running in read-only mode (no bot process attached), so the Discord
          connection is managed elsewhere. Start Parley with <code className="text-ink-2">npm start</code> to
          edit it here.
        </p>
        {bot && <div className="mt-2"><BotStatusBadge bot={bot} /></div>}
      </Card>
    );
  }
  async function restart() {
    setRestarting(true);
    try { await api.botAction('restart'); await onChanged?.(); }
    finally { setRestarting(false); }
  }
  return (
    <Card title="Connection" desc="Your Discord bot. Changes reconnect instantly.">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {bot && <BotStatusBadge bot={bot} />}
          {bot?.guildCount > 0 && <span className="text-xs text-muted">{bot.guildCount} server{bot.guildCount === 1 ? '' : 's'}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={restart} disabled={restarting} className="btn btn-ghost !py-1.5">{restarting ? 'Reconnecting…' : 'Reconnect'}</button>
          <button onClick={() => setOpen((o) => !o)} className="btn btn-ghost !py-1.5">{open ? 'Close' : 'Edit credentials'}</button>
        </div>
      </div>
      {bot?.state === 'error' && bot?.error && <p className="text-xs text-error mt-2">{bot.error}</p>}
      {open && (
        <div className="mt-4 pt-4 border-t border-border">
          <ConnectionForm conn={conn} submitLabel="Save & reconnect" onSaved={async () => { setOpen(false); await onChanged?.(); }} />
        </div>
      )}
    </Card>
  );
}

export default function Setup() {
  const { guildId } = useGuild();
  const { status: sys, refresh: refreshSys } = useSystem();
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState('');
  const [msgErr, setMsgErr] = useState(false);
  // "Draft" providers: when you pick a cloud provider that has no API key yet,
  // we stage the choice (reveal its key field) WITHOUT saving — saving would be
  // rejected server-side ("key not set"). Once the key is added we auto-commit.
  const [sumDraft, setSumDraft] = useState(null);
  const [sttDraft, setSttDraft] = useState(null);

  function reload() { if (guildId) api.config(guildId).then(setData).catch(() => setData(null)); }
  useEffect(() => { reload(); }, [guildId]);

  // One catalog per model field: the primary provider's and the fallback's.
  const models = useCatalog(data?.config?.summarizerProvider);
  const fbModels = useCatalog(data?.config?.summarizerFallbackProvider);

  if (!guildId) return (
    <Page max="720px">
      <PageHead title="Settings" subtitle="Discord connection and per-server configuration." />
      <ConnectionCard sys={sys} onChanged={refreshSys} />
      <div className="mt-5"><Empty icon={Icon.Settings} title="No server selected" body="Pick a server from the top bar to configure summarizer, transcription, and delivery." /></div>
    </Page>
  );
  if (!data) return (
    <Page max="720px">
      <div className="h-8 w-32 skeleton mb-7" />
      <div className="space-y-5">{[0,1,2].map(i => <div key={i} className="h-44 skeleton rounded-[14px]" />)}</div>
    </Page>
  );

  const { config: c, providers, sttProviders, channels, secrets = {}, defaultModels = {} } = data;
  const save = async (patch) => {
    try {
      const r = await api.saveConfig(guildId, patch);
      setData((d) => ({ ...d, config: r.config }));
      setMsg('Saved'); setMsgErr(false);
      // Switching the transcription backend may have auto-started/stopped the
      // local sidecar; refresh system status so its pill reflects reality.
      if (patch.sttProvider !== undefined) refreshSys?.();
      return true;
    } catch (e) { setMsg(e.message); setMsgErr(true); return false; }
    finally { setTimeout(() => setMsg(''), 2400); }
  };
  const sel = 'input appearance-none pr-9 cursor-pointer';

  // ── Summarizer provider, with draft-before-key handling ───────────────────
  const sumProvider = sumDraft || c.summarizerProvider;        // shown in the <select>
  const sumReady = (providers.find((p) => p.provider === sumProvider) || {}).ok;
  const sumKeyed = Object.prototype.hasOwnProperty.call(KEYED, sumProvider);
  function pickSummarizer(p) {
    const ready = (providers.find((x) => x.provider === p) || {}).ok;
    if (!ready && Object.prototype.hasOwnProperty.call(KEYED, p)) {
      setSumDraft(p);              // stage it; reveal the key field, don't save yet
      setMsg(''); 
    } else {
      setSumDraft(null);
      save({ provider: p, model: defaultModels[p] || '' });
    }
  }
  // After a key lands for the staged provider, commit the switch.
  async function commitSumKey() {
    await reload();
    if (sumDraft) { await save({ provider: sumDraft, model: defaultModels[sumDraft] || '' }); setSumDraft(null); }
  }

  // ── Transcription provider, same pattern ──────────────────────────────────
  const sttProvider = sttDraft || c.sttProvider;
  const sttReady = (sttProviders || []).find((p) => p.provider === sttProvider)?.ok;
  const sttKeyed = Object.prototype.hasOwnProperty.call(STT_KEY, sttProvider);
  const sttModels = (sttProviders || []).find((p) => p.provider === sttProvider)?.models || [];
  function pickStt(p) {
    const sp = (sttProviders || []).find((x) => x.provider === p);
    if (!sp?.ok && Object.prototype.hasOwnProperty.call(STT_KEY, p)) {
      setSttDraft(p);              // stage it; reveal the key field, don't save yet
      setMsg('');
    } else {
      setSttDraft(null);
      save({ sttProvider: p, sttModel: p === 'sidecar' ? null : (sp?.models?.[0] ?? null) });
    }
  }
  async function commitSttKey() {
    await reload(); refreshSys?.();
    if (sttDraft) {
      const sp = (sttProviders || []).find((x) => x.provider === sttDraft);
      await save({ sttProvider: sttDraft, sttModel: sp?.models?.[0] ?? null });
      setSttDraft(null);
    }
  }

  return (
    <Page max="720px">
      <PageHead
        title="Settings"
        subtitle="Per-server configuration. Applied instantly, no restart."
        actions={msg && <span className={`text-sm font-medium ${msgErr ? 'text-error' : 'text-accent'}`}>{msg}</span>}
      />

      <div className="space-y-5">
        <ConnectionCard sys={sys} onChanged={refreshSys} />
        <Card title="Summarizer" desc="Which AI turns transcripts into structured notes.">
          <Field label="Provider" hint={sumDraft ? 'Add the API key below to switch to this provider.' : undefined}>
            <div className="relative">
              <select className={sel} value={sumProvider}
                onChange={(e) => pickSummarizer(e.target.value)}>
                {providers.map((p) => (
                  <option key={p.provider} value={p.provider}>
                    {p.provider}{p.ok ? '' : ' (no key set)'}
                  </option>
                ))}
              </select>
              <Chevron />
            </div>
          </Field>

          {sumKeyed && <KeyEditor provider={sumProvider} present={!!secrets[sumProvider]} onChanged={commitSumKey} autoEdit={!!sumDraft} />}

          {!sumDraft && (
          <Field label="Model" hint="Type to search the provider's catalog. Any id it supports also works — press Enter to use what you typed.">
            <ModelPicker value={c.summarizerModel} catalog={models.catalog} loading={models.loading}
              onRefresh={models.reload}
              onPick={(id) => save({ provider: c.summarizerProvider, model: id })} />
          </Field>
          )}

          {/* Only providers with a working key are offered: validateSetup rejects
              a keyless fallback server-side, so listing them would just error. */}
          {!sumDraft && (
          <Field label="Fallback" hint="Tried only if the primary fails (quota cap, outage, region block). Choose none to disable.">
            <div className="relative">
              <select className={sel} value={c.summarizerFallbackProvider || 'none'}
                onChange={(e) => save({ fallbackProvider: e.target.value })}>
                <option value="none">none</option>
                {providers.filter((p) => p.ok && p.provider !== c.summarizerProvider).map((p) => (
                  <option key={p.provider} value={p.provider}>{p.provider}</option>
                ))}
              </select>
              <Chevron />
            </div>
            {c.summarizerFallbackProvider && (
              <div className="mt-2">
                <ModelPicker value={c.summarizerFallbackModel} catalog={fbModels.catalog} loading={fbModels.loading}
                  onRefresh={fbModels.reload}
                  onPick={(id) => save({ fallbackModel: id })} />
              </div>
            )}
          </Field>
          )}
        </Card>

        <Card title="Transcription" desc="How spoken audio becomes text.">
          <Field label="Provider" hint={sttDraft ? 'Add the API key below to switch to this provider.' : (STT_HELP[sttProvider] || '')}>
            <div className="relative">
              <select className={sel} value={sttProvider}
                onChange={(e) => pickStt(e.target.value)}>
                {(sttProviders || []).map((p) => (
                  <option key={p.provider} value={p.provider}>
                    {p.label || p.provider}{p.ok ? '' : ' (no key set)'}
                  </option>
                ))}
              </select>
              <Chevron />
            </div>
          </Field>

          {sttKeyed && (
            <KeyEditor provider={STT_KEY[sttProvider]} present={!!secrets[STT_KEY[sttProvider]]} onChanged={commitSttKey} autoEdit={!!sttDraft} />
          )}

          {sttDraft ? null : c.sttProvider === 'sidecar' ? (
            <>
              <Field label="Whisper model" hint="Larger is more accurate but slower on CPU.">
                <div className="relative">
                  <select className={sel} value={c.whisperModel} onChange={(e) => save({ whisperModel: e.target.value })}>
                    {WHISPER.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <Chevron />
                </div>
              </Field>
              <SidecarControl sys={sys} onChanged={refreshSys} />
            </>
          ) : (
            <>
              <Field label="Model" hint="Cloud transcription model.">
                <div className="relative">
                  <select className={sel} value={c.sttModel || (sttModels[0] ?? '')} onChange={(e) => save({ sttModel: e.target.value })}>
                    {sttModels.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <Chevron />
                </div>
              </Field>
              {sys?.sidecar?.managed && sys?.sidecar?.running && (
                <SidecarControl sys={sys} onChanged={refreshSys} />
              )}
            </>
          )}

          <Field label="Spoken language">
            <div className="relative">
              <select className={sel} value={c.language} onChange={(e) => save({ language: e.target.value })}>
                {LANGS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
              </select>
              <Chevron />
            </div>
          </Field>
        </Card>

        <Card title="Delivery" desc="Where and how notes are posted in Discord.">
          <Field label="Notes channel">
            <div className="relative">
              <select className={sel} value={c.notesChannelId || ''} onChange={(e) => save({ notesChannelId: e.target.value || null })}>
                <option value="">(meeting's own channel)</option>
                {channels.map((ch) => <option key={ch.id} value={ch.id}>#{ch.name}</option>)}
              </select>
              <Chevron />
            </div>
          </Field>
          <Field label="Summary language">
            <div className="relative">
              <select className={sel} value={c.summaryLanguage} onChange={(e) => save({ summary_language: e.target.value })}>
                {SUMMARY_LANGS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
              </select>
              <Chevron />
            </div>
          </Field>
          <Switch checked={c.useThread} onChange={(e) => save({ useThread: e.target.checked })}
            label="Post notes in a thread" desc="Keeps the channel tidy by threading each meeting's notes." />
        </Card>

        <Card title="Behavior">
          <Switch checked={c.autoJoin} onChange={(e) => save({ autoJoin: e.target.checked })}
            label="Auto-join voice" desc="Join automatically when two or more people are in a voice channel." />
        </Card>
      </div>
    </Page>
  );
}
