import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import qrcode from "qrcode-generator";
import { ago, api, hub, useHub, type Agent, type Artifact, type HubState, type JamEvent, type Person, type Share } from "./hub";
import { isOpaqueFrame, pointerRecording } from "./pointer";

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

export function Avatar({ name, color, size = 28, photo }: { name: string; color: string; size?: number; photo?: string | null }) {
  if (photo) return <img className="avatar" src={photo} alt={name} title={name} style={{ width: size, height: size, objectFit: "cover", border: `2px solid ${color}` }} />;
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

/** URLs the host hands out name its LAN address; a remote viewer reaches the same port through the address they used. */
export function localize(url: string) {
  try {
    const u = new URL(url);
    // On the public HTTPS address, dev servers live on their own subdomain: dev-<port>.<host>.
    if (location.protocol === "https:" && /^(\d+\.){3}\d+$/.test(u.hostname) && u.port) return `https://dev-${u.port}.${location.hostname}${u.pathname}${u.search}`;
    if (/^(\d+\.){3}\d+$/.test(u.hostname) && u.hostname !== location.hostname && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
      u.hostname = location.hostname;
      return u.toString();
    }
  } catch {}
  return url;
}

/** What a tile hangs on a pin layer: the target the pins and pointer marks are filed under. */
export type SlotTarget = { kind: string; ref: string; label: string };

/** Pin layers for tiles (filled in by main.tsx once the annotation layer is mounted). */
export const tileSlots: { render: ((target: SlotTarget) => ReactNode) | null; screen: ((share: Share) => ReactNode) | null } = { render: null, screen: null };

export function Slot({ target }: { target: SlotTarget }) {
  return <>{tileSlots.render?.(target) ?? null}</>;
}

/** The pin target for an artifact: its id, or the page's URL for a dev server. */
export function artifactTarget(a: Artifact): SlotTarget {
  return a.kind === "devserver" ? { kind: "web", ref: a.url ?? a.id, label: a.title } : { kind: "artifact", ref: a.id, label: a.title };
}

function useRecording() {
  return useSyncExternalStore(pointerRecording.sub, pointerRecording.get);
}

/**
 * While a prompt is being recorded, a frame from another origin (or a sandboxed one) swallows the
 * pointer, so a transparent sheet goes over it to see where people point. It exists only while
 * recording, so the page underneath stays fully usable the rest of the time. Place it inside the
 * tile, over the frame, with `position: relative` on the parent.
 */
export function RecordCatch({ frame }: { frame: RefObject<HTMLIFrameElement | null> }) {
  const recording = useRecording();
  const [cover, setCover] = useState(false);
  useEffect(() => {
    if (!recording) return setCover(false);
    const check = () => setCover(isOpaqueFrame(frame.current));
    check();
    const id = setInterval(check, 400);
    return () => clearInterval(id);
  }, [recording, frame]);
  return cover ? <div className="rec-catch" aria-hidden /> : null;
}

/**
 * Pins for an image or an empty tile: a layer that follows the picture itself, not the padded tile
 * around it, so a pin stays on the same spot of the picture however the tile is resized.
 * Mount it as a child of the (positioned) media box.
 */
export function FitPins({ target }: { target: SlotTarget }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const media = el?.parentElement;
    if (!el || !media) return;
    const img = media.querySelector("img");
    const fit = () => {
      const m = media.getBoundingClientRect();
      const k = m.width / Math.max(1, media.offsetWidth) || 1; // an ancestor's scale() cancels out
      const r = img ? img.getBoundingClientRect() : m;
      el.style.left = `${(r.left - m.left) / k}px`;
      el.style.top = `${(r.top - m.top) / k}px`;
      el.style.width = `${r.width / k}px`;
      el.style.height = `${r.height / k}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(media);
    if (img) ro.observe(img);
    return () => ro.disconnect();
  }, [target.ref]);
  return (
    <div ref={box} className="pinbox">
      <Slot target={target} />
    </div>
  );
}

// Sites known to refuse being framed (X-Frame-Options or frame-ancestors). A browser can't tell a
// refused frame from a loaded one, so these are shown as the fallback up front.
const NO_FRAME = /^(www\.)?(google\.com|github\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|linkedin\.com|amazon\.com|reddit\.com|netflix\.com|paypal\.com|pinterest\.com|figma\.com)$/i;
const LOAD_TIMEOUT = 12_000;

function hostName(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Shown in place of a page that can't be framed: who it is, why it's blank, and a way to still show it. */
function BlockedFrame({ url, onTry }: { url: string; onTry?: () => void }) {
  const [phase, setPhase] = useState<"idle" | "busy" | "done">("idle");
  const [err, setErr] = useState("");
  const open = async () => {
    setPhase("busy");
    setErr("");
    try {
      const r = await api<{ result?: string }>("/host/open-url", { url }, "POST", { queue: false });
      const msg = String(r?.result ?? "");
      if (/^opened/i.test(msg) || !msg) setPhase("done");
      else (setErr(msg), setPhase("idle"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't open it on the host.");
      setPhase("idle");
    }
  };
  return (
    <div className="frame-blocked">
      <div className="fb-inner">
        <svg className="fb-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="4.5" width="18" height="15" rx="3" />
          <path d="M3 9h18" />
          <path d="m9.5 12.5 5 5m0-5-5 5" />
        </svg>
        <div className="fb-host" title={url}>{hostName(url)}</div>
        <div className="fb-line">Can't be shown inside JamSesh.</div>
        <button className="btn small fb-open" onClick={open} disabled={phase === "busy"}>
          {phase === "busy" ? "Opening…" : phase === "done" ? "Opened. Open again" : "Open on the host"}
        </button>
        {err && <div className="fb-err" role="alert">{err}</div>}
        {onTry && !err && phase === "idle" && (
          <button className="fb-try" onClick={onTry}>
            Try showing it here
          </button>
        )}
      </div>
    </div>
  );
}

export function ScaledFrame({ src: raw, width = 1280, height = 800, title, pin, detectBlocked }: { src: string; width?: number; height?: number; title: string; pin?: SlotTarget; detectBlocked?: boolean }) {
  const src = localize(raw);
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const pinbox = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ok" | "blocked">(() => (detectBlocked && NO_FRAME.test(hostName(raw)) ? "blocked" : "loading"));
  const [forced, setForced] = useState(false);
  const blocked = state === "blocked" && !forced;
  // A frame that never reports loading is as good as blocked; a load event on a page we can't
  // inspect (another origin) is taken as loaded.
  useEffect(() => {
    if (!detectBlocked || blocked) return;
    const id = setTimeout(() => setState((s) => (s === "loading" ? "blocked" : s)), LOAD_TIMEOUT);
    return () => clearTimeout(id);
  }, [detectBlocked, blocked, src]);
  useEffect(() => {
    if (detectBlocked) setState(NO_FRAME.test(hostName(raw)) ? "blocked" : "loading");
    setForced(false);
    if (!detectBlocked) return;
    // The host reads the page's headers, which a browser can't see from inside the frame.
    let live = true;
    api<{ blocked: boolean }>(`/frame-check?url=${encodeURIComponent(raw)}`)
      .then((r) => live && r.blocked && setState("blocked"))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [raw, detectBlocked]);
  // Sized in the resize callback itself, not through React state: state would land a frame late
  // and the frame would shake while the window is being resized.
  useLayoutEffect(() => {
    const el = box.current;
    const f = frame.current;
    if (!el || !f) return;
    const fit = () => {
      const scale = Math.min(el.clientWidth / width, el.clientHeight / height) || 0;
      const left = (el.clientWidth - width * scale) / 2;
      const top = (el.clientHeight - height * scale) / 2;
      f.style.left = `${left}px`;
      f.style.top = `${top}px`;
      f.style.transform = `scale(${scale})`;
      f.style.borderRadius = `${scale ? 12 / scale : 0}px`;
      f.style.visibility = scale > 0 ? "visible" : "hidden";
      // The pin layer and the capture sheet sit exactly on the picture, in the same frame.
      const p = pinbox.current;
      if (p) {
        p.style.left = `${left}px`;
        p.style.top = `${top}px`;
        p.style.width = `${width * scale}px`;
        p.style.height = `${height * scale}px`;
        p.style.borderRadius = `${12}px`;
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, height, blocked]);
  return (
    <div ref={box} style={{ position: "absolute", inset: "50px 18px 18px", overflow: "hidden" }}>
      {blocked ? (
        <BlockedFrame url={raw} onTry={() => setForced(true)} />
      ) : (
        <>
          <iframe
            ref={frame}
            src={src}
            title={title}
            onLoad={() => setState("ok")}
            style={{ position: "absolute", width, height, transformOrigin: "0 0", border: 0, background: "#fff", boxShadow: "0 16px 50px -18px rgba(0,0,0,.8)", visibility: "hidden" }}
          />
          <div ref={pinbox} className="pinbox">
            <RecordCatch frame={frame} />
            {pin && <Slot target={pin} />}
          </div>
        </>
      )}
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
  pins,
}: {
  art: Artifact;
  state: HubState;
  variant?: string;
  fresh?: boolean;
  onClick?: () => void;
  big?: boolean;
  live?: boolean;
  /** Take pins and pointer marks: the tile becomes a pin target (the artifact, or the dev server's URL). */
  pins?: boolean;
}) {
  const color = colorFor(state, { agentId: art.agentId });
  const target = pins ? artifactTarget(art) : undefined;
  const dev = state.devservers.find((d) => d.url === art.url);
  const framed = art.kind === "devserver" && !!art.url && live && dev?.up !== false;
  return (
    <div className={`tile ${art.stage} ${fresh ? "fresh" : ""} ${onClick ? "clickable" : ""}`} onClick={onClick} data-jam-target={target ? JSON.stringify(target) : undefined}>
      {variant && <div className="variant">{variant}</div>}
      <div className="corner">
        {art.platform && art.platform !== "other" && <span className="badge neutral">{art.platform}</span>}
        <span className={`badge ${art.stage} ${art.kind === "devserver" ? "live" : ""}`}>{art.kind === "devserver" ? "Live build" : art.stage === "built" ? "Built" : "Mockup"}</span>
      </div>
      <div className="media" style={big ? { padding: 28 } : undefined}>
        {art.kind === "devserver" && art.url ? (
          live && dev?.up !== false ? (
            <ScaledFrame src={art.url} title={art.title} width={art.platform === "mobile" ? 390 : 1440} height={art.platform === "mobile" ? 844 : 900} pin={target} />
          ) : (
            <div className="empty-note mono">{art.url} isn't answering</div>
          )
        ) : art.image ? (
          <img src={art.image} alt={art.title} loading="lazy" />
        ) : art.kind === "html" ? null : (
          <div className="empty-note">{art.note || art.title}</div>
        )}
        {target && !framed && <FitPins key={art.image ?? art.id} target={target} />}
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
    e.kind === "brain" ? state.settings.brainName : e.kind === "prompt" ? `${e.authorName} → ${shortAgent(e.data.agentName)}` : e.authorName;
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
        {e.kind === "brain" && e.data.spoken && (
          <span title="Said out loud" aria-label="Said out loud" style={{ marginLeft: 8, color: "var(--dim)", verticalAlign: "-2px", display: "inline-flex" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" /></svg>
          </span>
        )}
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
            <Avatar name={p.name} color={p.color} size={22} photo={p.photo} />
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
  const repo = agent.repo.split(/[/:]/).pop()?.replace(/\.git$/, "");
  const owner = state.people.find((p) => p.id === agent.ownerId);
  return (
    <div className="agent-row" style={{ opacity: agent.status === "offline" ? 0.45 : 1, padding: compact ? "8px 0" : "10px 0" }}>
      <span style={{ position: "relative", flex: "none" }}>
        <Avatar name={agent.ownerName} color={color} size={compact ? 28 : 34} photo={owner?.photo} />
        <StatusDot status={agent.status} />
      </span>
      <div className="agent-row-text">
        <div className="agent-row-line">
          <strong className="ellipsis" style={{ fontWeight: 600, fontSize: compact ? 14 : 15 }}>{agent.name}</strong>
          {!compact && <span className="chip" style={{ fontSize: 12, flex: "none" }}>{agent.platform} · {repo}</span>}
          <span className="chip mono" style={{ fontSize: 12, color: "var(--dim)", marginLeft: "auto", flex: "none" }}>
            {ago(agent.lastSeen, now)}
          </span>
        </div>
        <div className="ellipsis" style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }}>
          {compact ? `${agent.platform} · ${repo} · ` : ""}
          {statusText(agent)}
          {agent.activity && agent.status !== "offline" ? ` · ${agent.activity}` : ""}
        </div>
        {!compact && ws.length > 0 && <div className="ellipsis" style={{ fontSize: 12, color: "var(--dim)", marginTop: 2 }}>Owns {ws.map((w) => w.title).join(", ")}</div>}
      </div>
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

type PageRow = { id: number; name: string; children: number; current: boolean; divider?: boolean };

/** Pages of the shared canvas: switch between them, and (when editing) add one. */
function PageBar({ frame, canAdd, page }: { frame: React.RefObject<HTMLIFrameElement | null>; canAdd: boolean; page?: string }) {
  const [pages, setPages] = useState<PageRow[]>([]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState("");
  const wanted = useRef(page);
  const fc = () => (frame.current?.contentWindow as any)?.figcraft;
  const refresh = async () => {
    try {
      const list = await fc()?.execute("page.list", {});
      if (Array.isArray(list)) setPages(list.filter((p: PageRow) => !p.divider));
    } catch {}
  };
  useEffect(() => {
    const t = setInterval(refresh, 2500);
    refresh();
    return () => clearInterval(t);
  }, []);
  // A layout can ask for a specific page.
  useEffect(() => {
    wanted.current = page;
  }, [page]);
  useEffect(() => {
    const w = wanted.current;
    if (!w || !pages.length) return;
    const target = pages.find((p) => p.name.toLowerCase() === w.toLowerCase());
    if (target && !target.current) fc()?.execute("page.select", { id: target.id }).then(refresh).catch(() => {});
    if (target) wanted.current = undefined;
  }, [pages]);
  const current = pages.find((p) => p.current);
  if (!pages.length) return null;
  const go = async (id: number) => {
    await fc()?.execute("page.select", { id }).catch(() => {});
    setOpen(false);
    refresh();
  };
  const add = async () => {
    const name = adding.trim();
    if (!name) return;
    await fc()?.execute("page.add", { name }).catch(() => {});
    setAdding("");
    setOpen(false);
    refresh();
  };
  return (
    <div className="page-bar">
      <button className="page-current" onClick={() => setOpen(!open)} aria-expanded={open} title="Canvas pages">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></svg>
        <span className="ellipsis">{current?.name ?? "Pages"}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0 }} onClick={() => setOpen(false)} />
          <div className="page-menu" role="menu">
            {pages.map((p) => (
              <button key={p.id} role="menuitem" className={`page-item ${p.current ? "on" : ""}`} onClick={() => go(p.id)}>
                <span className="ellipsis">{p.name}</span>
                <span className="page-frames">{p.children ? `${p.children} frame${p.children === 1 ? "" : "s"}` : "empty"}</span>
              </button>
            ))}
            {canAdd && (
              <form
                className="page-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  add();
                }}
              >
                <input placeholder="New page…" value={adding} onChange={(e) => setAdding(e.target.value)} />
              </form>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function CanvasFrame({ kind, name, title, follow, page }: { kind: "edit" | "view"; name?: string; title: string; follow?: string; page?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  // Follow a participant (by name): the canvas shows what they're looking at. A reload or reconnect gives them
  // a new client id, so this keeps checking and follows the new one.
  useEffect(() => {
    if (!follow) return;
    let followed: string | null = null;
    const tick = async () => {
      const fc = (frame.current?.contentWindow as any)?.figcraft;
      if (!fc) return;
      try {
        const peers = await fc.execute("collab.peers", {});
        const want = follow.toLowerCase().trim();
        const list: any[] = peers?.peers ?? [];
        const name = (p: any) => String(p.name ?? "").toLowerCase().trim();
        // Exact name first ("Chey's Claude" is not "Chey"), then a name containing what was asked.
        const peer = list.find((p) => name(p) === want) ?? list.find((p) => name(p).includes(want)) ?? list.find((p) => want.includes(name(p)) && name(p).length > 2);
        const client = peer ? String(peer.client ?? peer.id) : null;
        if (client && client !== followed) {
          await fc.execute("collab.follow", { client });
          followed = client;
        } else if (!client) followed = null;
      } catch {}
    };
    tick();
    const t = setInterval(tick, 2500);
    return () => clearInterval(t);
  }, [follow]);
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
  const src = `/canvas/?canvas&control${gl}${name ? `&name=${encodeURIComponent(name)}` : ""}#join=${encodeURIComponent(link)}`;
  return (
    <>
      <iframe ref={frame} src={src} title={title} style={{ width: "100%", height: "100%", border: 0, display: "block", background: "#f5f5f5" }} allow="clipboard-read; clipboard-write" />
      <PageBar frame={frame} canAdd={kind === "edit"} page={page} />
    </>
  );
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
