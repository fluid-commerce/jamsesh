// A live Simulator or Mac app on a tile (6.3): the host streams JPEG frames over a WebSocket, the tile
// draws them, and whoever holds control sends taps, drags and button presses back through the API.
import { useContext, useEffect, useRef, useState } from "react";
import { api, type LiveApp, type Person } from "./hub";
import { registerDriveTarget, type TileEvent } from "./driving";
import { ExpandCtx } from "./ui";
import "./liveapp.css";

let mine: string | null = null;
/** This window's person id, as the hub knows it. */
function useMe() {
  const [id, setId] = useState(mine);
  useEffect(() => {
    if (mine) return;
    api<{ person: { id: string } | null }>("/me").then((r) => setId((mine = r.person?.id ?? null))).catch(() => {});
  }, []);
  return id;
}

const TAP_SLOP = 8;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function LiveAppView({ app, people }: { app: LiveApp; people: Person[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [live, setLive] = useState(false);
  const [dims, setDims] = useState<[number, number] | null>(null);
  const [msg, setMsg] = useState("");
  const [ripple, setRipple] = useState<{ x: number; y: number; k: number } | null>(null);
  const interactive = !!useContext(ExpandCtx);
  const me = useMe();
  // On a locked big screen the screen's drivers drive the tile; otherwise its own controller does.
  const onScreen = !!app.viaScreen;
  const driving = !!me && (onScreen ? !!app.drivers?.some((d) => d.personId === me) : app.controller?.personId === me);
  const turned = app.orientation === "landscape-left";
  const KEYS: Record<string, string> = { Enter: "return", Backspace: "delete", Tab: "tab", Escape: "escape" };
  const down = useRef<{ x: number; y: number; px: number; py: number; t: number; moved: boolean; at: number } | null>(null);

  // Frames in. The newest wins: a frame that arrives while one is still decoding replaces the waiting one.
  useEffect(() => {
    if (app.status !== "live") return;
    let ws: WebSocket | null = null;
    let dead = false;
    let retry = 0;
    let waiting: Blob | null = null;
    let busy = false;
    const draw = async () => {
      if (busy) return;
      busy = true;
      while (waiting && !dead) {
        const blob = waiting;
        waiting = null;
        try {
          const bmp = await createImageBitmap(blob);
          const c = canvas.current;
          const ctx = c?.getContext("2d");
          if (c && ctx) {
            // In window capture the Simulator's own window has already turned.
            const rot = app.orientation === "landscape-left" && app.capture !== "window";
            const w = rot ? bmp.height : bmp.width;
            const h = rot ? bmp.width : bmp.height;
            if (c.width !== w || c.height !== h) (c.width = w), (c.height = h), setDims([w, h]);
            // The framebuffer holds the turned screen sideways (a quarter turn counter-clockwise); turn it back upright.
            if (rot) ctx.setTransform(0, 1, -1, 0, bmp.height, 0);
            else ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(bmp, 0, 0);
            setLive(true);
          }
          bmp.close();
        } catch {}
      }
      busy = false;
    };
    const open = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/app/${app.id}`);
      ws.binaryType = "blob";
      ws.onmessage = (e) => {
        if (typeof e.data === "string") return;
        retry = 0;
        waiting = e.data as Blob;
        void draw();
      };
      ws.onclose = () => {
        if (!dead && retry++ < 8) setTimeout(open, Math.min(4000, 400 * retry));
      };
    };
    open();
    return () => {
      dead = true;
      ws?.close();
    };
  }, [app.id, app.status, app.orientation, app.capture]);

  const send = (body: Record<string, unknown>, as?: string) =>
    api<{ ok: boolean; error?: string }>(`/apps/${app.id}/input`, as ? { ...body, as } : body, "POST", { queue: false }).then(
      (r) => setMsg(r.ok ? "" : (r.error ?? "")),
      (e) => setMsg(e?.message ?? "That didn't go through."),
    );
  const control = (action: "take" | "release" | "pass", to?: string) => api<{ result: string }>(`/apps/${app.id}/control`, { action, to }, "POST", { queue: false }).then((r) => setMsg(/driving|released|already/i.test(r.result) ? "" : r.result), (e) => setMsg(e?.message ?? ""));

  const at = (e: React.PointerEvent | React.WheelEvent) => {
    const r = canvas.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return null;
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };
  const mac = app.kind === "mac";
  const onDown = (e: React.PointerEvent) => {
    const p = at(e);
    if (!driving || !p) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    down.current = { ...p, px: e.clientX, py: e.clientY, t: Date.now(), moved: false, at: 0 };
    if (mac) void send({ t: "down", ...p });
  };
  const onMove = (e: React.PointerEvent) => {
    const d = down.current;
    if (!d) return;
    if (Math.hypot(e.clientX - d.px, e.clientY - d.py) > TAP_SLOP) d.moved = true;
    const p = at(e);
    if (mac && p && Date.now() - d.at > 40) (d.at = Date.now()), void send({ t: "move", ...p });
  };
  const onUp = (e: React.PointerEvent) => {
    const d = down.current;
    down.current = null;
    const p = at(e);
    if (!d || !p) return;
    if (mac) return void send(d.moved ? { t: "up", ...p } : { t: "up", x: d.x, y: d.y });
    if (d.moved) void send({ t: "swipe", x: d.x, y: d.y, x2: p.x, y2: p.y, ms: Date.now() - d.t });
    else {
      void send({ t: "tap", ...p });
      setRipple({ x: p.x, y: p.y, k: Date.now() });
    }
  };
  // Typing goes to the app while the tile has focus and you're driving.
  const onKey = (e: React.KeyboardEvent) => {
    if (!driving || e.metaKey || e.ctrlKey || e.altKey) return;
    const named = KEYS[e.key];
    if (named) void send({ t: "key", key: named });
    else if (e.key.length === 1) void send({ t: "text", text: e.key });
    else return;
    e.preventDefault();
  };
  const onWheel = (e: React.WheelEvent) => {
    const p = at(e);
    if (!driving || !p || !mac) return;
    void send({ t: "scroll", ...p, dx: -e.deltaX, dy: -e.deltaY });
  };

  // A driver's dart over this tile on the big screen (6.1 replays it in that window) becomes the same taps and keys a person's own pointer makes.
  const replay = useRef<Map<string, { x: number; y: number; t: number; moved: boolean; at: number }>>(new Map());
  useEffect(() => {
    const el = canvas.current;
    if (!el || app.status !== "live") return;
    const macApp = app.kind === "mac";
    return registerDriveTarget(el, (ev: TileEvent, who: string) => {
      const st = replay.current;
      if (ev.k === "key") {
        if (!ev.down) return;
        const named = KEYS[ev.key];
        if (named) void send({ t: "key", key: named }, who);
        else if (ev.key.length === 1 && !ev.mods?.meta && !ev.mods?.ctrl) void send({ t: "text", text: ev.key }, who);
        return;
      }
      if (ev.k === "leave") return void st.delete(who);
      const p = { x: clamp01(ev.lx), y: clamp01(ev.ly) };
      if (ev.k === "wheel") return void (macApp && send({ t: "scroll", ...p, dx: -ev.dx, dy: -ev.dy }, who));
      const d = st.get(who);
      if (ev.k === "down") {
        st.set(who, { ...p, t: Date.now(), moved: false, at: 0 });
        if (macApp) void send({ t: "down", ...p }, who);
      } else if (ev.k === "move" && d) {
        if (Math.hypot(p.x - d.x, p.y - d.y) > 0.02) d.moved = true;
        if (macApp && Date.now() - d.at > 40) (d.at = Date.now()), void send({ t: "move", ...p }, who);
      } else if (ev.k === "up" && d) {
        st.delete(who);
        if (macApp) void send(d.moved ? { t: "up", ...p } : { t: "up", x: d.x, y: d.y }, who);
        else if (d.moved) void send({ t: "swipe", x: d.x, y: d.y, x2: p.x, y2: p.y, ms: Date.now() - d.t }, who);
        else (void send({ t: "tap", ...p }, who), setRipple({ x: p.x, y: p.y, k: Date.now() }));
      }
    });
  }, [app.id, app.status, app.kind]);

  const ratio = dims ? dims[0] / dims[1] : turned ? app.height / app.width : (app.width || 9) / (app.height || 19.5);
  const holder = app.controller;
  const others = people.filter((p) => p.id !== me);

  if (app.status === "gone") return <div className="empty-note">{app.name} is no longer live.{app.note ? ` ${app.note}` : ""}</div>;
  return (
    <div className="liveapp">
      <div className={`liveapp-stage ${app.kind}`}>
        <div className={`liveapp-device ${app.kind} ${driving ? "driving" : ""}`} style={{ ["--r" as string]: ratio }}>
          <canvas ref={canvas} className="liveapp-screen" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => (down.current = null)} onWheel={onWheel} onKeyDown={onKey} tabIndex={driving ? 0 : -1} style={{ touchAction: driving ? "none" : "auto", cursor: driving ? "pointer" : "default" }} />
          {ripple && <span key={ripple.k} className="liveapp-tap" style={{ left: `${ripple.x * 100}%`, top: `${ripple.y * 100}%` }} />}
          {!live && <div className="liveapp-wait">Connecting to {app.name}…</div>}
        </div>
      </div>
      <div className="liveapp-bar">
        <span className="liveapp-who">
          {onScreen
            ? app.drivers?.length
              ? driving
                ? "You're driving the big screen"
                : `${app.drivers.map((d) => d.name).join(" and ")} ${app.drivers.length > 1 ? "are" : "is"} driving the big screen`
              : "Nobody is driving the big screen"
            : holder
              ? driving
                ? "You're driving"
                : `${holder.name} is driving`
              : "Nobody is driving"}
        </span>
        {interactive && (
          <>
            {!driving && !onScreen && (
              <button type="button" className="btn" onClick={() => control("take")}>
                Take control
              </button>
            )}
            {driving && (
              <>
                {app.kind === "ios" && (
                  <>
                    <button type="button" className="btn" disabled={!app.canTap} onClick={() => send({ t: "home" })}>
                      Home
                    </button>
                    <button type="button" className="btn" disabled={!app.canTap} onClick={() => send({ t: "rotate" })}>
                      Rotate
                    </button>
                    <button type="button" className="btn" onClick={() => send({ t: "appearance" })}>
                      {app.appearance === "dark" ? "Light" : "Dark"}
                    </button>
                  </>
                )}
                {!onScreen && others.length > 0 && (
                  <select className="btn" value="" onChange={(e) => e.target.value && control("pass", e.target.value)} aria-label="Pass control to">
                    <option value="">Pass to…</option>
                    {others.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
                {!onScreen && (
                  <button type="button" className="btn" onClick={() => control("release")}>
                    Release
                  </button>
                )}
              </>
            )}
          </>
        )}
        {app.kind === "ios" && app.capture && <span className="liveapp-mode">{app.capture === "window" ? "30 fps" : "Screenshots"}</span>}
        {(msg || (!app.canTap && app.note) || (app.capture === "screenshots" && app.hint)) && <span className="liveapp-note">{msg || (!app.canTap && app.note) || app.hint}</span>}
      </div>
    </div>
  );
}
