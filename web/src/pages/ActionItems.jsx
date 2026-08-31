import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useGuild } from '../GuildContext.jsx';
import { Page, PageHead } from '../components/Page.jsx';
import { Avatar, Icon, Empty } from '../components/ui.jsx';
import { fmtDateShort } from '../lib/format.js';

const ALL = Symbol('all');

/* The summarizer stores compound assignees ("Devin, Vineel") and name variants
   ("Devin" vs "Devin Robinson"). Split + canonicalize by word-prefix folding. */
function splitAssignees(s) {
  if (s == null) return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}
function buildCanonical(names) {
  const uniq = [...new Set(names)];
  const longestFirst = [...uniq].sort((a, b) => b.length - a.length);
  const map = new Map();
  for (const n of uniq) {
    const nl = n.toLowerCase();
    map.set(n, longestFirst.find((c) => { const cl = c.toLowerCase(); return cl === nl || cl.startsWith(nl + ' '); }) || n);
  }
  return map;
}
function peopleOf(todo, canon) {
  return [...new Set(splitAssignees(todo.assignee).map((n) => canon.get(n) || n))];
}

function TodoRow({ todo, onToggle, people }) {
  const [busy, setBusy] = useState(false);
  const done = Boolean(todo.done);
  async function change() { if (busy) return; setBusy(true); try { await onToggle(todo); } finally { setBusy(false); } }
  return (
    <li className="flex items-start gap-3 px-4 py-3 hover:bg-surface-2 transition-colors group">
      <input type="checkbox" checked={done} onChange={change} disabled={busy} className="pcheck mt-0.5" aria-label={todo.task} />
      <div className="min-w-0 flex-1">
        <span className={`text-[14px] leading-relaxed block ${done ? 'line-through text-muted' : 'text-ink'}`}>{todo.task}</span>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {people.length > 0 ? people.map((p) => (
            <span key={p} className="inline-flex items-center gap-1.5 chip"><Avatar name={p} size={15} />{p}</span>
          )) : <span className="chip text-muted">Unassigned</span>}
          <span className="text-faint text-xs">·</span>
          <Link to={`/meetings/${todo.meeting_id}`} className="text-xs text-muted hover:text-primary no-underline inline-flex items-center gap-1">
            <Icon.Doc width={12} height={12} /> {fmtDateShort(todo.created_at)}
          </Link>
        </div>
      </div>
    </li>
  );
}

function Skeleton() {
  return (
    <div className="card p-1">
      {Array.from({ length: 7 }).map((_, i) => <div key={i} className="h-14 skeleton m-2 rounded-md" />)}
    </div>
  );
}

export default function ActionItems() {
  const { guildId } = useGuild();
  const [todos, setTodos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [person, setPerson] = useState(ALL); // ALL | null(unassigned) | name
  const [showDone, setShowDone] = useState(false);
  const [version, setVersion] = useState(0);
  const [toggleErr, setToggleErr] = useState(null);

  useEffect(() => { setPerson(ALL); setShowDone(false); }, [guildId]);

  useEffect(() => {
    if (!guildId) { setTodos([]); return; }
    let stale = false;
    setLoading(true); setError(null);
    api.todos(guildId, showDone ? {} : { open: true })
      .then((rows) => { if (!stale) { setTodos(Array.isArray(rows) ? rows : []); setLoading(false); } })
      .catch((e) => { if (!stale) { setError(e?.message || 'Failed to load'); setLoading(false); } });
    return () => { stale = true; };
  }, [guildId, showDone, version]);

  async function toggle(t) {
    try { await api.setTodoDone(t.id, !t.done); setVersion((v) => v + 1); setToggleErr(null); }
    catch (e) { setToggleErr(e?.status === 403 ? 'Only admins can edit action items.' : (e?.message || 'Could not update')); }
  }

  const { canon, people, hasUnassigned } = useMemo(() => {
    const raw = []; let unassigned = false;
    for (const t of todos) { const ns = splitAssignees(t.assignee); if (ns.length === 0) unassigned = true; raw.push(...ns); }
    const map = buildCanonical(raw);
    const list = [...new Set(raw.map((n) => map.get(n) || n))].sort((a, b) => a.localeCompare(b));
    return { canon: map, people: list, hasUnassigned: unassigned };
  }, [todos]);

  // Counts per person for the filter chips.
  const counts = useMemo(() => {
    const c = new Map();
    for (const t of todos) for (const p of peopleOf(t, canon)) c.set(p, (c.get(p) || 0) + 1);
    return c;
  }, [todos, canon]);

  const visible = useMemo(() => todos.filter((t) => {
    if (person === ALL) return true;
    if (person === null) return splitAssignees(t.assignee).length === 0;
    return peopleOf(t, canon).includes(person);
  }), [todos, person, canon]);

  if (!guildId) return <Page><Empty icon={Icon.CheckSquare} title="No server selected" /></Page>;

  const openCount = todos.filter((t) => !t.done).length;

  return (
    <Page max="900px">
      <PageHead
        title="Action items"
        subtitle={`${openCount} open across ${people.length} ${people.length === 1 ? 'person' : 'people'}`}
        actions={
          <label className="flex items-center gap-2 text-sm text-muted cursor-pointer select-none">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} className="pcheck h-4 w-4" />
            Show completed
          </label>
        }
      />

      {/* Person filter chips */}
      {toggleErr && (
        <p role="alert" className="text-xs text-error bg-error-soft rounded-sm px-3 py-2 mb-4">{toggleErr}</p>
      )}
      <div className="flex items-center gap-2 mb-5 flex-wrap">
        <button onClick={() => setPerson(ALL)} className={`chip ${person === ALL ? '!bg-primary-soft !text-ink' : ''}`}>
          Everyone <span className="text-faint">{todos.length}</span>
        </button>
        {people.map((p) => (
          <button key={p} onClick={() => setPerson(p)} className={`chip ${person === p ? '!bg-primary-soft !text-ink' : ''}`}>
            <Avatar name={p} size={15} />{p} <span className="text-faint">{counts.get(p) || 0}</span>
          </button>
        ))}
        {hasUnassigned && (
          <button onClick={() => setPerson(null)} className={`chip ${person === null ? '!bg-primary-soft !text-ink' : ''}`}>Unassigned</button>
        )}
      </div>

      {loading ? <Skeleton />
        : error ? <Empty icon={Icon.CheckSquare} title="Couldn't load action items" body={error} />
        : visible.length === 0 ? (
          <div className="card"><Empty icon={Icon.Check} title={showDone ? 'No action items' : 'All caught up'} body={showDone ? 'Action items appear here once meetings are summarized.' : 'No open tasks in this view.'} /></div>
        ) : (
          <ul className="card p-1 divide-y divide-border">
            {visible.map((t) => <TodoRow key={t.id} todo={t} onToggle={toggle} people={peopleOf(t, canon)} />)}
          </ul>
        )}
    </Page>
  );
}
