// A calm, non-blocking pill at the bottom centre of the screen that says what the
// connection is doing and that nothing is lost. Mount once near the app root:
//   <ConnectionBanner />
import { useEffect, useRef, useState } from "react";
import { connectUrl, hub, useHub } from "./hub";
import { useBufferedAudio } from "./mic";
import { applyUpdate, useOutbox, useUpdateAvailable } from "./offline";

const secs = (n: number) => (n < 60 ? `${Math.max(1, Math.round(n))}s` : `${Math.floor(n / 60)}m ${Math.round(n % 60)}s`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const GRACE_MS = 1000; // short blips never show anything
const TOAST_MS = 4200;

export function ConnectionBanner() {
  const { status } = useHub();
  const ob = useOutbox();
  const au = useBufferedAudio();
  const update = useUpdateAvailable();
  const [tick, setTick] = useState(0);
  const [outage, setOutage] = useState<{ synced: number; uploaded: number } | null>(null);
  const latest = useRef({ synced: ob.synced, uploaded: au.uploaded });
  latest.current = { synced: ob.synced, uploaded: au.uploaded };

  const down = status === "connecting" || status === "offline";
  const busy = ob.pending > 0 || au.segments > 0;

  // Open an "episode" once trouble lasts longer than a blink.
  useEffect(() => {
    if (outage || !(down || busy) || status === "unauthorized") return;
    const t = setTimeout(() => setOutage({ ...latest.current }), GRACE_MS);
    return () => clearTimeout(t);
  }, [down, busy, outage, status]);

  // Back and drained: show the summary briefly, then close the episode.
  useEffect(() => {
    if (!outage || down || busy || status === "unauthorized") return;
    const t = setTimeout(() => setOutage(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [outage, down, busy, status]);

  // One-second clock while something is on screen (for "last heard 8s ago").
  const showing = status === "unauthorized" || !!outage || update;
  useEffect(() => {
    if (!showing) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [showing]);

  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const bits: string[] = [];
  if (ob.pending) bits.push(`${plural(ob.pending, "change")} waiting`);
  if (au.seconds > 0) bits.push(`${secs(au.seconds)} of voice saved`);
  void tick;
  const quiet = hub.lastContact ? Math.round((Date.now() - hub.lastContact) / 1000) : 0;

  let kind: "auth" | "down" | "back" | "update" | null = null;
  if (status === "unauthorized") kind = "auth";
  else if (outage) kind = down ? "down" : "back";
  else if (update) kind = "update";
  if (!kind) return null;

  const synced = outage ? ob.synced - outage.synced + (au.uploaded - outage.uploaded) : 0;

  return (
    <>
      <style>{CSS}</style>
      <div className={`cxb cxb-${kind}`} role={kind === "auth" ? "alert" : "status"} aria-live="polite" key={kind}>
        <span className="cxb-dot" aria-hidden />
        {kind === "down" && (
          <>
            <span className="cxb-title">{offline ? "Offline" : "Reconnecting…"}</span>
            <span className="cxb-sub">your work is saved on this laptop</span>
            {bits.length > 0 && <span className="cxb-meta">{bits.join(" · ")}</span>}
            {quiet > 5 && <span className="cxb-meta cxb-quiet">last heard {secs(quiet)} ago</span>}
          </>
        )}
        {kind === "back" && (
          <>
            <span className="cxb-title">Back online</span>
            <span className="cxb-sub">
              {busy ? `sending what you saved${bits.length ? ` · ${bits.join(" · ")}` : ""}` : synced > 0 ? `synced ${plural(synced, "change")}` : "all caught up"}
            </span>
          </>
        )}
        {kind === "auth" && (
          <>
            <span className="cxb-title">This laptop isn't connected</span>
            <span className="cxb-sub">your work is saved here{bits.length ? ` · ${bits.join(" · ")}` : ""}</span>
            <a className="cxb-btn" href={connectUrl()}>
              Reconnect this laptop
            </a>
          </>
        )}
        {kind === "update" && (
          <>
            <span className="cxb-title">Update ready</span>
            <span className="cxb-sub">a newer JamSesh is installed</span>
            <button className="cxb-btn" onClick={applyUpdate}>
              Reload
            </button>
          </>
        )}
      </div>
    </>
  );
}

const CSS = `
.cxb{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:80;display:flex;align-items:center;gap:10px;
  max-width:calc(100vw - 32px);padding:9px 14px;border-radius:999px;white-space:nowrap;overflow:hidden;
  background:color-mix(in srgb,var(--panel-2) 90%,transparent);backdrop-filter:blur(16px) saturate(1.2);-webkit-backdrop-filter:blur(16px) saturate(1.2);
  border:1px solid var(--line-2);box-shadow:0 14px 44px rgba(0,0,0,.5),0 0 0 1px rgba(0,0,0,.25);
  font-size:13px;line-height:1.2;color:var(--text);animation:cxb-in .38s var(--ease) both;pointer-events:auto}
.cxb:has(.cxb-btn){padding-right:6px}
.cxb-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--directive);box-shadow:0 0 0 0 var(--directive-bg)}
.cxb-down .cxb-dot{animation:cxb-pulse 1.8s ease-in-out infinite}
.cxb-back .cxb-dot{background:var(--built)}
.cxb-auth .cxb-dot{background:var(--warn)}
.cxb-update .cxb-dot{background:var(--decision)}
.cxb-title{flex:none;font-weight:600;letter-spacing:-.005em}
.cxb-sub,.cxb-meta{color:var(--muted);overflow:hidden;text-overflow:ellipsis;min-width:0}
.cxb-meta{flex:none;font-family:var(--mono);font-size:11.5px;color:var(--dim);padding-left:10px;border-left:1px solid var(--line-2)}
.cxb-btn{flex:none;margin-left:4px;padding:7px 13px;border-radius:999px;border:0;background:var(--text);color:var(--bg);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;text-decoration:none;transition:transform .15s var(--ease),opacity .15s}
.cxb-btn:hover{transform:translateY(-1px);opacity:.92}
.cxb-btn:focus-visible{outline:2px solid var(--decision);outline-offset:2px}
@keyframes cxb-in{from{opacity:0;transform:translate(-50%,10px) scale(.97)}to{opacity:1;transform:translate(-50%,0) scale(1)}}
@keyframes cxb-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,181,74,.45)}50%{box-shadow:0 0 0 6px rgba(255,181,74,0)}}
@media (max-width:720px){.cxb-sub{display:none}}
@media (prefers-reduced-motion:reduce){.cxb,.cxb-dot{animation:none!important}}
`;
