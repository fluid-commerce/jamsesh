// The trackpad (SPEC 10.6): laid over the stage mirror while you drive. With Pointer Lock the trackpad's relative motion
// moves your cursor on the big screen and the dart stays where you left it when you lift your finger, like a real pointer.
// Where Pointer Lock isn't available (WKWebView, phones) the pointer's place over the mirror maps straight onto the stage.
// Keys are sent only while captured, so typing anywhere else in the app never reaches the big screen by mistake.
import { useEffect, useRef, useState } from "react";
import { onDriveDenied, startDriving, type DriveEvent, type DriveHandle } from "./driving";

/** Trackpad travel, in client pixels, that crosses a stage at least this wide: a small mirror still moves like a full-size one. */
const MIN_TRAVEL = 900;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Where the cursor goes after the pointer moved `mx`, `my` (client pixels) over a surface of this size. */
export function travel(pos: { x: number; y: number }, mx: number, my: number, w: number, h: number) {
  const vw = Math.max(w, MIN_TRAVEL);
  const vh = vw * (h / Math.max(w, 1));
  return { x: clamp01(pos.x + mx / vw), y: clamp01(pos.y + my / Math.max(vh, 1)) };
}

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "type" | "repeat" | "altKey" | "shiftKey" | "ctrlKey" | "metaKey">;

/**
 * What a key press does while this window has a trackpad: null when it isn't the trackpad's (it isn't captured, or
 * another field has the keyboard, so the key stays there), "release" (Esc lets go), "swallow" (an auto-repeat of a
 * key that doesn't repeat), else the event to send to the big screen. Option+R is Record's key: it stays here.
 */
export function keyAction(e: KeyLike, s: { locked: boolean; captured: boolean }, focused: boolean): DriveEvent | "release" | "swallow" | null {
  if ((!s.locked && !s.captured) || !focused) return null;
  if (e.altKey && e.code === "KeyR") return null;
  if (e.key === "Escape" && !s.locked) return "release";
  if (e.repeat && !e.key.match(/^(Arrow|Backspace|Delete|Page)/) && e.key.length > 1) return "swallow";
  return { k: "key", key: e.key, code: e.code, down: e.type === "keydown", mods: { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey } };
}

const lineDelta = (e: WheelEvent) => (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 600 : 1);

export function DriveSurface({ screen = "main" }: { screen?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [captured, setCapturedState] = useState(false);
  const [note, setNote] = useState("");
  // Captured is read by event handlers that outlive a render, so it lives in the ref and the state only paints it.
  const st = useRef({ x: 0.5, y: 0.5, locked: false, captured: false, drive: null as DriveHandle | null, pending: false });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const s = st.current;
    const setCaptured = (v: boolean) => ((s.captured = v), setCapturedState(v));
    let gone = false;
    let raf = 0;
    startDriving(screen).then(
      (h) => (gone ? void h.stop() : (s.drive = h)),
      (e) => setNote(e instanceof Error ? e.message : "Couldn't start driving."),
    );
    const offDenied = onDriveDenied((m) => m.screen === screen && setNote(m.why));
    const send = (ev: DriveEvent) => void s.drive?.send(ev);
    const flushMove = () => {
      raf = 0;
      if (s.pending) ((s.pending = false), send({ k: "move", x: s.x, y: s.y }));
    };
    const queueMove = () => {
      s.pending = true;
      if (!raf) raf = requestAnimationFrame(flushMove);
    };
    const setPos = (x: number, y: number) => ((s.x = x), (s.y = y), queueMove());
    const at = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      setPos(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height));
    };

    const onMove = (e: PointerEvent) => {
      if (s.locked) {
        const r = el.getBoundingClientRect();
        const p = travel(s, e.movementX, e.movementY, r.width, r.height);
        setPos(p.x, p.y);
      } else if (s.captured) at(e);
    };
    const onDown = (e: PointerEvent) => {
      if (!s.locked && !s.captured) {
        // First click captures the trackpad; it doesn't click through.
        el.focus();
        if (e.pointerType === "mouse" && typeof el.requestPointerLock === "function") {
          try {
            void (el.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => setCaptured(true));
          } catch {
            setCaptured(true);
          }
        } else setCaptured(true);
        return;
      }
      if (!s.locked) at(e);
      flushMove();
      send({ k: "down", x: s.x, y: s.y, b: e.button, n: Math.max(1, e.detail) });
      e.preventDefault();
    };
    const onUp = (e: PointerEvent) => {
      if (!s.locked && !s.captured) return;
      flushMove();
      send({ k: "up", x: s.x, y: s.y, b: e.button, n: Math.max(1, e.detail) });
    };
    const onWheel = (e: WheelEvent) => {
      if (!s.locked && !s.captured) return;
      e.preventDefault();
      const k = lineDelta(e);
      send({ k: "wheel", x: s.x, y: s.y, dx: e.deltaX * k, dy: e.deltaY * k, ...(e.ctrlKey ? { ctrl: true } : {}) });
    };
    const release = () => (setCaptured(false), send({ k: "leave" }));
    // Keys go to the big screen only while the trackpad itself has the keyboard: typing in another field stays there.
    const onKey = (e: KeyboardEvent) => {
      const a = keyAction(e, s, document.activeElement === el);
      if (!a) return;
      // Pointer Lock gives Esc to the browser; in the other mode it lets go.
      if (a === "release") return release();
      e.preventDefault();
      if (a !== "swallow") send(a);
    };
    // Clicking or tabbing to anything else lets go (pointer lock lets go by itself).
    const onBlur = () => s.captured && !s.locked && release();
    const onLock = () => {
      s.locked = document.pointerLockElement === el;
      setCaptured(s.locked);
      if (!s.locked) send({ k: "leave" });
      else queueMove();
    };
    const onLockError = () => setCaptured(true);
    const onLeave = () => !s.locked && send({ k: "leave" });

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    document.addEventListener("pointerlockchange", onLock);
    document.addEventListener("pointerlockerror", onLockError);
    return () => {
      gone = true;
      cancelAnimationFrame(raf);
      offDenied();
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      document.removeEventListener("pointerlockchange", onLock);
      document.removeEventListener("pointerlockerror", onLockError);
      if (document.pointerLockElement === el) document.exitPointerLock();
      s.drive?.send({ k: "leave" });
    };
  }, [screen]);

  return (
    <div ref={box} className={`drive-surface ${captured ? "captured" : ""}`} tabIndex={0} role="application" aria-label="Trackpad for the big screen" data-captured={captured ? "1" : "0"}>
      <div className="drive-hint" role="status">
        {note || (captured ? "Driving the big screen. Esc lets go." : "Click to drive the big screen with this trackpad.")}
      </div>
    </div>
  );
}
