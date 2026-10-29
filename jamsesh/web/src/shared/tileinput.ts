// What a live app tile sends for a driver's pointer, kept apart from React so its ordering and release rules can be tested.
import type { TileEvent } from "./driving";

export type Body = Record<string, unknown>;
export type Press = { x: number; y: number; t: number; moved: boolean; at: number; lx?: number; ly?: number };

/** Runs sends one after another: a Mac press is down, moves, up, and they must land in that order. A drag that outruns the Mac drops extra moves, never a down or an up. */
export function inOrder(run: (body: Body, as?: string) => Promise<unknown>) {
  let tail: Promise<unknown> = Promise.resolve();
  let backlog = 0;
  return (body: Body, as?: string) => {
    if (body.t === "move" && backlog > 2) return;
    backlog++;
    tail = tail.then(() => run(body, as)).catch(() => {}).finally(() => backlog--);
  };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * A driver's input over a tile on the big screen becomes the tile's own taps, drags and keys. Leaving with a button down
 * releases it where it last was, so the Mac never keeps a press nobody holds.
 */
export function replayTileEvent(st: Map<string, Press>, ev: TileEvent, who: string, mac: boolean, send: (b: Body, as?: string) => void, keys: Record<string, string>, tapped: (x: number, y: number) => void, now = Date.now()) {
  if (ev.k === "key") {
    if (!ev.down) return;
    const named = keys[ev.key];
    if (named) send({ t: "key", key: named }, who);
    else if (ev.key.length === 1 && !ev.mods?.meta && !ev.mods?.ctrl) send({ t: "text", text: ev.key }, who);
    return;
  }
  if (ev.k === "leave") {
    const held = st.get(who);
    st.delete(who);
    if (held && mac) send({ t: "up", x: held.lx ?? held.x, y: held.ly ?? held.y }, who);
    return;
  }
  const p = { x: clamp01(ev.lx), y: clamp01(ev.ly) };
  if (ev.k === "wheel") return void (mac && send({ t: "scroll", ...p, dx: -ev.dx, dy: -ev.dy }, who));
  const d = st.get(who);
  if (ev.k === "down") {
    st.set(who, { ...p, t: now, moved: false, at: 0 });
    if (mac) send({ t: "down", ...p }, who);
  } else if (ev.k === "move" && d) {
    if (Math.hypot(p.x - d.x, p.y - d.y) > 0.02) d.moved = true;
    (d.lx = p.x), (d.ly = p.y);
    if (mac && now - d.at > 40) (d.at = now), send({ t: "move", ...p }, who);
  } else if (ev.k === "up" && d) {
    st.delete(who);
    if (mac) send(d.moved ? { t: "up", ...p } : { t: "up", x: d.x, y: d.y }, who);
    else if (d.moved) send({ t: "swipe", x: d.x, y: d.y, x2: p.x, y2: p.y, ms: now - d.t }, who);
    else (send({ t: "tap", ...p }, who), tapped(p.x, p.y));
  }
}
