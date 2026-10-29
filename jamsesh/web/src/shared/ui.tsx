import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import qrcode from "qrcode-generator";
import { readPref } from "./identity";
import { ago, api, hub, useHub, type Agent, type Artifact, type Directive, type HubState, type JamEvent, type Person, type Share } from "./hub";
import { isOpaqueFrame, pointerRecording } from "./pointer";
import { CONNECT_TIMEOUT_MS, JoinWatch, START_TIMEOUT_MS, friendlyReason, joinLabel, FontTries, loadLocalFonts, macInvoke, rejoinDelay, type JoinState } from "./canvasJoin";

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
    // The host's own browser and the Mac app's window (its relay) are on 127.0.0.1: dev servers are
    // on this machine too, on the same port (on the host itself, or mirrored by the Mac app to the
    // host). They open as localhost, another host name: cookies ignore ports, so the window key on
    // 127.0.0.1 (SPEC 14) never reaches dev content.
    const privateHost = /^(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\.|\.local$/.test(u.hostname) || u.hostname === "localhost";
    if ((location.hostname === "127.0.0.1" || location.hostname === "localhost") && u.protocol === "http:" && u.port && privateHost) {
      u.hostname = "localhost";
      return u.toString();
    }
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
        <span className={`badge ${art.kind === "devserver" && dev?.up === false ? "neutral" : art.stage} ${art.kind === "devserver" && dev?.up !== false ? "live" : ""}`}>{art.kind === "devserver" ? (dev?.up === false ? "Stopped" : "Live build") : art.stage === "built" ? "Built" : "Mockup"}</span>
      </div>
      <div className="media" style={big ? { padding: 28 } : undefined}>
        {art.kind === "devserver" && art.url ? (
          live && dev?.up !== false ? (
            <ScaledFrame src={art.url} title={art.title} width={art.platform === "mobile" ? 390 : 1440} height={art.platform === "mobile" ? 844 : 900} pin={target} />
          ) : (
            <div className="empty-note dev-down">
              <strong>{dev?.problem ?? "This build isn't answering"}</strong>
              <span>The tile clears itself in a few minutes. It comes back if the build does.</span>
            </div>
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

const FEED_KINDS = new Set(["speech", "prompt", "directive", "decision", "brain", "join", "update", "message", "artifact"]);

/** Where the next page of history starts: the oldest event this window has at all, shown or not (the state's window may hold none the feed shows). */
export function historyCursor(ids: Iterable<number>): number | undefined {
  let oldest: number | undefined;
  for (const id of ids) if (oldest === undefined || id < oldest) oldest = id;
  return oldest;
}

/** How close to the bottom still counts as "at the bottom" (px). */
const AT_BOTTOM = 40;
/** Start loading older lines when the reader is this close to the top (px). */
const NEAR_TOP = 160;

/**
 * The room's conversation. The reader's own scroll position rules: new lines are followed only
 * while the reader is at the bottom; scrolling up stops following and shows a "Latest" pill with
 * the count of what came in meanwhile. Older lines than the live state carries load from the hub
 * as the reader reaches the top. The big screens (`big`) always follow and keep a short tail.
 * The feed scrolls its own box (scrollTop), never its ancestors.
 */
export function RoomFeed(props: { big?: boolean; editable?: boolean; filter?: "all" | "room" }) {
  // A different room starts a fresh feed: what was seen, loaded and scrolled belongs to the old one.
  return <RoomFeedOf key={useHub().state?.session.roomId} {...props} />;
}

function RoomFeedOf({ big, editable, filter = "all" }: { big?: boolean; editable?: boolean; filter?: "all" | "room" }) {
  const { state, removed } = useHub();
  const box = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<{ ev: JamEvent; x: number; y: number } | null>(null);
  // Every line this window has seen, so lines the live state trims (or the reader loaded) stay put.
  const seen = useRef(new Map<number, JamEvent>());
  const following = useRef(true);
  const [away, setAway] = useState(false);
  // The newest line the reader had reached when they scrolled away: what's after it is "new".
  const readTo = useRef(0);
  // Where the box was before older lines went in above, to hold the reader's place.
  const holdPlace = useRef<{ height: number; top: number } | null>(null);
  const busy = useRef(false);
  const [older, setOlder] = useState<{ loading: boolean; failed: boolean; done: boolean; more: number | null }>({ loading: false, failed: false, done: false, more: null });

  for (const e of state?.events ?? []) seen.current.set(e.id, e);
  // Lines the room took out (an agent removed with what it posted) leave this window's memory too.
  for (const id of removed) seen.current.delete(id);
  const wanted = (e: JamEvent) => FEED_KINDS.has(e.kind) && (filter === "all" || ["speech", "prompt", "directive", "decision", "brain", "join"].includes(e.kind) || (e.kind === "update" && ["question", "blocked", "shipped"].includes(e.data.updateKind)));
  const all = [...seen.current.values()].sort((a, b) => a.id - b.id).filter(wanted);
  const events = big ? all.slice(-140) : all;
  const last = events[events.length - 1]?.id ?? 0;
  const first = historyCursor(seen.current.keys());
  const everything = !!state && state.totals.events <= state.events.length;
  const exhausted = big || older.done || everything;
  const fresh = following.current ? 0 : events.filter((e) => e.id > readTo.current).length;

  const toBottom = (smooth = false) => {
    const el = box.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM;
    if (atBottom !== following.current) {
      following.current = atBottom;
      setAway(!atBottom);
    }
    if (atBottom) readTo.current = last;
    if (!big && el.scrollTop < NEAR_TOP) void loadOlder();
  };

  const loadOlder = async () => {
    const el = box.current;
    if (!el || exhausted || busy.current || holdPlace.current || first == null) return;
    busy.current = true;
    setOlder((o) => ({ ...o, loading: true, failed: false }));
    try {
      const kinds = [...FEED_KINDS].join(",");
      const r = await api<{ items: JamEvent[]; more: number }>(`/history/events?before=${first}&limit=60&kinds=${kinds}`);
      holdPlace.current = { height: el.scrollHeight, top: el.scrollTop };
      for (const e of r.items) seen.current.set(e.id, e);
      setOlder({ loading: false, failed: false, done: r.more === 0 || r.items.length === 0, more: r.more });
    } catch {
      setOlder((o) => ({ ...o, loading: false, failed: true }));
    } finally {
      busy.current = false;
    }
  };

  // After lines are added above the reader, put the box back where they were looking.
  useLayoutEffect(() => {
    const el = box.current;
    const h = holdPlace.current;
    if (!el || !h) return;
    holdPlace.current = null;
    el.scrollTop = h.top + (el.scrollHeight - h.height);
  });

  // New lines: follow them while the reader is at the bottom, otherwise leave the box alone.
  useLayoutEffect(() => {
    if (following.current) {
      readTo.current = last;
      toBottom();
    }
  }, [last]);

  // A taller or shorter box (keyboard, resize) keeps the reader at the bottom if they were there.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => following.current && toBottom());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A short feed that doesn't fill its box has no scrolling to trigger the load.
  useEffect(() => {
    const el = box.current;
    if (el && !big && !exhausted && first != null && el.scrollHeight <= el.clientHeight + NEAR_TOP) void loadOlder();
  }, [first, exhausted]);

  if (!state) return null;
  const jump = () => {
    following.current = true;
    readTo.current = last;
    setAway(false);
    toBottom(true);
  };
  return (
    <div className="feed-wrap">
      <div ref={box} className="feed" onScroll={onScroll} style={{ fontSize: big ? 17 : 14 }}>
        {events.length === 0 && <div className="empty-note">The room's conversation shows up here as people talk.</div>}
        {!exhausted && first != null && (
          <button className="feed-older" disabled={older.loading} onClick={() => void loadOlder()}>
            {older.loading ? "Loading earlier lines" : older.failed ? "Couldn't load earlier lines. Try again" : older.more ? `${older.more} earlier ${older.more === 1 ? "line" : "lines"}` : "Earlier lines"}
          </button>
        )}
        {events.map((e) => (
          <FeedLine key={e.id} e={e} state={state} editable={editable} condensed={big} onSpeaker={(ev, x, y) => setPop({ ev, x, y })} />
        ))}
        {pop && <SpeakerPopover state={state} ev={pop.ev} x={pop.x} y={pop.y} onClose={() => setPop(null)} />}
      </div>
      {away && !big && (
        <button className="feed-latest" onClick={jump} aria-label={fresh ? `Jump to the latest, ${fresh} new` : "Jump to the latest"}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
          {fresh ? `Latest · ${fresh} new` : "Latest"}
        </button>
      )}
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
  if (e.kind === "join") return <JoinLine e={e} state={state} canRemove={!!editable && !condensed} color={color} />;
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
        <span className={`who ${unsure ? "speaker-btn unsure" : ""}`} title={who} style={{ color: e.kind === "brain" ? "var(--text)" : color }}>
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
        {e.kind === "update" || e.kind === "message" || e.kind === "artifact" ? stripMd(e.text) : e.text}
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

/** "Jonathan's Codex joined from ~/fluid", with a way to take a wrong join out of the room. */
function JoinLine({ e, state, canRemove, color }: { e: JamEvent; state: HubState; canRemove: boolean; color: string }) {
  const agentId = e.data.agentId as string | undefined;
  const here = !!agentId && state.agents.some((a) => a.id === agentId);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Gone from the room (this removal, or someone's): nothing left to confirm, even if the answer to our call was lost.
  useEffect(() => {
    if (!here) {
      setAsking(false);
      setError("");
    }
  }, [here]);
  const remove = async (purge: boolean) => {
    setBusy(true);
    setError("");
    try {
      await api(`/agents/${agentId}/remove`, { purge });
      setAsking(false);
    } catch (e) {
      // Still there: keep the choices open and say why.
      setError(e instanceof Error && e.message ? e.message : "Couldn't remove it. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="line join">
      <span className="who" title={e.authorName} style={{ color }}>
        {e.authorName}
      </span>
      <span className="what">
        {e.text.slice(e.authorName.length).trim()}
        {canRemove && here && !asking && (
          <button className="btn small ghost join-remove" onClick={() => setAsking(true)}>
            Remove
          </button>
        )}
        {asking && (
          <span className="join-ask">
            <button className="btn small" disabled={busy} onClick={() => void remove(false)}>
              Remove
            </button>
            <button className="btn small" disabled={busy} onClick={() => void remove(true)} title="Also deletes what it posted: its updates, messages and long documents. Messages sent to it and its artifacts stay.">
              Remove and delete its posts
            </button>
            <button className="btn small ghost" disabled={busy} onClick={() => setAsking(false)}>
              Cancel
            </button>
            {error && <span className="join-error" role="alert" style={{ color: "var(--warn)", marginLeft: 8 }}>{error}</span>}
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
  return mode === "explore" ? "Explore" : mode === "implement" ? "Build" : mode === "coordinate" ? "Coordinate" : mode === "answer" ? "Answer" : mode === "note" ? "Note" : mode;
}

function SpeakerPopover({ state, ev, x, y, onClose }: { state: HubState; ev: JamEvent; x: number; y: number; onClose: () => void }) {
  const [name, setName] = useState("");
  const [result, setResult] = useState<{ message: string; learned: boolean } | null>(null);
  const assign = async (body: { personId?: string; name?: string }) => {
    const r = await api<{ ok?: boolean; queued?: boolean; learning?: { learned: boolean; message: string } }>(`/utterances/${ev.data.utteranceId}/assign`, body);
    // Say what the correction did for the voiceprint, then get out of the way.
    if (!r?.learning) return onClose();
    setResult({ message: r.learning.message, learned: r.learning.learned });
    setTimeout(onClose, r.learning.learned ? 1600 : 3200);
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
        {result ? (
          <div className="hint" role="status" style={{ padding: "10px 10px 8px", maxWidth: 240, fontSize: 13, color: result.learned ? "var(--built)" : "var(--warn)" }}>{result.message}</div>
        ) : (
          <>
        {state.voiceprints && !state.voiceprints.available ? (
          <div className="hint" style={{ color: "var(--warn)", maxWidth: 240 }} title={state.voiceprints.reason}>
            Voice matching is off on this host, so this renames the line but can't teach a voice.
            {state.voiceprints.reason && <div style={{ color: "var(--dim)", marginTop: 4 }}>{state.voiceprints.reason}</div>}
          </div>
        ) : (
          <div className="hint">Who said this? JamSesh learns their voice.</div>
        )}
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
          </>
        )}
      </div>
    </>
  );
}

// ---------- agents ----------

/** Agent text arrives as markdown; these small surfaces show it as plain words. */
export function stripMd(t: string): string {
  return t
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+])\s+/gm, "");
}

/** Open tasks an agent has taken or been handed, oldest first. */
export function openTasksFor(state: HubState, agentId: string) {
  return state.directives
    .filter((d) => d.targets.includes(agentId) && ["pending", "delivered", "acked"].includes(d.progress?.[agentId] ?? d.status))
    .sort((x, y) => x.ts - y.ts);
}

/**
 * The open tasks a tile has room for (`max`): any offered for reassignment first, so its Reassign
 * button is always on screen, then the oldest. All offered tasks show even past `max`.
 */
export function tasksToShow(tasks: Directive[], agentId: string, max: number) {
  const offered = tasks.filter((d) => d.reassignOfferedAt?.[agentId]);
  const rest = tasks.filter((d) => !d.reassignOfferedAt?.[agentId]);
  return [...offered, ...rest].slice(0, Math.max(max, offered.length));
}

/** Moves this agent's stalled task to someone else; the other targets of the same task keep it. */
export function reassignTask(directiveId: string, agentId: string) {
  return api(`/directives/${directiveId}/reassign`, { personId: readPref("personId"), agentId });
}

function ReassignButton({ directiveId, agentId }: { directiveId: string; agentId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      {error && <span style={{ color: "var(--warn)" }}>{error}</span>}
      <button
        className="btn small"
        style={{ flex: "none" }}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError("");
          reassignTask(directiveId, agentId)
            .catch((e) => setError(e?.message || "Couldn't reassign it"))
            .finally(() => setBusy(false));
        }}
      >
        Reassign
      </button>
    </>
  );
}

export function AgentRow({ agent, state, compact }: { agent: Agent; state: HubState; compact?: boolean }) {
  const now = useNow(5000);
  const color = colorFor(state, { agentId: agent.id });
  const ws = state.workstreams.filter((w) => w.ownerAgentId === agent.id && w.status === "active");
  const paused = state.workstreams.filter((w) => w.ownerAgentId === agent.id && w.status === "paused");
  const tasks = agent.role === "observer" ? [] : openTasksFor(state, agent.id);
  const shown = tasksToShow(tasks, agent.id, compact ? 1 : 3);
  const repo = agent.repo.split(/[/:]/).pop()?.replace(/\.git$/, "");
  const owner = state.people.find((p) => p.id === agent.ownerId);
  const where = agent.role === "observer" ? "observer" : `${agent.platform} · ${repo}`;
  return (
    <div className="agent-row" style={{ opacity: agent.status === "offline" ? 0.45 : 1, padding: compact ? "8px 0" : "10px 0" }}>
      <span style={{ position: "relative", flex: "none" }}>
        <Avatar name={agent.ownerName} color={color} size={compact ? 28 : 34} photo={owner?.photo} />
        <StatusDot status={agent.status} />
      </span>
      <div className="agent-row-text">
        <div className="agent-row-line">
          <strong className="ellipsis" style={{ fontWeight: 600, fontSize: compact ? 14 : 15 }}>{agent.name}</strong>
          {!compact && <span className="chip" style={{ fontSize: 12, flex: "none" }}>{where}</span>}
          <span className="chip mono" style={{ fontSize: 12, color: "var(--dim)", marginLeft: "auto", flex: "none" }}>
            {ago(agent.lastSeen, now)}
          </span>
        </div>
        <div className="ellipsis" style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }}>
          {compact ? `${where} · ` : ""}
          {statusLine(agent)}
        </div>
        {!compact && ws.length > 0 && <div className="ellipsis" style={{ fontSize: 12, color: "var(--dim)", marginTop: 2 }}>Owns {ws.map((w) => w.title).join(", ")}</div>}
        {paused.length > 0 && <div className="ellipsis" style={{ fontSize: 12, color: "var(--warn)", marginTop: 2 }}>Paused while offline: {paused.map((w) => w.title).join(", ")}</div>}
        {shown.map((d) => (
          <div key={d.id} className="row" style={{ fontSize: 12, color: d.reassignOfferedAt?.[agent.id] ? "var(--warn)" : "var(--dim)", marginTop: 2, gap: 8 }}>
            <span className="chip mono" style={{ flex: "none" }}>{ago(d.ts, now)}</span>
            <span className="ellipsis grow">{d.progress?.[agent.id] === "acked" ? "On it" : "Not picked up"}: {stripMd(d.text)}</span>
            {d.reassignOfferedAt?.[agent.id] && <ReassignButton directiveId={d.id} agentId={agent.id} />}
          </div>
        ))}
        {tasks.length > shown.length && <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 2 }}>and {tasks.length - shown.length} more open</div>}
      </div>
    </div>
  );
}

/** "Working · what it's doing", or "Done: what it finished" until its next task. */
export function statusLine(a: Agent) {
  const act = a.activity && a.status !== "offline" ? stripMd(a.activity) : "";
  if (act.startsWith("Done:") && (a.status === "idle" || a.status === "waiting")) return act;
  // Generic activity words only repeat the status.
  if (!act || /^(idle|waiting for work|working)$/i.test(act)) return statusText(a);
  return act.startsWith("Working on:") ? act : `${statusText(a)} · ${act}`;
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

/** Pages of the shared canvas: switch between them, and (when editing) add one. Also how the
 * canvas's join is going, a way to reconnect it, and the fonts it shows in a substitute. */
function PageBar({
  frame,
  canAdd,
  page,
  join,
  substituted,
  onReconnect,
  onPage,
}: {
  frame: React.RefObject<HTMLIFrameElement | null>;
  canAdd: boolean;
  page?: string;
  join: JoinState;
  substituted: string[];
  onReconnect: () => void;
  /** The page shown, whenever it's read. */
  onPage?: (name: string) => void;
}) {
  const [pages, setPages] = useState<PageRow[]>([]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState("");
  const wanted = useRef(page);
  const fc = () => (frame.current?.contentWindow as any)?.figcraft;
  const refresh = async () => {
    try {
      const list = await fc()?.execute("page.list", {});
      if (!Array.isArray(list)) return;
      const rows = list.filter((p: PageRow) => !p.divider);
      setPages(rows);
      const on = rows.find((p) => p.current);
      if (on) onPage?.(on.name);
    } catch {}
  };
  // Pages others add arrive with the session's changes: the list follows them (and is read again
  // the moment the canvas (re)joins, and when the menu opens).
  const live = join.state === "live";
  useEffect(() => {
    const t = setInterval(refresh, 2000);
    refresh();
    return () => clearInterval(t);
  }, [live]);
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
  const label = joinLabel(join);
  const fonts = substituted.length ? `${substituted.join(", ")} ${substituted.length === 1 ? "isn't" : "aren't"} on this computer: text in ${substituted.length === 1 ? "it" : "them"} is shown in a substitute font.` : "";
  return (
    <div className="page-bar">
      {live && pages.length > 0 && (
        <button
          className="page-current"
          onClick={() => {
            if (!open) refresh();
            setOpen(!open);
          }}
          aria-expanded={open}
          title="Canvas pages"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></svg>
          <span className="ellipsis">{current?.name ?? "Pages"}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}><path d="m6 9 6 6 6-6" /></svg>
        </button>
      )}
      {label && (
        <div className={`canvas-join ${join.state === "failed" ? "quiet" : ""}`} role="status" title={join.state === "reconnecting" && join.reason ? join.reason : label}>
          <i className="canvas-join-dot" aria-hidden />
          <span className="ellipsis">{label}</span>
          {/* A failed join has the card over the canvas, with its own button. */}
          {join.state !== "loading" && join.state !== "failed" && (
            <button className="canvas-join-retry" onClick={onReconnect}>
              Reconnect
            </button>
          )}
        </div>
      )}
      {live && fonts && (
        <div className="canvas-fonts" title={fonts} aria-label={fonts}>
          <span aria-hidden className="canvas-fonts-aa">Aa</span>
          <span className="ellipsis">{substituted.length === 1 ? `${substituted[0]} substituted` : `${substituted.length} fonts substituted`}</span>
        </div>
      )}
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
            <button
              role="menuitem"
              className="page-item page-reconnect"
              onClick={() => {
                setOpen(false);
                onReconnect();
              }}
            >
              Reconnect canvas
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** "Reconnecting to the host in 6 s (attempt 2)", counting down to `at`. */
function Countdown({ at, attempt }: { at: number | null; attempt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const left = at ? Math.ceil((at - now) / 1000) : 0;
  const tries = attempt > 1 ? ` (attempt ${attempt})` : "";
  return <>{left > 0 ? `Reconnecting to the host in ${left} s${tries}` : `Reconnecting to the host…${tries}`}</>;
}

const figcraftIn = (iframe: HTMLIFrameElement | null) => (iframe?.contentWindow as any)?.figcraft as { execute: (c: string, p?: unknown) => Promise<any> } | undefined;

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
  // The canvas generation the link was fetched for: the host publishing the canvas again makes it old.
  const [linkGen, setLinkGen] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { state, epoch } = useHub();
  const status = state?.session.canvas.status;
  const generation = state?.session.canvas.generation ?? 0;
  // A failed fetch tries again by itself (and right away when the hub comes back), instead of leaving the error up.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (status !== "live" || link) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let gone = false;
    const failed = () => {
      if (!gone) retry = setTimeout(() => setAttempt((n) => n + 1), 4000);
    };
    const gen = generation;
    api<{ link: string | null; reason: string | null }>(`/canvas-link?kind=${kind}`)
      .then((r) => {
        if (gone) return;
        if (r.link) (setLink(r.link), setLinkGen(gen), setErr(null));
        else (setErr(r.reason ?? "The canvas isn't live yet."), failed());
      })
      .catch((e) => (setErr(String(e.message ?? e)), failed()));
    return () => {
      gone = true;
      clearTimeout(retry);
    };
  }, [kind, status, epoch, attempt, link, generation]);

  // Rejoin: fetch the link again and start a fresh canvas on it. `why` shows meanwhile.
  const [mount, setMount] = useState(0);
  const [why, setWhy] = useState<string | null>(null);
  // The page the person was on comes back with the rejoined canvas.
  const lastPage = useRef<string | undefined>(undefined);
  const [resume, setResume] = useState<string | undefined>(undefined);
  const rejoin = (reason: string) => {
    setWhy(reason);
    setResume(lastPage.current);
    setLink(null);
    setLinkGen(null);
    setMount((n) => n + 1);
  };
  const stale = link !== null && linkGen !== null && generation !== linkGen;
  useEffect(() => {
    if (stale) rejoin("The host's canvas restarted. Reconnecting…");
  }, [stale]);

  // How the canvas's own join is going (it joins inside the iframe, where a failure can't be seen):
  // read every 2 s, shown on the page bar, and a failed join is retried by itself (3 s, 6 s, 12 s, then every 30 s).
  const [join, setJoin] = useState<JoinState>({ state: "loading" });
  const failures = useRef(0);
  // When the next automatic rejoin happens, for the card's countdown.
  const [retryAt, setRetryAt] = useState<number | null>(null);
  useEffect(() => {
    if (!link) return;
    setJoin({ state: "loading" });
    const started = Date.now();
    let since = started;
    let last = "loading";
    let gone = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const watch = new JoinWatch();
    const tick = async () => {
      const fc = figcraftIn(frame.current);
      let j: JoinState;
      if (!fc) j = Date.now() - started > START_TIMEOUT_MS ? { state: "failed", reason: "The canvas didn't start." } : { state: "loading" };
      else {
        const read = await watch.poll(fc);
        if (!read) return;
        j = read;
      }
      if (gone) return;
      if (j.state !== last) ((last = j.state), (since = Date.now()));
      if (j.state === "connecting" && Date.now() - since > CONNECT_TIMEOUT_MS) j = { state: "failed", reason: "The canvas server didn't answer." };
      setJoin(j);
      if (j.state === "live") ((failures.current = 0), setWhy(null));
      if (j.state === "failed" && !retry) {
        const wait = rejoinDelay(failures.current);
        setRetryAt(Date.now() + wait);
        retry = setTimeout(() => {
          failures.current += 1;
          rejoin("Reconnecting to the host…");
        }, wait);
      }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      gone = true;
      clearInterval(t);
      clearTimeout(retry);
    };
  }, [link, mount]);

  // Fonts the canvas lacks: in the Mac app, from this Mac's own font folders; elsewhere they're
  // only listed (the canvas draws them in a substitute).
  const [substituted, setSubstituted] = useState<string[]>([]);
  const live = join.state === "live";
  useEffect(() => {
    if (!live) return;
    const tried = new FontTries();
    let gone = false;
    let busy = false;
    const tick = async () => {
      const fc = figcraftIn(frame.current);
      if (!fc || busy) return;
      busy = true;
      try {
        const left = await loadLocalFonts(fc, macInvoke(), tried);
        if (!gone) setSubstituted(left);
      } catch {
      } finally {
        busy = false;
      }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, [live, link, mount]);

  const reconnect = () => {
    failures.current = 0;
    rejoin("Reconnecting to the host…");
  };
  if (!link)
    return (
      <div className="empty-note" style={{ display: "grid", placeItems: "center", height: "100%" }}>
        {err ?? (status === "failed" ? state?.session.canvas.reason : why ?? "Connecting to the canvas…")}
      </div>
    );
  const gl = new URLSearchParams(location.search).has("webgl") ? "&webgl" : "";
  const src = `/canvas/?canvas&control${gl}${name ? `&name=${encodeURIComponent(name)}` : ""}#join=${encodeURIComponent(link)}`;
  return (
    <>
      <iframe key={`${mount}:${link}`} ref={frame} src={src} title={title} style={{ width: "100%", height: "100%", border: 0, display: "block", background: "#f5f5f5" }} allow="clipboard-read; clipboard-write" />
      <PageBar
        key={mount}
        frame={frame}
        canAdd={kind === "edit"}
        page={page ?? resume}
        join={join}
        substituted={substituted}
        onReconnect={reconnect}
        onPage={(name) => {
          lastPage.current = name;
        }}
      />
      {join.state === "failed" && (
        <div className="canvas-down" role="alert" title={join.reason}>
          <strong>Lost the canvas connection</strong>
          <span>{friendlyReason(join.reason)}</span>
          <span className="canvas-down-note">
            <Countdown at={retryAt} attempt={failures.current + 1} />
          </span>
          <button className="btn small" onClick={reconnect}>
            Reconnect now
          </button>
        </div>
      )}
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
