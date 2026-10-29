import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import "./projects.css";

export interface ProjectCard {
  name: string;
  slug: string;
  created: number;
  lastUsed: number;
  people: { name: string; color?: string }[];
  sessions: number;
  thumbnailAt: number | null;
  resumable: boolean;
}

interface Bridge {
  invoke(cmd: string, args: Record<string, unknown>): Promise<unknown>;
}
const bridge = () => (globalThis as { __TAURI_INTERNALS__?: Bridge }).__TAURI_INTERNALS__;

const FALLBACK = ["#b49cff", "#45e0a0", "#ffb54a", "#7cc4ff", "#ff6b5e", "#ff8fc8"];
const hue = (s: string) => FALLBACK[[...s].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % FALLBACK.length];

export function when(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86_400_000);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days <= 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString([], sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

function People({ people }: { people: ProjectCard["people"] }) {
  if (!people.length) return <span className="pj-nobody">No one yet</span>;
  const shown = people.slice(0, 4);
  return (
    <span className="pj-people" title={people.map((p) => p.name).join(", ")}>
      <span className="pj-faces" aria-hidden>
        {shown.map((p) => (
          <i key={p.name} style={{ background: p.color || hue(p.name) }}>
            {[...p.name.trim()][0]?.toUpperCase()}
          </i>
        ))}
      </span>
      <span>{people.length === 1 ? people[0].name : people.length <= 2 ? people.map((p) => p.name).join(" and ") : `${people[0].name} and ${people.length - 1} more`}</span>
    </span>
  );
}

function Thumb({ p, tag }: { p: ProjectCard; tag: { text: string; now?: boolean } | null }) {
  const [failed, setFailed] = useState(false);
  const c = hue(p.slug);
  return (
    <span className="pj-frame">
      {p.thumbnailAt && !failed ? (
        <img className="pj-thumb" src={`/api/projects/${p.slug}/thumbnail.png?v=${Math.round(p.thumbnailAt)}`} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className="pj-thumb pj-blank" style={{ background: `linear-gradient(135deg, ${c}22, ${c}08)` }}>
          <span style={{ color: c }}>{[...p.name.trim()][0]?.toUpperCase() ?? "?"}</span>
        </span>
      )}
      {tag && <em className={`pj-tag${tag.now ? " now" : ""}`}>{tag.text}</em>}
    </span>
  );
}

/** The Projects picker: recent projects with a canvas thumbnail, the people who came, and New project. */
export function ProjectsView({ now = Date.now() }: { now?: number }) {
  const [projects, setProjects] = useState<ProjectCard[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [naming, setNaming] = useState(() => new URLSearchParams(location.search).has("new"));
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [hint, setHint] = useState("");
  const grid = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/projects")
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? "Couldn't read the projects.");
        setProjects(j.projects);
        setCurrent(j.current);
      })
      .catch((e) => {
        setProjects([]);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => {
    if (!projects) return;
    if (naming || projects.length === 0) input.current?.focus();
    else (grid.current?.querySelector<HTMLElement>("[data-project]") ?? grid.current?.querySelector<HTMLElement>("[data-card]"))?.focus();
  }, [projects === null, naming, projects?.length === 0]);

  const open = useCallback(async (choice: { slug: string } | { name: string }, label: string) => {
    setBusy(label);
    setError("");
    setHint("");
    try {
      const b = bridge();
      if (b) return void (await b.invoke("open_project", choice));
      const r = await fetch("/api/projects/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(choice) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "That didn't work.");
      setHint(`To host it, run: ${j.command}`);
      setBusy(null);
    } catch (e) {
      setBusy(null);
      setError(typeof e === "string" ? e : e instanceof Error ? e.message : "That didn't work.");
    }
  }, []);

  const submit = () => {
    const n = name.trim();
    if (n) void open({ name: n }, n);
  };

  // Arrow keys move between cards by their place on screen; Enter opens the focused one.
  const move = (e: KeyboardEvent) => {
    const keys: Record<string, [number, number]> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
    const step = keys[e.key];
    const items = [...(grid.current?.querySelectorAll<HTMLElement>("[data-card]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (!step || at < 0) return;
    e.preventDefault();
    if (step[1] === 0) return void items[Math.max(0, Math.min(items.length - 1, at + step[0]))]?.focus();
    const here = items[at].getBoundingClientRect();
    const rows = items
      .map((el, i) => ({ el, i, r: el.getBoundingClientRect() }))
      .filter(({ r }) => (step[1] > 0 ? r.top > here.top + 4 : r.top < here.top - 4))
      .sort((a, b) => (step[1] > 0 ? a.r.top - b.r.top : b.r.top - a.r.top));
    const row = rows.filter(({ r }) => Math.abs(r.top - rows[0]?.r.top) < 4);
    row.sort((a, b) => Math.abs(a.r.left - here.left) - Math.abs(b.r.left - here.left))[0]?.el.focus();
  };

  const onPage = (e: KeyboardEvent) => {
    if (e.key === "Escape" && naming && projects?.length) setNaming(false);
    else if ((e.key === "n" || e.key === "N") && !naming && !e.metaKey && !e.ctrlKey && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      setNaming(true);
    }
  };

  const empty = projects !== null && projects.length === 0;

  return (
    <div className={`pj${empty ? " is-empty" : ""}`} onKeyDown={onPage}>
      <div className="pj-drag" data-tauri-drag-region />
      <div className="pj-inner">
        <header className="pj-head">
          <p className="pj-eyebrow">JamSesh</p>
          <h1>{empty ? "Start your first project" : "Projects"}</h1>
          <p className="pj-lede">{empty ? "A project keeps every session on the same work together: the canvas, who was there, and what the room decided." : "Pick up where you left off, or start something new. Opening a project starts a new session in it, or continues today's."}</p>
        </header>

        {error && <p className="pj-error" role="alert">{error}</p>}
        {hint && <p className="pj-hint"><code>{hint.replace("To host it, run: ", "")}</code><span>Run this in a terminal to host that project.</span></p>}

        {projects === null ? (
          <p className="pj-loading">Looking for your projects…</p>
        ) : (
          <div className={`pj-grid${empty ? " is-empty" : ""}`} ref={grid} onKeyDown={move}>
            {naming || empty ? (
              <form className="pj-card pj-new is-naming" onSubmit={(e) => (e.preventDefault(), submit())}>
                <label htmlFor="pj-name">Project name</label>
                <input id="pj-name" ref={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Passport redesign" autoComplete="off" spellCheck={false} />
                <div className="pj-row">
                  <button type="submit" className="pj-go" disabled={!name.trim() || !!busy}>Create</button>
                  {!empty && (
                    <button type="button" className="pj-quiet" onClick={() => setNaming(false)}>
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            ) : (
              <button className="pj-card pj-new" data-card onClick={() => setNaming(true)}>
                <span className="pj-plus" aria-hidden>+</span>
                <strong>New project</strong>
                <span className="pj-sub">Just a name to begin</span>
              </button>
            )}
            {projects.map((p) => (
              <button key={p.slug} className="pj-card" data-card data-project disabled={!!busy} onClick={() => void open({ slug: p.slug }, p.name)} aria-label={`${p.name}. ${p.resumable ? "Continues today's session." : "Starts a new session."}`}>
                <Thumb p={p} tag={current === p.slug ? { text: "Open now", now: true } : p.resumable ? { text: "Continues today" } : null} />
                <span className="pj-body">
                  <strong title={p.name}>{p.name}</strong>
                  <span className="pj-meta">
                    {p.lastUsed ? `Used ${when(p.lastUsed, now)}` : "Not used yet"} · {p.sessions === 1 ? "1 session" : `${p.sessions} sessions`}
                  </span>
                  <span className="pj-foot">
                    <People people={p.people} />
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {busy && (
        <div className="pj-busy" role="status">
          <span className="pj-spin" />
          Opening {busy}…
        </div>
      )}
    </div>
  );
}
