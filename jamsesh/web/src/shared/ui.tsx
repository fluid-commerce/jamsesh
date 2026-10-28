import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import qrcode from "qrcode-generator";
import { ago, api, hub, useHub, type Agent, type Artifact, type HubState, type JamEvent, type Person } from "./hub";

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function initials(name: string) {
  const parts = name.replace(/'s\b.*/, "").trim().split(/\s+/);
  return (parts[0]?.[0] ?? "?").toUpperCase() + (parts[1]?.[0]?.toUpperCase() ?? "");
}

export function Avatar({ name, color, size = 28 }: { name: string; color: string; size?: number }) {
  return (
    <span className="avatar" style={{ background: color, width: size, height: size, fontSize: size * 0.42 }} title={name}>
      {initials(name)}
    </span>
  );
}

/** A person's or an agent's color: agents take their owner's. */
export function colorFor(state: HubState | null, ref: { personId?: string | null; agentId?: string | null; name?: string }): string {
  if (!state) return "#888";
  if (ref.agentId) {
    const a = state.agents.find((x) => x.id === ref.agentId);
    const p = state.people.find((x) => x.id === a?.ownerId);
    if (p) return p.color;
  }
  if (ref.personId) {
    const p = state.people.find((x) => x.id === ref.personId);
    if (p) return p.color;
  }
  if (ref.name) {
    const p = state.people.find((x) => ref.name!.toLowerCase().startsWith(x.name.toLowerCase().split(" ")[0]));
    if (p) return p.color;
  }
  return "#8a8f98";
}

// ---------- artifact tiles ----------

export function ScaledFrame({ src, width = 1280, height = 800, title }: { src: string; width?: number; height?: number; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(Math.min(el.clientWidth / width, el.clientHeight / height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, height]);
  return (
    <div ref={box} style={{ position: "absolute", inset: 18, overflow: "hidden", display: "grid", placeItems: "center" }}>
      <iframe
        src={src}
        title={title}
        style={{ position: "static", width, height, transform: `scale(${scale})`, transformOrigin: "center", flex: "none", border: 0, borderRadius: 10, background: "#fff" }}
      />
    </div>
  );
}

export function ArtifactTile({
  art,
  state,
  variant,
  fresh,
  onClick,
  big,
  live = true,
}: {
  art: Artifact;
  state: HubState;
  variant?: string;
  fresh?: boolean;
  onClick?: () => void;
  big?: boolean;
  live?: boolean;
}) {
  const color = colorFor(state, { agentId: art.agentId });
  const dev = state.devservers.find((d) => d.url === art.url);
  return (
    <div className={`tile ${art.stage} ${fresh ? "fresh" : ""} ${onClick ? "clickable" : ""}`} onClick={onClick}>
      {variant && <div className="variant">{variant}</div>}
      <div className="corner">
        {art.platform && art.platform !== "other" && <span className="badge neutral">{art.platform}</span>}
        <span className={`badge ${art.stage} ${art.kind === "devserver" ? "live" : ""}`}>{art.kind === "devserver" ? "Live build" : art.stage === "built" ? "Built" : "Mockup"}</span>
      </div>
      <div className="media" style={big ? { padding: 28 } : undefined}>
        {art.kind === "devserver" && art.url ? (
          live && dev?.up !== false ? (
            <ScaledFrame src={art.url} title={art.title} width={art.platform === "mobile" ? 390 : 1440} height={art.platform === "mobile" ? 844 : 900} />
          ) : (
            <div className="empty-note mono">{art.url} isn't answering</div>
          )
        ) : art.image ? (
          <img src={art.image} alt={art.title} loading="lazy" />
        ) : art.kind === "html" ? null : (
          <div className="empty-note">{art.note || art.title}</div>
        )}
      </div>
      <div className="meta">
        <span className="dot" style={{ background: color }} />
        <span className="title" style={big ? { fontSize: 20 } : undefined}>
          {art.title}
        </span>
        <span className="chip">{art.agentName || "Canvas"}</span>
        <span className="chip mono" style={{ color: "var(--dim)" }}>
          {ago(art.updatedAt)}
        </span>
      </div>
    </div>
  );
}

// ---------- toasts ----------

export function Toasts({ big }: { big?: boolean }) {
  const { toasts } = useHub();
  return (
    <div className="toasts" style={big ? { width: "min(1100px, 80vw)", top: 28 } : undefined}>
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} style={big ? { padding: "18px 24px", fontSize: 22 } : undefined}>
          <span className={`badge ${t.tone === "directive" ? "" : "neutral"} kind`} style={toneStyle(t.tone)}>
            {t.tone === "directive" ? "Routed" : t.tone === "decision" ? "Decision" : t.tone === "warn" ? "Needs you" : "JamSesh"}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="text">{t.text}</div>
            {t.detail && <div className="detail">{t.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function toneStyle(tone: string) {
  if (tone === "directive") return { color: "var(--directive)", background: "var(--directive-bg)" };
  if (tone === "decision") return { color: "var(--decision)", background: "var(--decision-bg)" };
  if (tone === "warn") return { color: "var(--warn)", background: "var(--warn-bg)" };
  return undefined;
}

// ---------- the room feed ----------

const FEED_KINDS = new Set(["speech", "prompt", "directive", "decision", "brain", "update", "message", "artifact"]);

export function RoomFeed({ big, editable, filter = "all" }: { big?: boolean; editable?: boolean; filter?: "all" | "room" }) {
  const { state } = useHub();
  const end = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<{ ev: JamEvent; x: number; y: number } | null>(null);
  const events = (state?.events ?? []).filter((e) => FEED_KINDS.has(e.kind) && (filter === "all" || ["speech", "prompt", "directive", "decision", "brain"].includes(e.kind) || (e.kind === "update" && ["question", "blocked", "shipped"].includes(e.data.updateKind))));
  const last = events[events.length - 1]?.id;
  useEffect(() => end.current?.scrollIntoView({ block: "end", behavior: "smooth" }), [last]);
  if (!state) return null;
  return (
    <div className="feed" style={{ flex: 1, fontSize: big ? 17 : 14 }}>
      {events.length === 0 && <div className="empty-note">The room's conversation shows up here as people talk.</div>}
      {events.slice(-140).map((e) => (
        <FeedLine key={e.id} e={e} state={state} editable={editable} condensed={big} onSpeaker={(ev, x, y) => setPop({ ev, x, y })} />
      ))}
      <div ref={end} />
      {pop && <SpeakerPopover state={state} ev={pop.ev} x={pop.x} y={pop.y} onClose={() => setPop(null)} />}
    </div>
  );
}

function FeedLine({ e, state, editable, condensed, onSpeaker }: { e: JamEvent; state: HubState; editable?: boolean; condensed?: boolean; onSpeaker: (e: JamEvent, x: number, y: number) => void }) {
  const color = e.authorType === "agent" ? colorFor(state, { agentId: e.authorId }) : colorFor(state, { personId: e.authorId, name: e.authorName });
  if (e.kind === "directive") {
    return (
      <div className="line directive">
        <div>
          <span className="tag" style={{ color: "var(--directive)" }}>
            {modeLabel(e.data.mode)} → {(e.data.targetNames ?? []).join(", ") || "the room"}
          </span>
          <div className={`what ${condensed ? "clamp" : ""}`} style={{ marginTop: 3 }}>{e.text}</div>
          {e.data.rationale && !condensed && <div className="sub">{e.data.rationale}</div>}
        </div>
      </div>
    );
  }
  if (e.kind === "decision") {
    return (
      <div className="line decision">
        <div>
          <span className="tag" style={{ color: "var(--decision)" }}>Decision{e.data.requestedBy ? ` · ${e.data.requestedBy}` : ""}</span>
          <div className="what" style={{ marginTop: 3 }}>{e.text}</div>
        </div>
      </div>
    );
  }
  const unsure = e.kind === "speech" && !e.data.typed && (e.data.confidence ?? 1) < 0.55 && e.data.method !== "manual";
  const who =
    e.kind === "brain" ? "JamSesh" : e.kind === "prompt" ? `${e.authorName} → ${shortAgent(e.data.agentName)}` : e.authorName;
  const cls = [e.kind === "update" || e.kind === "message" || e.kind === "artifact" ? "agent" : "", e.kind === "prompt" ? "prompt" : "", e.relevance ?? ""].join(" ");
  return (
    <div className={`line ${cls}`}>
      {editable && e.kind === "speech" && e.data.utteranceId ? (
        <button className={`who speaker-btn ${unsure ? "unsure" : ""}`} style={{ color }} onClick={(ev) => onSpeaker(e, ev.clientX, ev.clientY)} title="Who said this?">
          {who}
        </button>
      ) : (
        <span className={`who ${unsure ? "speaker-btn unsure" : ""}`} style={{ color: e.kind === "brain" ? "var(--text)" : color }}>
          {who}
        </span>
      )}
      <span className="what">
        {e.kind === "update" && e.data.updateKind && e.data.updateKind !== "progress" && (
          <span className="tag" style={{ color: e.data.updateKind === "question" || e.data.updateKind === "blocked" ? "var(--warn)" : "var(--built)", marginRight: 8 }}>
            {e.data.updateKind}
          </span>
        )}
        {e.kind === "message" && <span className="tag" style={{ color: "var(--dim)", marginRight: 8 }}>to {e.data.toName}</span>}
        {e.text}
        {e.relevance === "banter" && <span className="tag" style={{ color: "var(--faint)", marginLeft: 8 }}>banter</span>}
      </span>
    </div>
  );
}

function shortAgent(name?: string) {
  if (!name) return "agent";
  const m = name.match(/'s (.+)$/);
  return m ? m[1] : name;
}

export function modeLabel(mode: string) {
  return mode === "explore" ? "Explore" : mode === "implement" ? "Build" : mode === "coordinate" ? "Coordinate" : mode === "answer" ? "Answer" : mode;
}

function SpeakerPopover({ state, ev, x, y, onClose }: { state: HubState; ev: JamEvent; x: number; y: number; onClose: () => void }) {
  const [name, setName] = useState("");
  const assign = async (body: { personId?: string; name?: string }) => {
    await api(`/utterances/${ev.data.utteranceId}/assign`, body);
    onClose();
  };
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 59 }} onClick={onClose} />
      <div className="popover" style={{ left: Math.min(x, innerWidth - 260), top: Math.min(y + 8, innerHeight - 340) }}>
        <div className="hint">Who said this? JamSesh learns their voice.</div>
        {state.people.map((p) => (
          <button key={p.id} className="item" onClick={() => assign({ personId: p.id })}>
            <Avatar name={p.name} color={p.color} size={22} />
            <span className="grow">{p.name}</span>
            {p.id === ev.authorId && <span className="chip">current</span>}
          </button>
        ))}
        <form
          className="row"
          style={{ padding: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) assign({ name: name.trim() });
          }}
        >
          <input className="grow" placeholder="Someone new…" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!state.people.length} />
        </form>
      </div>
    </>
  );
}

// ---------- agents ----------

export function AgentRow({ agent, state, compact }: { agent: Agent; state: HubState; compact?: boolean }) {
  const now = useNow(5000);
  const color = colorFor(state, { agentId: agent.id });
  const ws = state.workstreams.filter((w) => w.ownerAgentId === agent.id && w.status === "active");
  return (
    <div className="row" style={{ alignItems: "flex-start", padding: compact ? "8px 0" : "10px 0", opacity: agent.status === "offline" ? 0.45 : 1 }}>
      <span style={{ position: "relative" }}>
        <Avatar name={agent.ownerName} color={color} size={compact ? 26 : 32} />
        <StatusDot status={agent.status} />
      </span>
      <div className="grow">
        <div className="row" style={{ gap: 8 }}>
          <strong style={{ fontWeight: 600, fontSize: compact ? 14 : 15 }}>{agent.name}</strong>
          <span className="chip" style={{ fontSize: 12 }}>
            {agent.platform} · {agent.repo.split(/[/:]/).pop()?.replace(/\.git$/, "")}
          </span>
        </div>
        <div className="chip" style={{ display: "block", fontSize: 13, color: "var(--muted)", marginTop: 2 }}>
          {statusText(agent)} {agent.activity && agent.status !== "offline" ? `· ${agent.activity}` : ""}
        </div>
        {!compact && ws.length > 0 && <div className="chip" style={{ fontSize: 12, color: "var(--dim)", marginTop: 2 }}>Owns {ws.map((w) => w.title).join(", ")}</div>}
      </div>
      <span className="chip mono" style={{ fontSize: 12, color: "var(--dim)" }}>
        {ago(agent.lastSeen, now)}
      </span>
    </div>
  );
}

export function StatusDot({ status }: { status: Agent["status"] }) {
  const c = status === "working" ? "var(--built)" : status === "blocked" ? "var(--warn)" : status === "waiting" || status === "idle" ? "var(--decision)" : "var(--faint)";
  return <span className="dot" style={{ position: "absolute", right: -2, bottom: -2, width: 11, height: 11, background: c, border: "2px solid var(--bg)", animation: status === "working" ? "pulse 1.6s infinite" : undefined }} />;
}

function statusText(a: Agent) {
  switch (a.status) {
    case "working":
      return "Working";
    case "waiting":
      return "Ready for work";
    case "idle":
      return "Idle";
    case "blocked":
      return "Needs the room";
    default:
      return "Offline";
  }
}

// ---------- misc ----------

export function QR({ text, size = 132 }: { text: string; size?: number }) {
  const svg = (() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  })();
  return <div style={{ width: size, height: size, background: "#fff", padding: 10, borderRadius: 14 }} dangerouslySetInnerHTML={{ __html: svg.replace("<svg", '<svg style="width:100%;height:100%;display:block"') }} />;
}

export function Meter({ db }: { db: number | undefined }) {
  const pct = db == null ? 0 : Math.max(0, Math.min(100, ((db + 70) / 55) * 100));
  return (
    <span className="meter">
      <i style={{ width: `${pct}%` }} />
    </span>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button className={`toggle ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />;
}

export function CanvasFrame({ kind, name, title }: { kind: "edit" | "view"; name?: string; title: string }) {
  const [link, setLink] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { state } = useHub();
  const status = state?.session.canvas.status;
  useEffect(() => {
    if (status !== "live") return;
    api<{ link: string | null; reason: string | null }>(`/canvas-link?kind=${kind}`)
      .then((r) => (r.link ? setLink(r.link) : setErr(r.reason ?? "The canvas isn't live yet.")))
      .catch((e) => setErr(String(e.message ?? e)));
  }, [kind, status]);
  if (!link) return <div className="empty-note" style={{ display: "grid", placeItems: "center", height: "100%" }}>{err ?? (status === "failed" ? state?.session.canvas.reason : "Connecting to the canvas…")}</div>;
  const gl = new URLSearchParams(location.search).has("webgl") ? "&webgl" : "";
  const src = `/canvas/?canvas${gl}${name ? `&name=${encodeURIComponent(name)}` : ""}#join=${encodeURIComponent(link)}`;
  return <iframe src={src} title={title} style={{ width: "100%", height: "100%", border: 0, display: "block", background: "#f5f5f5" }} allow="clipboard-read; clipboard-write" />;
}

export function Section({ title, help, children, right }: { title: string; help?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="section">
      <div className="row between">
        <h3>{title}</h3>
        {right}
      </div>
      {help && <p className="help">{help}</p>}
      {children}
    </div>
  );
}

export type { Person };
void hub;
