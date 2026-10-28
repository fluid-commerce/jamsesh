// Annotation pins, the annotations panel and "record a prompt".
//
// Wiring (see the report): every tile root carries `data-jam-target='{"kind","ref","label"}'` and
// `position: relative`; drop <PinLayer/> inside it. Pins post to /api/annotations, the panel bundles
// them to the room brain, RecordPrompt turns speech plus pointer movement into one prompt.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./annotate.css";
import { ago, api, hub, useHub, type Annotation, type HubState } from "./hub";
import { PointerRecorder, canvasHit, canvasIframe, fractionOf, hideNativeComments, readView, type CanvasView, type JamTarget, type PointerMark, type TrailSample } from "./pointer";

export type { JamTarget, PointerMark } from "./pointer";
export type PinTarget = Pick<JamTarget, "kind" | "ref" | "label">;

// ---------- tiny stores ----------

function store<T>(init: T) {
  let v = init;
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set(n: T | ((p: T) => T)) {
      const next = typeof n === "function" ? (n as (p: T) => T)(v) : n;
      if (Object.is(next, v)) return;
      v = next;
      subs.forEach((f) => f());
    },
    sub: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
    use() {
      return useSyncExternalStore(this.sub, this.get);
    },
  };
}

const modeStore = store(false);
/** card shown because the pointer rests on a marker */
const hoverStore = store<string | null>(null);
/** card the user clicked open (stays until clicked away) */
const openStore = store<string | null>(null);
/** marker highlighted from the panel (or while hovering it) */
const hotStore = store<string | null>(null);
/** a pin dropped but not yet saved lives in exactly one layer */
const draftOwner = store<string | null>(null);
/** saved before the hub echo arrives / removed before it does */
const pendingStore = store<Annotation[]>([]);
const goneStore = store<string[]>([]);
const pinEls = new Map<string, HTMLElement>();

let hoverTimer: ReturnType<typeof setTimeout> | undefined;
function hoverOn(id: string) {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => (hoverStore.set(id), hotStore.set(id)), 90);
}
function hoverOffSoon(id: string) {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (hoverStore.get() === id) hoverStore.set(null);
    if (hotStore.get() === id) hotStore.set(null);
  }, 220);
}
function hoverKeep() {
  clearTimeout(hoverTimer);
}

let flashTimer: ReturnType<typeof setTimeout> | undefined;
/** Panel click: open the pin's card, scroll it into view and pulse it. */
export function jumpToPin(id: string) {
  openStore.set(id);
  hotStore.set(id);
  pinEls.get(id)?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => hotStore.get() === id && hotStore.set(null), 2200);
}

// ---------- annotate mode ----------

function typing(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

let hotkeyRefs = 0;
let hotkeyOff: (() => void) | null = null;
function installHotkeys() {
  if (hotkeyRefs++ > 0) return;
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (openStore.get()) openStore.set(null);
      else if (modeStore.get() && !draftOwner.get()) modeStore.set(false);
      return;
    }
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (e.key === "a" || e.key === "A") modeStore.set((v) => !v);
  };
  const down = (e: PointerEvent) => {
    const t = e.target as HTMLElement | null;
    if (openStore.get() && !t?.closest?.(".an-pop, .an-pin-body")) openStore.set(null);
  };
  window.addEventListener("keydown", key);
  window.addEventListener("pointerdown", down, true);
  hotkeyOff = () => (window.removeEventListener("keydown", key), window.removeEventListener("pointerdown", down, true));
}
function releaseHotkeys() {
  if (--hotkeyRefs === 0) hotkeyOff?.();
}
function useHotkeys() {
  useEffect(() => (installHotkeys(), releaseHotkeys), []);
}

/** The app-wide Annotate switch. `A` toggles it, `Esc` leaves it. */
export function useAnnotateMode() {
  const on = modeStore.use();
  useHotkeys();
  return { on, set: (v: boolean) => modeStore.set(v), toggle: () => modeStore.set((p) => !p) };
}

export function AnnotateToggle({ className = "", label = "Annotate" }: { className?: string; label?: string }) {
  const { on, toggle } = useAnnotateMode();
  return (
    <button className={`an-toggle ${on ? "on" : ""} ${className}`} aria-pressed={on} onClick={toggle} title="Drop pins on what you see (A)" aria-label={label === "Annotate" ? undefined : "Drop pins on what you see"}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 21s-6.5-5.6-6.5-11A6.5 6.5 0 0 1 12 3.5 6.5 6.5 0 0 1 18.5 10c0 5.4-6.5 11-6.5 11Z" />
        <circle cx="12" cy="10" r="2.3" />
      </svg>
      {label}
      <kbd>A</kbd>
    </button>
  );
}

// ---------- data ----------

function colorOf(state: HubState | null, personId: string | null) {
  return state?.people.find((p) => p.id === personId)?.color ?? "#8a8f98";
}

/** Readable number color on a pin of this color. */
function inkFor(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#111";
  const n = parseInt(m[1], 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#14120d" : "#ffffff";
}

function usePins() {
  const { state } = useHub();
  const pending = pendingStore.use();
  const gone = goneStore.use();
  return useMemo(() => {
    const have = new Set((state?.annotations ?? []).map((a) => a.id));
    const all = [...(state?.annotations ?? []), ...pending.filter((a) => !have.has(a.id))].filter((a) => a.status !== "done" && !gone.includes(a.id));
    const pins = all.filter((a) => a.source === "pin").sort((a, b) => a.ts - b.ts);
    const pointed = all.filter((a) => a.source !== "pin").sort((a, b) => a.ts - b.ts);
    const numberOf = new Map(pins.map((a, i) => [a.id, i + 1]));
    return { pins, pointed, numberOf };
  }, [state?.annotations, pending, gone]);
}

async function patchPin(a: Annotation, fields: { text?: string; status?: Annotation["status"] }) {
  // The hub spreads both fields over the record, so always send both.
  return api(`/annotations/${a.id}`, { text: fields.text ?? a.text, status: fields.status ?? a.status }, "PATCH");
}

async function removePin(id: string) {
  goneStore.set((g) => [...g, id]);
  if (openStore.get() === id) openStore.set(null);
  try {
    await api(`/annotations/${id}`, undefined, "DELETE");
  } catch {
    goneStore.set((g) => g.filter((x) => x !== id));
  }
}

async function resolvePin(a: Annotation) {
  goneStore.set((g) => [...g, a.id]);
  if (openStore.get() === a.id) openStore.set(null);
  try {
    await patchPin(a, { status: "done" });
  } catch {
    goneStore.set((g) => g.filter((x) => x !== a.id));
  }
}

// ---------- small pieces ----------

function Face({ name, color, photo, size = 28 }: { name: string; color: string; photo?: string | null; size?: number }) {
  const parts = name.trim().split(/\s+/);
  const ini = ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
  return (
    <span className="an-av" title={name} style={{ width: size, height: size, fontSize: size * 0.4, background: photo ? `center/cover url(${photo})` : color, color: inkFor(color) }}>
      {photo ? "" : ini}
    </span>
  );
}

function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
const I = {
  check: "M20 6 9 17l-5-5",
  trash: "M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14",
  edit: "M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z",
  enter: "M20 6v6a2 2 0 0 1-2 2H5m0 0 4-4m-4 4 4 4",
};

/** Floating card pinned to a point in some tile; lives in a portal so tile clipping can't cut it. */
function Popover({ anchor, tipH, children, onEnter, onLeave, color }: { anchor: HTMLElement | null; tipH: number; children: ReactNode; onEnter?: () => void; onLeave?: () => void; color?: string }) {
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    let raf = 0;
    const place = () => {
      const pop = el.current;
      if (pop && anchor) {
        const a = anchor.getBoundingClientRect();
        const w = pop.offsetWidth;
        const h = pop.offsetHeight;
        // The visible area: on a phone the keyboard shrinks it, so the note always stays above the keys.
        const vv = window.visualViewport;
        const ox = vv?.offsetLeft ?? 0;
        const oy = vv?.offsetTop ?? 0;
        const vw = ox + (vv?.width ?? window.innerWidth);
        const vh = oy + (vv?.height ?? window.innerHeight);
        let x = a.left - 28;
        if (a.left + w - 28 > vw - 12) x = a.left - w + 28;
        x = Math.max(ox + 12, Math.min(x, vw - w - 12));
        let y = a.top + 14;
        let below = true;
        if (y + h > vh - 12 && a.top - tipH - 14 - h > oy + 8) {
          y = a.top - tipH - 14 - h;
          below = false;
        }
        y = Math.max(oy + 8, Math.min(y, vh - h - 8));
        pop.style.translate = `${Math.round(x)}px ${Math.round(y)}px`;
        pop.style.setProperty("--ox", `${Math.round(a.left - x)}px`);
        pop.style.setProperty("--oy", below ? "0px" : `${h}px`);
        pop.style.setProperty("--dy", below ? "8px" : "-8px");
      }
      raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [anchor, tipH]);
  if (!anchor) return null;
  return createPortal(
    <div ref={el} className="an-pop an-pop-in" style={{ ["--c" as string]: color }} onPointerEnter={onEnter} onPointerLeave={onLeave} onKeyDown={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}

function Composer({ color, name, photo, label, onSave, onCancel }: { color: string; name: string; photo?: string | null; label: string; onSave: (t: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ta.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    const t = ta.current;
    if (!t) return;
    t.style.height = "0";
    t.style.height = `${Math.min(180, Math.max(70, t.scrollHeight + 2))}px`;
  }, [text]);
  const save = () => text.trim() && onSave(text.trim());
  const touch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  return (
    <>
      <div className="an-head">
        <Face name={name} color={color} photo={photo} />
        <span className="who grow">{name}</span>
        <span className="an-chip" title={label}>
          {label}
        </span>
      </div>
      <textarea
        ref={ta}
        className="an-input"
        value={text}
        placeholder="What should change here?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.stopPropagation();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="an-foot">
        {touch ? (
          <button className="an-btn ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <span className="hint">
            <kbd className="an-k">Enter</kbd> save · <kbd className="an-k">Esc</kbd> cancel
          </span>
        )}
        <button className="an-btn primary" disabled={!text.trim()} onClick={save}>
          Pin it
        </button>
      </div>
    </>
  );
}

function Card({ ann, state }: { ann: Annotation; state: HubState | null }) {
  const person = state?.people.find((p) => p.id === ann.personId);
  const color = colorOf(state, ann.personId);
  return (
    <>
      <div className="an-head">
        <Face name={ann.authorName} color={color} photo={person?.photo} />
        <span className="who">{ann.authorName}</span>
        <span className="when grow">{ago(ann.ts)}</span>
        {ann.status === "sent" && <span className="an-sent-tag">sent</span>}
      </div>
      {ann.target.kind === "canvas" && ann.target.label && (
        <div style={{ marginTop: 9 }}>
          <span className="an-chip">{ann.target.label}</span>
        </div>
      )}
      <div className={`an-text ${ann.text ? "" : "empty"}`}>{ann.text || "Pointed here"}</div>
      <div className="an-foot" style={{ justifyContent: "flex-end" }}>
        <button className="an-btn danger ghost" onClick={() => removePin(ann.id)} title="Delete this pin">
          Delete
        </button>
        <button className="an-btn" onClick={() => resolvePin(ann)} title="Mark as handled">
          Resolve
        </button>
      </div>
    </>
  );
}

// ---------- pin layer ----------

function layerRoot(layer: HTMLElement | null) {
  return (layer?.closest("[data-jam-target]") as HTMLElement | null) ?? layer?.parentElement ?? null;
}

const sameView = (a: CanvasView | null, b: CanvasView | null) => !!a && !!b && a.cx === b.cx && a.comments === b.comments && a.cy === b.cy && a.zoom === b.zoom && a.vw === b.vw && a.vh === b.vh;

interface Draft {
  x: number;
  y: number;
  hit: Promise<Awaited<ReturnType<typeof canvasHit>>> | null;
  label: string;
}

let layerSeq = 0;

/**
 * Overlay for one tile. Put it inside the tile root (which needs `position: relative` and
 * `data-jam-target`). Existing pins always show; clicks drop new ones only while `enabled`.
 */
export function PinLayer({ target, personId, enabled }: { target: PinTarget; personId: string; enabled: boolean }) {
  useHotkeys();
  const { state } = useHub();
  const { pins, pointed, numberOf } = usePins();
  const layer = useRef<HTMLDivElement>(null);
  const me = useRef(`layer-${++layerSeq}`).current;
  const owner = draftOwner.use();
  const openId = openStore.use();
  const hoverId = hoverStore.use();
  const hotId = hotStore.use();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftEl, setDraftEl] = useState<HTMLElement | null>(null);
  const [view, setView] = useState<CanvasView | null>(null);
  const [geo, setGeo] = useState<{ l: number; t: number; w: number; h: number } | null>(null); // iframe box inside the layer

  // Marks from recorded prompts show while annotating, or for a minute and a half after.
  const mine = [...pins, ...pointed].filter((a) => a.target.kind === target.kind && a.target.ref === target.ref && (a.source === "pin" || enabled || Date.now() - a.ts < 90_000));
  const person = state?.people.find((p) => p.id === personId);
  const myColor = person?.color ?? "#ffb54a";

  // Only one unsaved pin in the room's UI at a time.
  useEffect(() => {
    if (owner !== me && draft) setDraft(null);
  }, [owner, me, draft]);
  useEffect(() => {
    if (!enabled && draft) {
      setDraft(null);
      if (draftOwner.get() === me) draftOwner.set(null);
    }
  }, [enabled, draft, me]);

  // Canvas pins follow the canvas as it pans and zooms: poll FigCraft's view and re-project.
  useEffect(() => {
    if (target.kind !== "canvas") return;
    let alive = true;
    const tick = async () => {
      const l = layer.current;
      const f = canvasIframe(layerRoot(l));
      if (!l || !f) return;
      const v = await readView(f);
      if (!alive) return;
      if (v?.comments) void hideNativeComments(f);
      const lr = l.getBoundingClientRect();
      const fr = f.getBoundingClientRect();
      const g = { l: fr.left - lr.left, t: fr.top - lr.top, w: fr.width, h: fr.height };
      setView((p) => (sameView(p, v) ? p : v));
      setGeo((p) => (p && p.l === g.l && p.t === g.t && p.w === g.w && p.h === g.h ? p : g));
    };
    void tick();
    const id = setInterval(tick, 350);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [target.kind]);

  const drop = (e: React.MouseEvent) => {
    const l = layer.current;
    if (!l) return;
    const r = l.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
    const y = Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height)));
    let hit: Draft["hit"] = null;
    if (target.kind === "canvas") {
      const f = canvasIframe(layerRoot(l));
      if (f) {
        const fr = f.getBoundingClientRect();
        const fx = Math.max(0, Math.min(1, (e.clientX - fr.left) / Math.max(1, fr.width)));
        const fy = Math.max(0, Math.min(1, (e.clientY - fr.top) / Math.max(1, fr.height)));
        hit = canvasHit(f, fx, fy);
      }
    }
    const d: Draft = { x, y, hit, label: target.label };
    setDraft(d);
    draftOwner.set(me);
    openStore.set(null);
    hoverStore.set(null);
    hit?.then((h) => h?.label && setDraft((cur) => (cur === d ? { ...d, label: h.label! } : cur)));
  };

  const save = async (text: string) => {
    const d = draft;
    if (!d) return;
    setDraft(null);
    if (draftOwner.get() === me) draftOwner.set(null);
    const hit = await d.hit?.catch(() => null);
    const body = {
      personId,
      target: {
        kind: target.kind,
        ref: target.ref,
        label: hit?.label ?? target.label,
        ...(hit ? { nodeId: hit.nodeId, canvasX: hit.canvasX, canvasY: hit.canvasY } : {}),
      },
      x: d.x,
      y: d.y,
      text,
      source: "pin" as const,
    };
    try {
      const ann = await api<Annotation>("/annotations", body);
      pendingStore.set((p) => [...p, ann]);
      setTimeout(() => pendingStore.set((p) => p.filter((a) => a.id !== ann.id)), 6000);
    } catch (err) {
      console.warn("annotate: couldn't save pin", err);
    }
  };

  const cancel = () => {
    setDraft(null);
    if (draftOwner.get() === me) draftOwner.set(null);
  };

  /** Pixel position inside the layer: re-projected for canvas pins, else the stored fraction. */
  const place = (a: { x: number; y: number; target: Annotation["target"] }): { left: string; top: string; hidden: boolean } => {
    if (target.kind === "canvas" && view && geo && a.target.canvasX != null && a.target.canvasY != null) {
      const { fx, fy } = fractionOf(view, a.target.canvasX, a.target.canvasY);
      return { left: `${geo.l + fx * geo.w}px`, top: `${geo.t + fy * geo.h}px`, hidden: fx < -0.01 || fx > 1.01 || fy < -0.01 || fy > 1.01 };
    }
    return { left: `${a.x * 100}%`, top: `${a.y * 100}%`, hidden: false };
  };

  return (
    <div ref={layer} className={`an-layer ${enabled ? "on" : ""}`}>
      {enabled && <div className="an-catch" onClick={drop} />}
      {mine.map((a) => (
        <Marker key={a.id} ann={a} n={numberOf.get(a.id) ?? null} state={state} pos={place(a)} open={openId === a.id} showCard={openId === a.id || hoverId === a.id} hot={hotId === a.id} />
      ))}
      {draft && (
        <div className="an-pin draft" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, ["--c" as string]: myColor, ["--ink" as string]: inkFor(myColor) }} ref={setDraftEl}>
          <span className="an-pin-body">
            <i />
            <b>{pins.length + 1}</b>
          </span>
          <Popover anchor={draftEl} tipH={38} color={myColor}>
            <Composer color={myColor} name={person?.name ?? "You"} photo={person?.photo} label={draft.label} onSave={save} onCancel={cancel} />
          </Popover>
        </div>
      )}
    </div>
  );
}

function Marker({ ann, n, state, pos, open, showCard, hot }: { ann: Annotation; n: number | null; state: HubState | null; pos: { left: string; top: string; hidden: boolean }; open: boolean; showCard: boolean; hot: boolean }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!el) return;
    pinEls.set(ann.id, el);
    return () => void pinEls.delete(ann.id);
  }, [el, ann.id]);
  const color = colorOf(state, ann.personId);
  const ghost = n == null;
  return (
    <div
      ref={setEl}
      className={`an-pin ${ghost ? "ghost" : ""} ${ann.status === "sent" ? "sent" : ""} ${open ? "open" : ""} ${hot ? "hot" : ""} ${pos.hidden ? "hidden" : ""}`}
      style={{ left: pos.left, top: pos.top, ["--c" as string]: color, ["--ink" as string]: inkFor(color) }}
      onPointerEnter={(e) => e.pointerType === "mouse" && hoverOn(ann.id)}
      onPointerLeave={(e) => e.pointerType === "mouse" && hoverOffSoon(ann.id)}
    >
      <button className="an-pin-body" aria-label={ghost ? "Pointed here" : `Pin ${n}`} onClick={() => openStore.set(open ? null : ann.id)}>
        <i />
        {!ghost && <b>{n}</b>}
      </button>
      {showCard && !pos.hidden && (
        <Popover anchor={el} tipH={ghost ? 10 : 38} onEnter={hoverKeep} onLeave={() => hoverOffSoon(ann.id)} color={color}>
          <Card ann={ann} state={state} />
        </Popover>
      )}
    </div>
  );
}

// ---------- panel ----------

function InlineEdit({ initial, onSave, onCancel }: { initial: string; onSave: (t: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ta.current?.focus();
    ta.current?.select();
  }, []);
  return (
    <textarea
      ref={ta}
      className="an-input"
      style={{ marginTop: 4, minHeight: 56 }}
      value={text}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCancel()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (text.trim()) onSave(text.trim());
        } else if (e.key === "Escape") onCancel();
      }}
    />
  );
}

/** Open pins grouped by tile, with a primary "Send N to <brain>" button. */
export function AnnotationsPanel({ personId }: { personId: string }) {
  const { state } = useHub();
  const { pins, pointed, numberOf } = usePins();
  const hot = hotStore.use();
  const [editing, setEditing] = useState<string | null>(null);
  const [sending, setSending] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [showPointed, setShowPointed] = useState(false);
  useHotkeys();
  useHub(); // keep relative times fresh through state ticks
  const brain = state?.settings.brainName || "the brain";
  const open = pins.filter((p) => p.status === "open");

  const groups = useMemo(() => {
    const m = new Map<string, { title: string; items: Annotation[] }>();
    for (const a of pins) {
      const key = `${a.target.kind}:${a.target.ref}`;
      const g = m.get(key) ?? { title: a.target.kind === "canvas" ? "Canvas" : a.target.label || a.target.ref, items: [] };
      g.items.push(a);
      m.set(key, g);
    }
    return [...m.values()];
  }, [pins]);

  const send = async () => {
    setSending("busy");
    try {
      await api("/annotations/send", { personId, ids: open.map((p) => p.id) });
      setSending("done");
    } catch {
      setSending("error");
    }
    setTimeout(() => setSending("idle"), 2200);
  };

  const Row = ({ a, dot }: { a: Annotation; dot?: boolean }) => {
    const color = colorOf(state, a.personId);
    return (
      <div
        className={`an-item ${a.status === "sent" ? "sent" : ""} ${hot === a.id ? "hot" : ""}`}
        style={{ ["--c" as string]: color, ["--ink" as string]: inkFor(color) }}
        onPointerEnter={() => hotStore.set(a.id)}
        onPointerLeave={() => hotStore.get() === a.id && hotStore.set(null)}
        onClick={() => jumpToPin(a.id)}
      >
        <span className={`an-num ${dot ? "dot" : ""}`}>{dot ? "" : numberOf.get(a.id)}</span>
        <div className="an-item-main">
          <div className="an-item-meta">
            <b>{a.authorName}</b>
            <span>{ago(a.ts)}</span>
            {a.target.kind === "canvas" && a.target.label && <span className="an-chip">{a.target.label}</span>}
            {a.status === "sent" && <span className="an-sent-tag">sent</span>}
          </div>
          {editing === a.id ? (
            <InlineEdit
              initial={a.text}
              onCancel={() => setEditing(null)}
              onSave={(t) => {
                setEditing(null);
                void patchPin(a, { text: t });
              }}
            />
          ) : (
            <div className="an-item-text">{a.text || "Pointed here"}</div>
          )}
        </div>
        {editing !== a.id && (
          <div className="an-item-act" onClick={(e) => e.stopPropagation()}>
            {!dot && (
              <button className="an-ico" title="Edit" aria-label="Edit this pin" onClick={() => setEditing(a.id)}>
                <Icon d={I.edit} />
              </button>
            )}
            <button className="an-ico" title="Resolve" aria-label="Resolve this pin" onClick={() => resolvePin(a)}>
              <Icon d={I.check} />
            </button>
            <button className="an-ico danger" title="Delete" aria-label="Delete this pin" onClick={() => removePin(a.id)}>
              <Icon d={I.trash} />
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="an-panel">
      <div className="an-panel-list">
        {!pins.length && (
          <div className="an-empty">
            <strong>No pins yet</strong>
            <span>
              <span className="an-hint-desk">
                Press <kbd className="an-k">A</kbd> and click anything on screen to leave a note.
              </span>
              <span className="an-hint-touch">Tap Pin, then tap anything on the canvas or the Screen tab to leave a note.</span>
            </span>
          </div>
        )}
        {groups.map((g) => (
          <section key={g.title}>
            <div className="an-group-h">
              <span>{g.title}</span>
              <i />
              <span>{g.items.length}</span>
            </div>
            {g.items.map((a) => (
              <Row key={a.id} a={a} />
            ))}
          </section>
        ))}
        {pointed.length > 0 && (
          <section>
            <button className="an-more" onClick={() => setShowPointed((v) => !v)}>
              {showPointed ? "Hide" : "Show"} {pointed.length} pointed during prompts
            </button>
            {showPointed && pointed.map((a) => <Row key={a.id} a={a} dot />)}
            {showPointed && (
              <button className="an-more" onClick={() => pointed.forEach((a) => void resolvePin(a))}>
                Clear them
              </button>
            )}
          </section>
        )}
      </div>
      <div className="an-panel-foot">
        <button className="an-send" disabled={!open.length || sending === "busy"} onClick={send}>
          {sending === "done" ? (
            <>
              <Icon d={I.check} size={18} /> Sent to {brain}
            </>
          ) : sending === "error" ? (
            "Couldn't send, try again"
          ) : open.length ? (
            <>
              Send {open.length} to {brain}
              <Icon d={I.enter} size={17} />
            </>
          ) : (
            "Nothing to send"
          )}
        </button>
      </div>
    </div>
  );
}

// ---------- record a prompt ----------

type RecState = { phase: "idle" } | { phase: "live"; t0: number } | { phase: "sending" };
type RecResult = { ok: boolean; text: string; pointed: string[]; reason?: string; out?: boolean };

function Trail({ feed }: { feed: React.RefObject<{ push: ((s: TrailSample) => void) | null }> }) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = () => {
      c.width = innerWidth * dpr;
      c.height = innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    addEventListener("resize", size);
    const pts: { x: number; y: number; at: number }[] = [];
    let anchor = { x: -99, y: -99, at: 0 };
    let raf = 0;
    if (feed.current)
      feed.current.push = (s) => {
        const at = performance.now();
        pts.push({ x: s.x, y: s.y, at });
        if (Math.hypot(s.x - anchor.x, s.y - anchor.y) > 6) anchor = { x: s.x, y: s.y, at };
      };
    const warn = getComputedStyle(document.documentElement).getPropertyValue("--warn").trim() || "#ff6b5e";
    const draw = () => {
      const now = performance.now();
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      while (pts.length && now - pts[0].at > 1500) pts.shift();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = warn;
      for (let i = 1; i < pts.length; i++) {
        const k = 1 - (now - pts[i].at) / 1500;
        if (pts[i].at - pts[i - 1].at > 400) continue;
        ctx.globalAlpha = Math.max(0, k) * 0.7;
        ctx.lineWidth = 1.5 + 3.5 * k;
        ctx.beginPath();
        ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
        ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
      const last = pts[pts.length - 1];
      if (last && now - last.at < 4000) {
        const held = now - anchor.at;
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = warn;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(last.x, last.y, 11, 0, 7);
        ctx.stroke();
        if (held > 300) {
          // The hold has registered as a dwell: draw it filling up.
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(last.x, last.y, 18, -Math.PI / 2, -Math.PI / 2 + Math.min(1, (held - 300) / 1200) * Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("resize", size);
    };
  }, [feed]);
  return <canvas ref={cv} className="rec-trail" />;
}

const short = (p: string) => {
  const s = p.replace(/\s*\(node \d+\)/, "");
  return s.length > 72 ? `${s.slice(0, 69)}…` : s;
};
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

/**
 * Press `R` (or the button) to start talking to the room's brain. Where you point while you talk
 * is captured too; stopping posts one prompt. The mic keeps running the whole time.
 * `text` is optional typed text to send along (for rooms where nobody has a mic).
 */
export function RecordPrompt({ personId, brainName, text }: { personId: string; brainName: string; text?: string }) {
  const { levels } = useHub();
  const [rec, setRec] = useState<RecState>({ phase: "idle" });
  const [now, setNow] = useState(0);
  const [result, setResult] = useState<RecResult | null>(null);
  const recorder = useRef<PointerRecorder | null>(null);
  const feed = useRef<{ push: ((s: TrailSample) => void) | null }>({ push: null });
  const recRef = useRef(rec);
  recRef.current = rec;
  const typed = useRef(text);
  typed.current = text;

  useEffect(() => {
    if (rec.phase !== "live") return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [rec.phase]);

  const start = () => {
    if (recRef.current.phase !== "idle") return;
    const t0 = hub.now();
    const r = (recorder.current = new PointerRecorder());
    r.onSample = (s) => feed.current.push?.(s);
    r.start();
    setResult(null);
    setNow(Date.now());
    setRec({ phase: "live", t0 });
    api("/prompt-window/start", { deviceId: hub.deviceId, t0 }).catch(() => {});
  };

  const stop = async () => {
    const cur = recRef.current;
    const r = recorder.current;
    if (cur.phase !== "live" || !r) return;
    const t1 = hub.now();
    setRec({ phase: "sending" });
    try {
      const pointer = await r.stop();
      const res = await api<{ ok: boolean; text?: string; pointed?: string[]; reason?: string }>("/prompt-window", {
        deviceId: hub.deviceId,
        personId,
        t0: cur.t0,
        t1,
        pointer,
        ...(typed.current ? { text: typed.current } : {}),
      });
      setResult({ ok: !!res.ok, text: res.text ?? "", pointed: res.pointed ?? [], reason: res.reason });
    } catch (e) {
      setResult({ ok: false, text: "", pointed: [], reason: e instanceof Error ? e.message : "Couldn't send that." });
    }
    setRec({ phase: "idle" });
  };

  const toggle = () => (recRef.current.phase === "live" ? void stop() : start());

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.key === "r" || e.key === "R") toggle();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  useEffect(
    () => () => {
      void recorder.current?.stop();
    },
    [],
  );

  // Fade the result away.
  useEffect(() => {
    if (!result || result.out) return;
    const a = setTimeout(() => setResult((r) => (r ? { ...r, out: true } : r)), 7500);
    const b = setTimeout(() => setResult(null), 7850);
    return () => (clearTimeout(a), clearTimeout(b));
  }, [result]);

  const live = rec.phase === "live";
  const db = levels[hub.deviceId];
  const pct = db == null ? 0 : Math.max(0, Math.min(1, (db + 70) / 55));
  const shape = [0.55, 0.85, 1, 0.7, 0.45];

  return (
    <>
      <button className={`rec-btn ${live ? "live" : ""} ${rec.phase === "sending" ? "busy" : ""}`} onClick={toggle} aria-pressed={live} title={live ? "Stop and send (R)" : `Talk to ${brainName} and point (R)`}>
        {rec.phase === "sending" ? <span className="rec-spin" /> : <span className="rec-dot" />}
        {live ? (
          <>
            <span className="rec-time">{clock(Math.max(0, hub.now() - rec.t0 + 0 * now))}</span>
            <span className="rec-bars">
              {shape.map((w, i) => (
                <i key={i} style={{ height: 4 + pct * 14 * w }} />
              ))}
            </span>
            Stop
          </>
        ) : rec.phase === "sending" ? (
          "Sending…"
        ) : (
          <>
            Record
            <kbd>R</kbd>
          </>
        )}
      </button>
      {live && createPortal(<><div className="rec-edge" /><Trail feed={feed} /></>, document.body)}
      {result &&
        createPortal(
          <div className={`rec-toast ${result.ok ? "" : "err"} ${result.out ? "out" : ""}`} role="status">
            <span className="tick">
              <Icon d={result.ok ? I.check : "M12 8v5m0 3.5v.01"} size={15} />
            </span>
            <div>
              <h4>{result.ok ? `Sent to ${brainName}` : "Nothing sent"}</h4>
              <p>{result.ok ? `“${result.text.length > 180 ? `${result.text.slice(0, 177)}…` : result.text}”` : result.reason || "Nothing was heard in that recording."}</p>
              {result.ok && result.pointed.length > 0 && (
                <ul>
                  <li style={{ color: "var(--text)" }}>pointed at {result.pointed.length === 1 ? "1 thing" : `${result.pointed.length} things`}</li>
                  {result.pointed.slice(0, 3).map((p, i) => (
                    <li key={i}>{short(p)}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
