// The Wiki tab: an index to browse and search, a page to read and edit, and the link map. People's apps and
// the host share it; the host passes `big` for the larger type.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useLayout } from "../client/mobile";
import { api } from "../shared/hub";
import { filesFrom, hasFiles, checkFile, uploadAttachment } from "../shared/attach";
import { isTypingTarget, plain } from "../shared/keys";
import { followsNatively, onWikiOpen, takePendingWikiPage } from "./nav";
import { drafts, onRefresh, restore, saveRev, track } from "./draft";
import { GraphCanvas } from "./GraphCanvas";
import { localGraph, localOf } from "./graph";
import { dropTitle, plainText, renderMarkdown } from "./markdown";
import { freshHits, wikiApi, useWiki, type WikiData } from "./wikiApi";
import { CATEGORIES, CATEGORY_COLOR, CATEGORY_LABEL, type Category, type LogEntry, type PageMeta, type SearchHit, type SourceText, type WikiPage } from "./types";
import "./wiki.css";

type Open = { kind: "graph" } | { kind: "page"; slug: string };
type Dialog = null | { kind: "add" } | { kind: "history"; slug: string | null } | { kind: "source"; id: string; at: string | null };

const pretty = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const when = (ts: number) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function WikiView({ big }: { big?: boolean }) {
  const layout = useLayout();
  const phone = layout !== "desktop";
  const wiki = useWiki();
  const [open, setOpen] = useState<Open>({ kind: "graph" });
  const [trail, setTrail] = useState<Open[]>([]);
  const [q, setQ] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [listOnPhone, setListOnPhone] = useState(true);
  const search = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  const go = useCallback(
    (next: Open) => {
      setTrail((t) => [...t.slice(-30), open]);
      setOpen(next);
      setListOnPhone(false);
    },
    [open],
  );
  const back = useCallback(() => {
    setTrail((t) => {
      const prev = t[t.length - 1];
      if (prev) setOpen(prev);
      else setListOnPhone(true);
      return t.slice(0, -1);
    });
  }, []);
  const openPage = useCallback((slug: string) => go({ kind: "page", slug }), [go]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!plain(e) && !(e.altKey && e.key === "ArrowLeft")) return;
      if (dialog) return;
      if (e.altKey && e.key === "ArrowLeft") return void (e.preventDefault(), back());
      if (isTypingTarget(e)) return;
      if (e.key === "/") return void (e.preventDefault(), search.current?.focus());
      if (e.key === "g") return go({ kind: "graph" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back, go, dialog]);

  // Asked for a page from outside (the Work tab's links), now or just before this tab opened.
  useEffect(() => {
    const take = () => {
      const slug = takePendingWikiPage();
      if (slug === null) return;
      if (slug) openPage(slug);
      else go({ kind: "graph" });
    };
    take();
    return onWikiOpen(take);
  }, [openPage, go]);

  const pageSet = useMemo(() => new Set(wiki.pages.map((p) => p.slug)), [wiki.pages]);
  const empty = !wiki.loading && !wiki.pages.length;
  const showMain = !phone || !listOnPhone;
  const showList = !phone || listOnPhone;

  return (
    <div ref={root} className={`wk ${big ? "big" : ""} ${phone ? "phone" : ""}`}>
      {showList && (
        <aside className="wk-side" aria-label="Wiki index">
          <Index wiki={wiki} q={q} setQ={setQ} search={search} current={open.kind === "page" ? open.slug : null} onOpen={openPage} onGraph={() => go({ kind: "graph" })} onAdd={() => setDialog({ kind: "add" })} graphOn={open.kind === "graph"} />
        </aside>
      )}
      {showMain && (
        <section className="wk-main">
          {phone && (
            <div className="wk-bar">
              <button className="btn ghost small" onClick={back}>← Index</button>
              <span className="grow" />
              <button className="btn ghost small" onClick={() => setDialog({ kind: "history", slug: open.kind === "page" ? open.slug : null })}>History</button>
            </div>
          )}
          {empty ? (
            <Empty ready={wiki.ready} error={wiki.error} onAdd={() => setDialog({ kind: "add" })} />
          ) : open.kind === "graph" ? (
            <GraphPane wiki={wiki} phone={phone} onOpen={openPage} />
          ) : (
            <PageView
              key={open.slug}
              slug={open.slug}
              wiki={wiki}
              pageSet={pageSet}
              phone={phone}
              onOpen={openPage}
              onBack={trail.length ? back : undefined}
              onSource={(id, at) => setDialog({ kind: "source", id, at })}
              onHistory={() => setDialog({ kind: "history", slug: open.slug })}
            />
          )}
        </section>
      )}
      {dialog?.kind === "add" && <AddDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "history" && <HistoryDialog slug={dialog.slug} pages={wiki.pages} onClose={() => setDialog(null)} onOpen={(s) => (setDialog(null), openPage(s))} />}
      {dialog?.kind === "source" && <SourceDialog id={dialog.id} at={dialog.at} onClose={() => setDialog(null)} />}
    </div>
  );
}

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function Index({ wiki, q, setQ, search, current, onOpen, onGraph, onAdd, graphOn }: { wiki: WikiData; q: string; setQ: (s: string) => void; search: React.RefObject<HTMLInputElement | null>; current: string | null; onOpen: (s: string) => void; onGraph: () => void; onAdd: () => void; graphOn: boolean }) {
  const dq = useDebounced(q.trim(), 200);
  // The server's answer is kept with the words it answered; it is shown (and Enter opens its first hit) only while those are what is typed.
  const [answer, setAnswer] = useState<{ q: string; hits: SearchHit[] } | null>(null);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    if (dq.length < 2) return void setAnswer(null);
    let live = true;
    wikiApi.search(dq).then(
      (r) => live && (setAnswer({ q: dq, hits: r }), setOffline(false)),
      () => live && (setAnswer(null), setOffline(true)), // a failed search shows no hits, not the last query's
    );
    return () => void (live = false);
  }, [dq]);
  const hits = freshHits(answer, q);
  // Until the server answers (or if it can't), titles and summaries are searched here.
  const local = useMemo(() => {
    const w = q.trim().toLowerCase();
    return w ? wiki.pages.filter((p) => `${p.title} ${p.summary}`.toLowerCase().includes(w)) : wiki.pages;
  }, [q, wiki.pages]);
  const groups = useMemo(
    () => CATEGORIES.map((c) => ({ c, items: local.filter((p) => p.category === c).sort((a, b) => a.title.localeCompare(b.title)) })).filter((g) => g.items.length),
    [local],
  );
  const list = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...(list.current?.querySelectorAll<HTMLElement>(".wk-item") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = items[e.key === "ArrowDown" ? Math.min(items.length - 1, i + 1) : i - 1];
    e.preventDefault();
    if (next) next.focus();
    else if (i <= 0) search.current?.focus();
  };

  return (
    <div className="wk-index">
      <div className="wk-side-head">
        <input
          ref={search}
          className="wk-search"
          type="search"
          placeholder="Search the wiki"
          aria-label="Search the wiki"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), list.current?.querySelector<HTMLElement>(".wk-item")?.focus());
            if (e.key === "Escape") (setQ(""), search.current?.blur());
            if (e.key === "Enter") { const first = hits ? hits[0] : local[0]; if (first) onOpen(first.slug); } // (an answered search that found nothing opens nothing, not the local fallback)
          }}
        />
        <div className="wk-actions">
          <button className={`btn small ${graphOn ? "on-soft" : ""}`} onClick={onGraph} aria-pressed={graphOn}>Graph</button>
          <button className="btn small" onClick={onAdd}>Add to wiki</button>
        </div>
      </div>
      <div className="wk-list scrollbars-thin" ref={list} onKeyDown={onKey}>
        {wiki.loading && !wiki.pages.length && <div className="wk-note">Loading the wiki…</div>}
        {wiki.error && !wiki.pages.length && <div className="wk-note warn">{wiki.error} <button className="btn ghost small" onClick={wiki.reload}>Try again</button></div>}
        {hits && dq.length >= 2 ? (
          hits.length ? (
            hits.map((h) => (
              <button key={h.slug} className={`wk-hit ${h.slug === current ? "on" : ""}`} onClick={() => onOpen(h.slug)}>
                <span className="wk-dot" style={{ background: CATEGORY_COLOR[h.category] }} />
                <span className="wk-hit-t">
                  <b>{h.title}</b>
                  <small>{plainText(h.snippet, 140)}</small>
                </span>
              </button>
            ))
          ) : (
            <div className="wk-note">Nothing matches “{dq}”.</div>
          )
        ) : (
          groups.map((g) => (
            <div key={g.c} className="wk-group">
              <div className="wk-group-h">
                <span className="wk-dot" style={{ background: CATEGORY_COLOR[g.c] }} />
                {CATEGORY_LABEL[g.c]}
                <span className="wk-count">{g.items.length}</span>
              </div>
              {g.items.map((p) => (
                <button key={p.slug} className={`wk-item ${p.slug === current ? "on" : ""}`} onClick={() => onOpen(p.slug)} aria-current={p.slug === current ? "page" : undefined}>
                  <span className="ellipsis">{p.title}</span>
                  {p.backlinks > 0 && <span className="wk-bl" title={`${p.backlinks} backlink${p.backlinks === 1 ? "" : "s"}`}>{p.backlinks}</span>}
                </button>
              ))}
            </div>
          ))
        )}
        {!hits && q.trim() && !groups.length && <div className="wk-note">Nothing matches “{q.trim()}”.</div>}
        {offline && dq.length >= 2 && <div className="wk-note">Searching titles only; the full search isn't answering.</div>}
        {wiki.history.off && <div className="wk-note">The wiki isn't keeping a version history{wiki.history.why ? `: ${wiki.history.why}` : ""}. Pages still save.</div>}
      </div>
    </div>
  );
}

function Empty({ ready, error, onAdd }: { ready: boolean; error: string | null; onAdd: () => void }) {
  return (
    <div className="wk-empty">
      <svg width="132" height="92" viewBox="0 0 132 92" fill="none" aria-hidden>
        <g stroke="rgba(165,172,188,.28)" strokeWidth="1.2">
          <path d="M26 58 52 30M52 30 92 40M92 40 108 70M52 30 70 66M70 66 108 70M26 58 70 66" />
        </g>
        {[[26, 58, 6, "#ffb54a"], [52, 30, 8, "#b49cff"], [92, 40, 6, "#45e0a0"], [108, 70, 5, "#7cc4ff"], [70, 66, 7, "#ff8f7a"]].map(([x, y, r, c]) => (
          <circle key={`${x}${y}`} cx={x as number} cy={y as number} r={r as number} fill={c as string} opacity=".55" />
        ))}
      </svg>
      <h2>{error ? "The wiki didn't load" : ready ? "The first pages are on their way" : "Nothing in the wiki yet"}</h2>
      <p>
        {error
          ? error
          : ready
            ? "JamSesh has sources to read. When it proposes pages they wait on the Tasks board for you to approve."
            : "JamSesh builds it from what the room says and what the agents ship. Add a document, a link or your notes to start it off."}
      </p>
      {!error && (
        <button className="btn primary" onClick={onAdd}>Add to wiki</button>
      )}
    </div>
  );
}

function GraphPane({ wiki, phone, onOpen }: { wiki: WikiData; phone: boolean; onOpen: (s: string) => void }) {
  const counts = useMemo(() => CATEGORIES.map((c) => ({ c, n: wiki.graph.nodes.filter((x) => x.category === c).length })).filter((x) => x.n), [wiki.graph]);
  return (
    <div className="wk-graph">
      <GraphCanvas graph={wiki.graph} mode="full" coarse={phone} onOpen={onOpen} />
      <ul className="wk-legend" aria-label="Page types">
        {counts.map(({ c, n }) => (
          <li key={c}>
            <span className="wk-dot" style={{ background: CATEGORY_COLOR[c] }} />
            {CATEGORY_LABEL[c]} <span className="wk-count">{n}</span>
          </li>
        ))}
      </ul>
      <div className="wk-hint">
        <span>{phone ? "Tap a dot to look, tap again to open." : "Hover to see what a page links with. Click to open. Press / to search."}</span>
        <button className="btn small" onClick={() => api("/stage", { mode: "wiki", pinned: true, by: "Someone in the room" })} title="Put the graph on the big screen">On the big screen</button>
      </div>
    </div>
  );
}

const blankPage = (slug: string): WikiPage => ({ slug, title: slug.replace(/-/g, " "), category: "topics", frontMatter: {}, markdown: "", rev: "", backlinks: [], links: [], sources: [] });

function PageView({ slug, wiki, pageSet, phone, onOpen, onBack, onSource, onHistory }: { slug: string; wiki: WikiData; pageSet: Set<string>; phone: boolean; onOpen: (s: string) => void; onBack?: () => void; onSource: (id: string, at: string | null) => void; onHistory: () => void }) {
  const [page, setPage] = useState<WikiPage | null>(null);
  const [err, setErr] = useState<{ status?: number; message: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(() => restore(slug).editing);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const [conflict, setConflict] = useState<WikiPage | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  // The revision the open edit started from. A refresh never changes it (draft.ts).
  const [base, setBase] = useState(() => restore(slug).base);
  const meta = wiki.pages.find((p) => p.slug === slug);
  const draft = useRef({ editing, base });
  draft.current = { editing, base: drafts.get(slug)?.base ?? base };
  const begin = (text: string, rev: string) => (drafts.hold(slug, text, rev), setEditing(text), setBase(rev), setConflict(null));
  // The edit is kept outside this view (draft.ts): leaving the page any way at all leaves it there.
  // A save made from another view of this page settles this one's draft too.
  useEffect(() => {
    // One that settled it between this render and now is caught here: the view started from a draft that is no longer held.
    if (editing !== null && !drafts.get(slug)) (setEditing(null), setConflict(null));
    return drafts.listen(slug, (o) => {
      const held = drafts.get(slug);
      if (o === "cleared") (setEditing(null), setConflict(null));
      else if (held) (setEditing(held.text), setBase(held.base));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per page: `editing` here is the draft this view started from
  }, [slug]);
  // What is typed is held. The first run is the draft the view started from: already held (or already settled by a save), never held again.
  const started = useRef(true);
  useEffect(() => {
    if (started.current) return void (started.current = false);
    track(slug, editing, drafts.get(slug)?.base ?? base); // the held revision is the truth: a save answered meanwhile moved it
  }, [slug, editing, base]);
  useEffect(() => {
    let live = true;
    wikiApi.page(slug).then(
      (p) => {
        if (!live) return;
        const r = onRefresh(draft.current.editing !== null, draft.current.base, p);
        // A page reopened into a held draft still loads: the draft decides what the editor shows, never whether there is a page.
        setPage((cur) => r.page ?? cur ?? p); // a refresh that left the open page alone keeps it; a view reopened into a draft has none yet, so it gets this one
        if (r.theirs) setConflict(r.theirs);
        setErr(null);
      },
      (e) => {
        if (!live) return;
        // A draft of a page nobody has saved yet: straight into the editor, not the "no page" screen.
        if (e?.status === 404 && draft.current.editing !== null) return void (setPage((cur) => cur ?? blankPage(slug)), setErr(null));
        setErr({ status: e?.status, message: pretty(e, "Couldn't open this page.") });
      },
    );
    return () => void (live = false);
  }, [slug, wiki.version]);

  const sources = useMemo(() => new Set(page?.sources.map((s) => s.id) ?? []), [page]);
  const html = useMemo(() => (page ? renderMarkdown(dropTitle(page.markdown, page.title), { pages: pageSet, sources }) : ""), [page, pageSet, sources]);
  const local = useMemo(() => (page ? localOf(page, wiki.pages) : localGraph(wiki.graph, slug)), [page, wiki.pages, wiki.graph, slug]);

  const clicked = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    if (a.classList.contains("wl")) {
      e.preventDefault();
      const s = a.getAttribute("data-slug") ?? "";
      onOpen(s);
    } else if (a.classList.contains("cite")) {
      e.preventDefault();
      onSource(a.getAttribute("data-src") ?? "", a.getAttribute("data-at"));
    } else if (!followsNatively(a.getAttribute("href"))) e.preventDefault();
  };

  const save = async (keepMine = false) => {
    if (editing === null || inFlight.current) return; // one save at a time, whichever way it was asked for (button or keyboard)
    inFlight.current = true;
    const sent = drafts.edit(slug); // which edit this save carries; typing while it is out is a later one
    setSaving(true);
    setSaveErr(null);
    try {
      const r = await wikiApi.save(slug, { markdown: editing, rev: saveRev(drafts.get(slug)?.base ?? base, conflict, keepMine) });
      if ("conflict" in r) return void (setConflict(r.conflict), (inFlight.current = false), setSaving(false));
      setPage(r.page);
      setConflict(null);
      // Settled in the store, so it holds whether or not this view is still on screen.
      const outcome = drafts.saved(slug, sent, r.page.rev);
      if (outcome === "cleared") setEditing(null);
      else if (outcome === "rebased") setBase(r.page.rev);
      wiki.reload();
    } catch (e) {
      setSaveErr(pretty(e, "Couldn't save. Your edit is still here."));
    }
    inFlight.current = false;
    setSaving(false);
  };

  if (err && !page) {
    return (
      <div className="wk-empty">
        <h2>{err.status === 404 ? "No page called this yet" : "Couldn't open this page"}</h2>
        <p>{err.status === 404 ? "Someone linked to it before it was written. You can start it." : err.message}</p>
        {err.status === 404 ? (
          <button className="btn primary" onClick={() => (setErr(null), setPage(blankPage(slug)), begin("", ""))}>Start this page</button>
        ) : (
          <button className="btn" onClick={wiki.reload}>Try again</button>
        )}
      </div>
    );
  }
  if (!page) return <div className="wk-empty"><p>Opening…</p></div>;

  const cat = (meta?.category ?? page.category) as Category;
  return (
    <div className="wk-page scrollbars-thin">
      <article className="wk-article">
        <div className="wk-crumb">
          {onBack && !phone && <button className="btn ghost small" onClick={onBack}>← Back</button>}
          <span className="wk-cat" style={{ ["--c" as any]: CATEGORY_COLOR[cat] }}>{CATEGORY_LABEL[cat]}</span>
          {page.frontMatter.updated && <span className="wk-upd">Updated {page.frontMatter.updated}</span>}
          <span className="grow" />
          {!phone && <button className="btn ghost small" onClick={onHistory}>History</button>}
          {editing === null && <button className="btn small" onClick={() => begin(page.markdown, page.rev)}>Edit</button>}
        </div>
        <h1 className="wk-title">{page.title}</h1>
        {editing !== null ? (
          <Editor
            value={editing}
            onChange={setEditing}
            onSave={() => void save(!!conflict)}
            onCancel={() => (conflict && setPage(conflict), setEditing(null), setConflict(null), setSaveErr(null))}
            saving={saving}
            dirty={editing !== page.markdown}
            conflict={conflict}
            onTheirs={() => conflict && (setPage(conflict), begin(conflict.markdown, conflict.rev))}
            error={saveErr}
          />
        ) : page.markdown.trim() ? (
          <div className="wk-body" onClick={clicked} dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <p className="wk-blank">This page is empty. <button className="btn ghost small" onClick={() => begin("", page.rev)}>Write it</button></p>
        )}
        {page.sources.length > 0 && (
          <section className="wk-sec">
            <h3 className="label">Sources</h3>
            <ul className="wk-chips">
              {page.sources.filter((s) => s.kind !== "edit").map((s) => (
                <li key={s.id}>
                  <button className={`wk-chip ${s.exists ? "" : "gone"}`} disabled={!s.exists} onClick={() => onSource(s.id, null)} title={s.exists ? "Open the source" : "This source was removed"}>
                    <small>{s.kind}</small> {s.title}
                  </button>
                </li>
              ))}
              {page.sources.some((s) => s.kind === "edit") && (
                <li className="wk-quiet">
                  {page.sources.filter((s) => s.kind === "edit").length} edit{page.sources.filter((s) => s.kind === "edit").length === 1 ? "" : "s"} by people, in History
                </li>
              )}
            </ul>
          </section>
        )}
        <section className="wk-sec">
          <h3 className="label">Backlinks{page.backlinks.length ? ` · ${page.backlinks.length}` : ""}</h3>
          {page.backlinks.length ? (
            <ul className="wk-chips">
              {page.backlinks.map((b) => (
                <li key={b.slug}>
                  <button className="wk-chip" onClick={() => onOpen(b.slug)}>{b.title}</button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="wk-quiet">No page links here yet.</p>
          )}
        </section>
        {local.nodes.length > 1 && (
          <section className="wk-sec">
            <h3 className="label">Around this page</h3>
            <div className="wk-local">
              <GraphCanvas graph={local} mode="local" focus={slug} coarse={phone} onOpen={(s) => s !== slug && onOpen(s)} label={`Pages linked with ${page.title}`} />
            </div>
          </section>
        )}
      </article>
    </div>
  );
}

function Editor({ value, onChange, onSave, onCancel, saving, dirty, conflict, onTheirs, error }: { value: string; onChange: (s: string) => void; onSave: () => void; onCancel: () => void; saving: boolean; dirty: boolean; conflict: WikiPage | null; onTheirs: () => void; error: string | null }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ta.current?.focus();
  }, []);
  return (
    <div className="wk-edit">
      {conflict && (
        <div className="wk-banner">
          Someone saved this page while you were editing. <button className="btn small" onClick={onTheirs}>Use their version</button>
          <span> or save yours over it.</span>
        </div>
      )}
      <textarea
        ref={ta}
        value={value}
        spellCheck
        aria-label="Page text, in Markdown"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") (e.preventDefault(), onSave());
          if (e.key === "Escape") (e.preventDefault(), !dirty || confirm("Throw away your changes?") ? onCancel() : undefined);
        }}
      />
      <div className="wk-edit-bar">
        <span className="wk-quiet wk-edit-hint">Markdown. Link pages with [[name]]. Your edit is logged as a source.</span>
        <span className="grow" />
        {error && <span className="wk-err">{error}</span>}
        <button className="btn ghost small" onClick={onCancel}>Cancel</button>
        <button className="btn primary small" onClick={onSave} disabled={saving || (!dirty && !conflict)}>{saving ? "Saving…" : conflict ? "Save over theirs" : "Save"}</button>
      </div>
    </div>
  );
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const was = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("keydown", onKey, true);
    return () => (window.removeEventListener("keydown", onKey, true), was?.focus?.());
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal-wrap">
        <div className={`modal wk-modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} ref={box} tabIndex={-1}>
          <div className="wk-modal-h">
            <h2>{title}</h2>
            <button className="btn ghost small" onClick={onClose} aria-label="Close">✕</button>
          </div>
          {children}
        </div>
      </div>
    </>
  );
}

type AddMode = "write" | "link" | "file";

function AddDialog({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<AddMode>("write");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<{ name: string; file: File } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const take = (files: File[]) => {
    const f = files[0];
    if (!f) return;
    const problem = checkFile(f);
    if (problem) return setErr(problem);
    if (/^image\//.test(f.type)) return setErr("The wiki takes Markdown, text, PDFs and links.");
    setErr(null);
    setFile({ name: f.name, file: f });
    if (!title) setTitle(f.name.replace(/\.[a-z0-9]+$/i, ""));
  };
  const ok = mode === "write" ? text.trim().length > 0 : mode === "link" ? /^https?:\/\/\S+$/i.test(url.trim()) : !!file;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (mode === "write") await wikiApi.addSource({ title: title.trim() || undefined, text });
      else if (mode === "link") await wikiApi.addSource({ title: title.trim() || undefined, url: url.trim() });
      else if (file) {
        const f = file.file;
        if (/\.pdf$/i.test(f.name) || f.type === "application/pdf") {
          const ref = await uploadAttachment(f);
          await wikiApi.addSource({ title: title.trim() || undefined, attachment: ref.id });
        } else await wikiApi.addSource({ title: title.trim() || undefined, text: await f.text() });
      }
      setDone(true);
    } catch (e) {
      setErr(pretty(e, "Couldn't add that. Try again."));
    }
    setBusy(false);
  };

  return (
    <Modal title="Add to wiki" onClose={onClose}>
      {done ? (
        <div className="wk-done">
          <p>Added. JamSesh will read it and fold what matters into the pages. You'll see a card in Tasks when there's something to approve.</p>
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      ) : (
        <div
          className={`wk-add ${over ? "over" : ""}`}
          onDragOver={(e) => hasFiles(e as any) && (e.preventDefault(), setOver(true), setMode("file"))}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            if (!hasFiles(e as any)) return;
            e.preventDefault();
            setOver(false);
            take(filesFrom(e.dataTransfer));
          }}
        >
          <div className="wk-seg" role="tablist" aria-label="What to add">
            {([["write", "Write or paste"], ["link", "A link"], ["file", "A file"]] as const).map(([m, label]) => (
              <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>{label}</button>
            ))}
          </div>
          <input placeholder="Title (optional)" aria-label="Title" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
          {mode === "write" && <textarea placeholder="Meeting notes, a decision, a brief. Markdown is fine." aria-label="Text to add" value={text} onChange={(e) => setText(e.target.value)} autoFocus />}
          {mode === "link" && <input placeholder="https://" aria-label="Link" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus inputMode="url" />}
          {mode === "file" && (
            <button className="wk-drop" onClick={() => input.current?.click()}>
              {file ? <b>{file.name}</b> : <b>Choose a file, or drop one here</b>}
              <small>Markdown, text or PDF</small>
              <input ref={input} type="file" hidden accept="application/pdf,text/*,.md,.markdown,.txt" onChange={(e) => (take([...(e.target.files ?? [])]), (e.target.value = ""))} />
            </button>
          )}
          {err && <div className="wk-err" role="alert">{err}</div>}
          <div className="wk-edit-bar">
            <span className="grow" />
            <button className="btn ghost small" onClick={onClose}>Cancel</button>
            <button className="btn primary small" disabled={!ok || busy} onClick={() => void submit()}>{busy ? "Adding…" : "Add"}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function HistoryDialog({ slug, pages, onClose, onOpen }: { slug: string | null; pages: PageMeta[]; onClose: () => void; onOpen: (s: string) => void }) {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [all, setAll] = useState(!slug);
  useEffect(() => {
    wikiApi.log().then(setEntries, (e) => setErr(pretty(e, "Couldn't load the history.")));
  }, []);
  const titles = useMemo(() => new Map(pages.map((p) => [p.slug, p.title])), [pages]);
  const shown = (entries ?? []).filter((e) => all || !slug || e.pages.includes(slug));
  return (
    <Modal title="Wiki history" onClose={onClose} wide>
      {slug && (
        <div className="wk-seg small">
          <button className={!all ? "on" : ""} onClick={() => setAll(false)}>This page</button>
          <button className={all ? "on" : ""} onClick={() => setAll(true)}>Everything</button>
        </div>
      )}
      {err ? <div className="wk-err">{err}</div> : !entries ? <p className="wk-quiet">Loading…</p> : !shown.length ? <p className="wk-quiet">Nothing logged yet.</p> : (
        <ol className="wk-log">
          {shown.map((e, i) => (
            <li key={`${e.ts}-${i}`}>
              <time>{when(e.ts)}</time>
              <span>{e.text}</span>
              <span className="wk-chips inline">
                {e.pages.slice(0, 6).map((s) => (
                  <button key={s} className="wk-chip" onClick={() => onOpen(s)}>{titles.get(s) ?? s}</button>
                ))}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

const WINDOW = 300;

/** The stretch of a long source on screen: WINDOW lines around the cited moment (or from the top), grown a window at a time. */
export function sourceWindow(total: number, hit: number, grown?: [number, number]): [number, number] {
  if (grown) return [Math.max(0, grown[0]), Math.min(total, grown[1])];
  const from = Math.max(0, Math.min(hit < 0 ? 0 : hit - WINDOW / 2, total - WINDOW));
  return [from, Math.min(total, from + WINDOW)];
}

function SourceDialog({ id, at, onClose }: { id: string; at: string | null; onClose: () => void }) {
  const [src, setSrc] = useState<SourceText | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const mark = useRef<HTMLElement | null>(null);
  useEffect(() => {
    wikiApi.source(id).then(setSrc, (e) => setErr(e?.status === 404 ? "This source is no longer in the project." : pretty(e, "Couldn't open the source.")));
  }, [id]);
  const every = useMemo(() => (src?.text ?? "").split("\n"), [src]);
  const [grown, setGrown] = useState<[number, number] | null>(null);
  // A transcript line starts "[14:32] Name: …"; the cited moment is the first line at or after the time given.
  const hit = useMemo(() => {
    if (!at) return -1;
    const want = at.length === 4 ? `0${at}` : at;
    return every.findIndex((l) => l.startsWith(`[${at}`) || l.startsWith(`[${want}`));
  }, [every, at]);
  // Only a window of a long source is drawn (a transcript can run to tens of thousands of lines), around the cited moment.
  const [from, to] = sourceWindow(every.length, hit, grown ?? undefined);
  useEffect(() => {
    mark.current?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [src, hit]);
  return (
    <Modal title={src?.title ?? "Source"} onClose={onClose} wide>
      {err ? <div className="wk-err">{err}</div> : !src ? <p className="wk-quiet">Opening…</p> : (
        <>
          <div className="wk-src-meta"><span className="wk-chip static"><small>{src.kind}</small></span> {when(src.ts)}</div>
          <div className="wk-src scrollbars-thin" tabIndex={0}>
            {from > 0 && <button className="btn ghost small" onClick={() => setGrown([from - WINDOW, to])}>Show {Math.min(WINDOW, from)} earlier lines</button>}
            {every.slice(from, to).map((l, k) => (
              <div key={from + k} className={from + k === hit ? "hit" : ""} ref={from + k === hit ? (el) => void (mark.current = el) : undefined}>{l || " "}</div>
            ))}
            {to < every.length && <button className="btn ghost small" onClick={() => setGrown([from, to + WINDOW])}>Show {Math.min(WINDOW, every.length - to)} more lines</button>}
          </div>
          {(from > 0 || to < every.length) && <p className="wk-quiet">Showing lines {from + 1} to {to} of {every.length}.</p>}
          {at && hit < 0 && <p className="wk-quiet">The moment at {at} isn't marked in this source.</p>}
        </>
      )}
    </Modal>
  );
}
