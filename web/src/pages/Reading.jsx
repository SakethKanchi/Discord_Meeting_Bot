import { useEffect, useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useGuild } from '../GuildContext.jsx';
import { Avatar, AvatarStack, Icon, Empty, TalkBar } from '../components/ui.jsx';
import { fmtDateLong, fmtTime, fmtDuration, fmtClock, fmtMs, colorOf } from '../lib/format.js';
import { useDismissable } from '../hooks/useDismissable.js';
import Markdown from '../components/Markdown.jsx';

/* ── retry banner (failed / stuck meetings) ───────────────────────────── */
const STATUS_COPY = {
  transcription_failed: {
    title: 'Transcription failed',
    body: 'The speech-to-text sidecar was unreachable or errored while transcribing this meeting. If the audio is still on disk, you can retry the whole pipeline.',
  },
  summary_failed: {
    title: 'Summary failed',
    body: 'The transcript was captured, but the summarizer errored (often a transient rate-limit or a missing API key). Retrying re-runs only the summary.',
  },
  processing: {
    title: 'Stuck processing',
    body: 'This meeting was left mid-process, likely because the bot restarted. Retry to finish it.',
  },
};

function RetryBanner({ meeting, retry, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const copy = STATUS_COPY[meeting.status] || { title: 'Needs attention', body: `Status: ${meeting.status}.` };
  const canRetry = retry?.eligible;

  async function run() {
    setBusy(true); setErr(null);
    try {
      const r = await api.retryMeeting(meeting.id);
      if (!r.ok) { setErr(r.error || r.reason || 'Retry failed.'); }
      else { onDone?.(); }
    } catch (e) {
      setErr(e?.message || 'Retry failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5 mt-8 border-l-2" style={{ borderColor: 'var(--error)' }}>
      <div className="flex items-start gap-3">
        <Icon.Alert width={20} height={20} className="text-error shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-ink">{copy.title}</p>
          <p className="text-[13.5px] text-muted leading-relaxed mt-1">{copy.body}</p>
          {!canRetry && retry?.reason && <p className="text-[13px] text-error mt-2">{retry.reason}</p>}
          {err && <p className="text-[13px] text-error mt-2">{err}</p>}
          <div className="mt-3.5 flex items-center gap-2">
            <button onClick={run} disabled={!canRetry || busy} className="btn btn-primary !py-2">
              {busy ? (
                <span className="inline-flex items-center gap-2"><span className="h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />Retrying…</span>
              ) : (
                <span className="inline-flex items-center gap-2"><Icon.Refresh width={15} height={15} />Retry {retry?.action === 'retranscribe' ? 'transcription' : 'summary'}</span>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── action item (in-note, checkable) ─────────────────────────────────── */
function ActionItem({ item, todo, onToggle }) {
  const [done, setDone] = useState(Boolean(todo?.done));
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (todo) setDone(Boolean(todo.done)); }, [todo]);

  async function change() {
    if (!todo || busy) return;
    const next = !done;
    setDone(next); setBusy(true);
    try { await api.setTodoDone(todo.id, next); onToggle?.(); }
    catch { setDone(!next); }
    finally { setBusy(false); }
  }

  return (
    <li className="flex items-start gap-3 group">
      <input type="checkbox" checked={done} onChange={change} disabled={!todo || busy} className="pcheck mt-0.5" aria-label={item.task} />
      <div className="min-w-0">
        <span className={`text-[14.5px] leading-relaxed ${done ? 'line-through text-muted' : 'text-ink'}`}>{item.task}</span>
        {item.assignee && (
          <span className="ml-2 inline-flex items-center gap-1.5 align-middle chip">
            <Avatar name={item.assignee} size={16} />{item.assignee}
          </span>
        )}
      </div>
    </li>
  );
}

/* ── transcript ───────────────────────────────────────────────────────── */
function Transcript({ utterances }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  if (!utterances.length) return null;

  const filtered = q.trim()
    ? utterances.filter((u) => u.text.toLowerCase().includes(q.toLowerCase()))
    : utterances;

  return (
    <section className="mt-10 pt-8 border-t border-border">
      <div className="flex items-center justify-between gap-3 mb-4">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 text-sm font-bold text-ink">
          <Icon.Chevron width={16} height={16} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
          Transcript
          <span className="chip">{utterances.length} lines</span>
        </button>
        {open && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find in transcript…"
            className="input !w-52 !py-1.5 text-[13px]" />
        )}
      </div>
      {open && (
        <div className="space-y-4">
          {filtered.length === 0 && <p className="text-sm text-muted">No lines match "{q}".</p>}
          {filtered.map((u, i) => (
            <div key={i} className="flex items-start gap-3">
              <Avatar name={u.display_name} size={28} />
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-semibold" style={{ color: colorOf(u.display_name) }}>{u.display_name}</span>
                  <span className="text-[11px] text-faint tabular-nums">{fmtClock(u.start_ms)}</span>
                </div>
                <p className="text-[14px] text-ink-2 leading-relaxed mt-0.5">{u.text}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ── ask box ──────────────────────────────────────────────────────────── */
function AskBox({ guildId, meetingId }) {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [error, setError] = useState(null);

  const SUGGESTIONS = ['What was decided?', 'Who owns what?', 'Summarize in 3 bullets'];

  async function ask(qStr) {
    const q = (qStr ?? question).trim();
    if (!q || loading) return;
    setQuestion(q); setLoading(true); setAnswer(null); setError(null);
    try { const res = await api.ask(guildId, meetingId, q); setAnswer(res.answer); }
    catch (err) { setError(err?.message || 'Request failed'); }
    finally { setLoading(false); }
  }

  return (
    <section className="mt-10 card p-5"
      style={{ background: 'linear-gradient(180deg, var(--primary-soft), transparent)' }}>
      <h2 className="flex items-center gap-2 text-sm font-bold text-ink mb-3">
        <Icon.Sparkle width={16} height={16} className="text-primary" /> Ask this meeting
      </h2>
      <form onSubmit={(e) => { e.preventDefault(); ask(); }} className="flex gap-2">
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask anything about this meeting…"
          disabled={loading} className="input flex-1" />
        <button type="submit" disabled={!question.trim() || loading} className="btn btn-primary">
          {loading ? 'Asking…' : 'Ask'}
        </button>
      </form>
      {!answer && !loading && (
        <div className="flex flex-wrap gap-2 mt-3">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => ask(s)} className="chip hover:!bg-surface-2 transition-colors">{s}</button>
          ))}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-error" role="alert">{error}</p>}
      {answer && (
        <div className="mt-4 text-[14.5px] text-ink leading-relaxed bg-surface-2 rounded-sm p-4 border border-border animate-fade-in">
          <Markdown text={answer} />
        </div>
      )}
    </section>
  );
}

/* ── meeting actions (delete / merge / export / audio) ─────────────────── */
function MeetingActions({ meeting, meetings, hasAudio }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(false); // false | 'pick' | 'busy'
  const [sources, setSources] = useState(() => new Set());
  const [err, setErr] = useState(null);
  const others = (meetings || []).filter((m) => m.id !== meeting.id);
  // Close the menu/merge popover on outside click or Escape (a11y).
  const ref = useDismissable(open || !!mode, () => { setOpen(false); if (mode !== 'busy') setMode(false); });

  async function del() {
    setOpen(false);
    if (!window.confirm('Delete this meeting, its transcript, summary and action items? This cannot be undone.')) return;
    try { await api.deleteMeeting(meeting.id); navigate('/meetings'); }
    catch (e) { setErr(e?.message || 'Delete failed'); }
  }
  function toggle(id) { setSources((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  async function merge() {
    if (sources.size === 0) return;
    setMode('busy'); setErr(null);
    try { await api.mergeMeetings(meeting.id, [...sources]); setMode(false); setSources(new Set()); navigate(0); }
    catch (e) { setErr(e?.message || 'Merge failed'); setMode('pick'); }
  }

  return (
    <div className="relative shrink-0" ref={ref}>
      <button onClick={() => { setOpen((v) => !v); setMode(false); }} aria-label="Meeting actions"
        aria-haspopup="menu" aria-expanded={open || !!mode}
        className="h-9 w-9 grid place-items-center rounded-sm border border-border text-muted hover:text-ink hover:bg-surface-2 transition-colors">
        <Icon.Dots width={18} height={18} />
      </button>
      {open && !mode && (
        <div role="menu" className="absolute right-0 mt-1.5 w-52 card shadow-lg py-1 z-20">
          <a href={api.exportMeetingUrl(meeting.id, 'md')} role="menuitem" onClick={() => setOpen(false)}
            className="w-full flex items-center gap-2.5 text-left px-3 py-2 text-sm text-ink hover:bg-surface-2 no-underline">
            <Icon.Download width={15} height={15} /> Export (markdown)
          </a>
          {hasAudio && (
            <a href={api.audioUrl(meeting.id)} role="menuitem" onClick={() => setOpen(false)}
              className="w-full flex items-center gap-2.5 text-left px-3 py-2 text-sm text-ink hover:bg-surface-2 no-underline">
              <Icon.Download width={15} height={15} /> Download audio (WAV)
            </a>
          )}
          <button role="menuitem" onClick={() => { setMode('pick'); setOpen(false); }} disabled={others.length === 0}
            className="w-full flex items-center gap-2.5 text-left px-3 py-2 text-sm text-ink hover:bg-surface-2 disabled:opacity-40">
            <Icon.Merge width={15} height={15} /> Merge another meeting
          </button>
          <button role="menuitem" onClick={del} className="w-full flex items-center gap-2.5 text-left px-3 py-2 text-sm text-error hover:bg-error-soft">
            <Icon.Trash width={15} height={15} /> Delete meeting
          </button>
        </div>
      )}
      {mode && (
        <div className="absolute right-0 mt-1.5 w-80 card shadow-lg p-3 z-20">
          <p className="text-sm font-semibold text-ink mb-2">Merge into this note</p>
          <div className="max-h-64 overflow-y-auto -mx-1 px-1 space-y-0.5">
            {others.map((m) => (
              <label key={m.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-2 cursor-pointer text-sm">
                <input type="checkbox" className="pcheck h-4 w-4" checked={sources.has(m.id)} onChange={() => toggle(m.id)} disabled={mode === 'busy'} />
                <span className="text-ink truncate">{fmtDateLong(m.started_at)}</span>
                <span className="text-muted text-xs ml-auto shrink-0">{fmtTime(m.started_at)}</span>
              </label>
            ))}
          </div>
          {err && <p className="text-xs text-error mt-2">{err}</p>}
          <div className="flex items-center justify-end gap-2 mt-3">
            <button onClick={() => { setMode(false); setSources(new Set()); setErr(null); }} disabled={mode === 'busy'} className="btn btn-ghost !py-1.5">Cancel</button>
            <button onClick={merge} disabled={sources.size === 0 || mode === 'busy'} className="btn btn-primary !py-1.5">
              {mode === 'busy' ? 'Merging…' : `Merge ${sources.size || ''}`.trim()}
            </button>
          </div>
        </div>
      )}
      {err && !mode && <p className="text-xs text-error mt-1 absolute right-0 whitespace-nowrap">{err}</p>}
    </div>
  );
}

/* ── prev/next meeting nav ────────────────────────────────────────────── */
function MeetingNav({ meetings, id }) {
  const idx = meetings.findIndex((m) => String(m.id) === String(id));
  if (idx === -1) return null;
  const newer = meetings[idx - 1]; // list is newest-first
  const older = meetings[idx + 1];
  return (
    <div className="flex items-center justify-between gap-3 mt-12 pt-6 border-t border-border">
      {older ? (
        <Link to={`/meetings/${older.id}`} className="group flex items-center gap-2 text-sm text-muted hover:text-ink no-underline">
          <Icon.Arrow width={16} height={16} className="rotate-180" />
          <span><span className="block text-[11px] text-faint">Older</span>{fmtDateLong(older.started_at)}</span>
        </Link>
      ) : <span />}
      {newer ? (
        <Link to={`/meetings/${newer.id}`} className="group flex items-center gap-2 text-sm text-muted hover:text-ink no-underline text-right">
          <span><span className="block text-[11px] text-faint">Newer</span>{fmtDateLong(newer.started_at)}</span>
          <Icon.Arrow width={16} height={16} />
        </Link>
      ) : <span />}
    </div>
  );
}

/* ── note document ────────────────────────────────────────────────────── */
function Note({ data, todos, guildId, meetings, refetchTodos, onReload }) {
  const { meeting, summary, attendees, utterances, retry } = data;
  const notes = summary?.notes;
  const duration = fmtDuration(meeting.started_at, meeting.ended_at);
  const meetingTodos = todos.filter((t) => String(t.meeting_id) === String(meeting.id));
  const isFailed = ['transcription_failed', 'summary_failed', 'processing'].includes(meeting.status);

  return (
    <article className="max-w-[760px] mx-auto pb-12 animate-fade-up">
      <Link to="/meetings" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink mb-5 no-underline">
        <Icon.Arrow width={14} height={14} className="rotate-180" /> All meetings
      </Link>

      <header>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="chip"><Icon.Hash width={12} height={12} />{meeting.channel_name}</span>
            </div>
            <h1 className="font-display text-[30px] font-extrabold text-ink leading-tight tracking-tight">{fmtDateLong(meeting.started_at)}</h1>
            <p className="text-sm text-muted mt-1.5 flex items-center gap-3 flex-wrap">
              <span className="inline-flex items-center gap-1.5"><Icon.Clock width={14} height={14} />{fmtTime(meeting.started_at)}{duration && ` · ${duration}`}</span>
              {attendees?.length > 0 && <span className="inline-flex items-center gap-1.5"><Icon.Users width={14} height={14} />{attendees.length} attendees</span>}
            </p>
          </div>
          <MeetingActions meeting={meeting} meetings={meetings} hasAudio={data.hasAudio} />
        </div>

        {attendees?.length > 0 && (
          <div className="flex items-center gap-2 mt-4">
            <AvatarStack names={attendees.map((a) => a.display_name)} size={28} max={8} />
          </div>
        )}
      </header>

      {isFailed && <RetryBanner meeting={meeting} retry={retry} onDone={onReload} />}

      {!notes && !isFailed && <p className="text-sm text-muted mt-8">No summary available — status: {meeting.status}.</p>}

      {notes && (
        <>
          {notes.tldr && <p className="text-[16px] text-ink leading-relaxed mt-8 font-medium">{notes.tldr}</p>}

          {notes.topics?.length > 0 && (
            <section className="mt-9">
              <h2 className="text-sm font-bold text-ink mb-4">Topics</h2>
              <div className="space-y-5">
                {notes.topics.map((t, i) => (
                  <div key={i} className="relative pl-4 border-l-2" style={{ borderColor: 'var(--border-strong)' }}>
                    <h3 className="text-[15px] font-semibold text-ink">{t.title}</h3>
                    {t.points?.length > 0 && (
                      <ul className="mt-2 space-y-1.5">
                        {t.points.map((p, j) => (
                          <li key={j} className="text-[14px] text-ink-2 leading-relaxed flex gap-2">
                            <span className="text-faint mt-2 h-1 w-1 rounded-full bg-current shrink-0" />{p}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {notes.decisions?.length > 0 && (
            <section className="mt-9">
              <h2 className="text-sm font-bold text-ink mb-3">Decisions</h2>
              <ul className="space-y-2">
                {notes.decisions.map((d, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-[14.5px] text-ink leading-relaxed">
                    <Icon.Check width={16} height={16} className="text-accent mt-0.5 shrink-0" />{d}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {notes.openQuestions?.length > 0 && (
            <section className="mt-9">
              <h2 className="text-sm font-bold text-ink mb-3">Open questions</h2>
              <ul className="space-y-2">
                {notes.openQuestions.map((q, i) => (
                  <li key={i} className="text-[14.5px] text-ink leading-relaxed flex gap-2.5">
                    <span className="text-warn font-bold shrink-0">?</span>{q}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {notes.actionItems?.length > 0 && (
            <section className="mt-9 card p-5">
              <h2 className="flex items-center gap-2 text-sm font-bold text-ink mb-4">
                <Icon.CheckSquare width={16} height={16} className="text-primary" /> Action items
              </h2>
              <ul className="space-y-3">
                {notes.actionItems.map((item) => {
                  const todo = meetingTodos.find((t) => t.task === item.task) ?? null;
                  return <ActionItem key={item.task} item={item} todo={todo} onToggle={refetchTodos} />;
                })}
              </ul>
            </section>
          )}
        </>
      )}

      {summary?.talktime?.length > 0 && (
        <section className="mt-9">
          <h2 className="text-sm font-bold text-ink mb-4">Talk time</h2>
          <div className="mb-3"><TalkBar talktime={summary.talktime} height={8} /></div>
          <div className="space-y-2.5">
            {summary.talktime.map((t, i) => (
              <div key={i} className="flex items-center gap-3">
                <Avatar name={t.displayName} size={24} />
                <span className="text-[13.5px] text-ink flex-1">{t.displayName}</span>
                <span className="text-xs text-muted tabular-nums">{fmtMs(t.ms)}</span>
                <span className="text-xs font-semibold tabular-nums w-10 text-right" style={{ color: colorOf(t.displayName) }}>{t.pct}%</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <Transcript utterances={utterances ?? []} />
      {guildId && <AskBox guildId={guildId} meetingId={meeting.id} />}
      <MeetingNav meetings={meetings} id={meeting.id} />
    </article>
  );
}

function NoteSkeleton() {
  return (
    <div className="max-w-[760px] mx-auto pb-12 px-6 md:px-8 py-7">
      <div className="h-3 w-24 skeleton mb-6" />
      <div className="h-5 w-20 skeleton mb-3 rounded-full" />
      <div className="h-9 w-72 skeleton mb-3" />
      <div className="h-4 w-48 skeleton mb-8" />
      <div className="space-y-2.5 mb-8">
        <div className="h-4 w-full skeleton" /><div className="h-4 w-11/12 skeleton" /><div className="h-4 w-9/12 skeleton" />
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="mb-8">
          <div className="h-4 w-28 skeleton mb-3" />
          <div className="space-y-2"><div className="h-4 w-full skeleton" /><div className="h-4 w-10/12 skeleton" /></div>
        </div>
      ))}
    </div>
  );
}

export default function Reading() {
  const { id } = useParams();
  const { guildId } = useGuild();
  const [meetings, setMeetings] = useState([]);
  const [data, setData] = useState(null);
  const [todos, setTodos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!guildId) return;
    let stale = false;
    api.meetings(guildId)
      .then((rows) => { if (!stale) setMeetings((Array.isArray(rows) ? rows : []).filter((m) => (m.utterance_count ?? 1) > 0 || m.failed)); })
      .catch(() => { if (!stale) setMeetings([]); });
    return () => { stale = true; };
  }, [guildId]);

  function loadTodos() {
    if (!guildId) return;
    api.todos(guildId).then((t) => setTodos(Array.isArray(t) ? t : [])).catch(() => {});
  }

  function reloadMeeting() {
    if (!id || !guildId) return;
    Promise.all([api.meeting(id), api.todos(guildId)])
      .then(([m, t]) => { setData(m); setTodos(Array.isArray(t) ? t : []); })
      .catch(() => {});
    api.meetings(guildId).then((rows) => setMeetings((Array.isArray(rows) ? rows : []).filter((m) => (m.utterance_count ?? 1) > 0 || m.failed))).catch(() => {});
  }

  useEffect(() => {
    if (!id || !guildId) return;
    let stale = false;
    setLoading(true); setError(null); setData(null);
    Promise.all([api.meeting(id), api.todos(guildId)])
      .then(([m, t]) => { if (stale) return; setData(m); setTodos(Array.isArray(t) ? t : []); })
      .catch((e) => { if (!stale) setError(e?.message || 'Failed to load meeting'); })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [id, guildId]);

  if (loading || (!data && !error)) return <NoteSkeleton />;
  if (error) return <div className="px-8 py-10"><Empty icon={Icon.Doc} title="Couldn't load meeting" body={error} /></div>;

  return (
    <div className="px-6 md:px-8 py-7">
      <Note key={data.meeting.id} data={data} todos={todos} guildId={guildId} meetings={meetings} refetchTodos={loadTodos} onReload={reloadMeeting} />
    </div>
  );
}
