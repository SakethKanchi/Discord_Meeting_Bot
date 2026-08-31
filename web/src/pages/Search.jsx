import { Fragment, useEffect, useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useGuild } from '../GuildContext.jsx';
import { Page, PageHead } from '../components/Page.jsx';
import { Avatar, Icon, Empty } from '../components/ui.jsx';

function highlight(text, q) {
  if (!q) return text;
  const needle = q.toLowerCase();
  const hay = text.toLowerCase();
  const out = [];
  let i = 0, idx = hay.indexOf(needle, i);
  let k = 0;
  while (idx !== -1) {
    if (idx > i) out.push(<Fragment key={k++}>{text.slice(i, idx)}</Fragment>);
    out.push(<mark key={k++}>{text.slice(idx, idx + q.length)}</mark>);
    i = idx + q.length;
    idx = hay.indexOf(needle, i);
  }
  if (i < text.length) out.push(<Fragment key={k++}>{text.slice(i)}</Fragment>);
  return out.length ? out : text;
}

function ResultRow({ row, q }) {
  return (
    <Link to={`/meetings/${row.meeting_id}`} className="flex items-start gap-3 px-4 py-3.5 hover:bg-surface-2 transition-colors no-underline group">
      <Avatar name={row.display_name} size={30} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-ink">{row.display_name}</span>
          <span className="text-xs text-muted group-hover:text-primary inline-flex items-center gap-1">in meeting #{row.meeting_id} <Icon.ArrowUpRight width={12} height={12} /></span>
        </div>
        <p className="text-[13.5px] text-ink-2 leading-relaxed mt-0.5 line-clamp-2">{highlight(row.text, q)}</p>
      </div>
    </Link>
  );
}

function SearchSkeleton() {
  return <div className="card p-1">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-16 skeleton m-2 rounded-md" />)}</div>;
}

export default function Search() {
  const { guildId } = useGuild();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const urlQ = params.get('q') ?? '';
  const [input, setInput] = useState(urlQ);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { setInput(urlQ); }, [urlQ]);

  useEffect(() => {
    const q = urlQ.trim();
    if (!q || !guildId) { setRows([]); setLoading(false); setSearched(guildId ? Boolean(q) : false); return; }
    let stale = false;
    setLoading(true); setError(null);
    api.search(guildId, q)
      .then((data) => { if (stale) return; setRows(Array.isArray(data) ? data : []); setSearched(true); setLoading(false); })
      .catch((e) => { if (stale) return; setError(e?.message || 'Search failed'); setLoading(false); });
    return () => { stale = true; };
  }, [urlQ, guildId]);

  function submit(e) { e.preventDefault(); const q = input.trim(); if (q) navigate(`/search?q=${encodeURIComponent(q)}`); }

  return (
    <Page max="820px">
      <PageHead title="Search" subtitle="Full-text search across every recorded transcript." />

      <form onSubmit={submit} className="relative mb-7">
        <Icon.Search width={18} height={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Search words or phrases…" autoFocus
          className="input !pl-11 !py-3 text-[15px]" />
      </form>

      {loading ? <SearchSkeleton />
        : error ? <Empty icon={Icon.Search} title="Search failed" body={error} />
        : searched && rows.length === 0 ? (
          <Empty icon={Icon.Search} title={`No matches${urlQ ? ` for "${urlQ}"` : ''}`} body="Try different keywords or a shorter phrase." />
        ) : rows.length > 0 ? (
          <>
            <p className="text-xs text-muted mb-2 px-1">{rows.length} {rows.length === 1 ? 'result' : 'results'}</p>
            <ul className="card p-1 divide-y divide-border">
              {rows.map((row) => <ResultRow key={row.id} row={row} q={urlQ} />)}
            </ul>
          </>
        ) : (
          <Empty icon={Icon.Search} title="Search your meetings" body="Find any moment by what was said. Results link straight to the meeting." />
        )}
    </Page>
  );
}
