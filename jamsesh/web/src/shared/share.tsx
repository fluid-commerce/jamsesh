import { useCallback, useEffect, useRef, useState } from "react";
import { api, hub, useHub, type Person, type Share } from "./hub";
import { mediaAvailable, publish, stopPublishing, useWatch, usePublications } from "./rtc";
import "./share.css";

const KIND_WORD = { screen: "screen", camera: "camera" } as const;

function failText(e: unknown): string | null {
  const err = e as DOMException;
  if (err?.name === "NotAllowedError" || err?.name === "AbortError") return null; // user said no: say nothing
  if (err?.name === "NotFoundError") return "No camera found.";
  if (err?.name === "NotReadableError") return "That camera is busy in another app.";
  return err?.message || "Couldn't start sharing.";
}

// ---------------------------------------------------------------------------------------------
// Avatar with profile photo
// ---------------------------------------------------------------------------------------------

function initialsOf(name: string) {
  const parts = name.replace(/'s\b.*/, "").trim().split(/\s+/);
  return (parts[0]?.[0] ?? "?").toUpperCase() + (parts[1]?.[0]?.toUpperCase() ?? "");
}

/** Same look as the Avatar in ui.tsx, but shows the person's profile photo when they have one. */
export function PhotoAvatar({ person, size = 28 }: { person: Pick<Person, "name" | "color" | "photo">; size?: number }) {
  return person.photo ? (
    <img className="avatar shr-photo-avatar" src={person.photo} alt={person.name} title={person.name} style={{ width: size, height: size }} />
  ) : (
    <span className="avatar" style={{ background: person.color, width: size, height: size, fontSize: size * 0.42 }} title={person.name}>
      {initialsOf(person.name)}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Tile: a live share filling its parent
// ---------------------------------------------------------------------------------------------

export function ShareTile({ share }: { share: Share }) {
  const { stream, status, attempts } = useWatch(share);
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    setPlaying(false);
    if (stream) v.play().catch(() => {});
  }, [stream]);

  const first = share.personName.split(/\s+/)[0] || "Someone";
  const word = KIND_WORD[share.kind];
  const live = status === "live" && playing;

  return (
    <div className={`shr-tile ${share.kind}`}>
      <video ref={video} muted autoPlay playsInline onPlaying={() => setPlaying(true)} onEmptied={() => setPlaying(false)} className={live ? "on" : ""} />
      {!live && (
        <div className="shr-connecting" role="status">
          <span className="shr-spin" />
          <span>{attempts > 4 ? `Waiting for ${first}'s ${word}…` : `Connecting to ${first}'s ${word}…`}</span>
        </div>
      )}
      <div className="shr-chip">
        <span className="shr-dot" data-live={live} />
        <b>{share.personName}</b>
        <span>{share.kind === "screen" ? "Screen" : "Camera"}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Start / stop controls
// ---------------------------------------------------------------------------------------------

async function startShare(kind: Share["kind"], shareId?: string): Promise<Share> {
  const pub = await publish(kind, shareId);
  try {
    return await api<Share>("/shares", { deviceId: hub.deviceId, kind, shareId: pub.shareId });
  } catch (e) {
    await stopPublishing(pub.shareId, { notifyHub: false });
    throw e;
  }
}

export function ShareControls({ personId }: { personId: string }) {
  const { state } = useHub();
  const pubs = usePublications();
  const [busy, setBusy] = useState<Share["kind"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mine = (state?.shares ?? []).filter((s) => s.status === "live" && s.deviceId === hub.deviceId && (!s.personId || s.personId === personId));
  const active = (k: Share["kind"]) => pubs.find((p) => p.kind === k) ?? null;
  const blocked = mediaAvailable();

  const toggle = async (kind: Share["kind"]) => {
    setError(null);
    const cur = active(kind);
    if (cur) return void stopPublishing(cur.shareId);
    setBusy(kind);
    try {
      await startShare(kind);
    } catch (e) {
      setError(failText(e));
    } finally {
      setBusy(null);
    }
  };

  const anyLive = pubs.length > 0;
  return (
    <div className="shr-controls" data-live={anyLive || mine.length > 0}>
      {(["screen", "camera"] as const).map((kind) => {
        const on = !!active(kind);
        return (
          <button
            key={kind}
            type="button"
            className={`shr-btn ${on ? "on" : ""}`}
            aria-pressed={on}
            disabled={!!blocked || busy === kind}
            title={blocked ?? (on ? `Stop sharing your ${kind}` : kind === "screen" ? "Share your screen with the room" : "Share your camera with the room")}
            onClick={() => toggle(kind)}
          >
            <span className="shr-ico">{kind === "screen" ? <ScreenIcon /> : <CameraIcon />}</span>
            {on ? (kind === "screen" ? "Sharing screen" : "Camera on") : kind === "screen" ? "Share screen" : "Camera"}
          </button>
        );
      })}
      {anyLive && (
        <button type="button" className="shr-btn stop" onClick={() => pubs.forEach((p) => stopPublishing(p.shareId))}>
          Stop
        </button>
      )}
      {error && (
        <span className="shr-err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// "Can we see your screen?" prompt
// ---------------------------------------------------------------------------------------------

interface Request {
  shareId: string;
  kind: Share["kind"];
  reason: string;
  by: string;
}

export function ShareRequestPrompt() {
  const { state } = useHub();
  const [queue, setQueue] = useState<Request[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const off = hub.onMessage((m) => {
      if (m?.type !== "share-request" || !m.deviceIds?.includes(hub.deviceId)) return;
      setQueue((q) => (q.some((r) => r.shareId === m.shareId) ? q : [...q, { shareId: m.shareId, kind: m.kind, reason: m.reason, by: m.by }]));
    });
    return () => void off();
  }, []);

  // A request answered elsewhere (another window of mine, the host, a timeout) goes away.
  useEffect(() => {
    if (!state) return;
    setQueue((q) => {
      const next = q.filter((r) => {
        const sh = state.shares.find((s) => s.id === r.shareId);
        return !sh || sh.status === "requested";
      });
      return next.length === q.length ? q : next;
    });
  }, [state]);

  const req = queue[0];
  const pop = useCallback(() => {
    setError(null);
    setQueue((q) => q.slice(1));
  }, []);

  const decline = useCallback(() => {
    if (!req) return;
    api(`/shares/${req.shareId}/decline`, {}).catch(() => {});
    pop();
  }, [req, pop]);

  const share = useCallback(async () => {
    if (!req || busy) return;
    setBusy(true);
    setError(null);
    try {
      await startShare(req.kind, req.shareId);
      pop();
    } catch (e) {
      setError(failText(e) ?? "Sharing was cancelled. Try again, or choose Not now.");
    } finally {
      setBusy(false);
    }
  }, [req, busy, pop]);

  useEffect(() => {
    if (!req) return;
    accept.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") (e.preventDefault(), decline());
      else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement && e.target.dataset.role === "decline")) (e.preventDefault(), share());
      else if (e.key === "Tab") (e.preventDefault(), (document.activeElement === accept.current ? declineBtn.current : accept.current)?.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req, decline, share]);
  const declineBtn = useRef<HTMLButtonElement>(null);

  if (!req) return null;
  const what = req.kind === "screen" ? "your screen" : "your camera";
  return (
    <div className="shr-scrim" onMouseDown={(e) => e.target === e.currentTarget && decline()}>
      <div className="shr-card" role="alertdialog" aria-modal="true" aria-labelledby="shr-title" aria-describedby="shr-body">
        <div className="shr-card-ico">{req.kind === "screen" ? <ScreenIcon big /> : <CameraIcon big />}</div>
        <h2 id="shr-title">
          {req.by} would like to see {what}
        </h2>
        <p id="shr-body">{req.reason || "They'll see it live in the room until you stop sharing."}</p>
        {req.reason && <p className="shr-note">Live in the room until you stop sharing.</p>}
        {(mediaAvailable() || error) && <p className="shr-err" role="alert">{mediaAvailable() ?? error}</p>}
        <div className="shr-actions">
          <button ref={declineBtn} data-role="decline" type="button" className="shr-btn ghost" onClick={decline}>
            Not now
          </button>
          <button ref={accept} type="button" className="shr-btn primary" disabled={busy || !!mediaAvailable()} onClick={share}>
            {req.kind === "screen" ? "Share screen" : "Share camera"}
          </button>
        </div>
        {queue.length > 1 && <div className="shr-more">{queue.length - 1} more waiting</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Profile photo capture
// ---------------------------------------------------------------------------------------------

const PHOTO_PX = 512;

function cropSquare(src: CanvasImageSource, w: number, h: number, mirror = false): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = PHOTO_PX;
  const side = Math.min(w, h);
  const ctx = c.getContext("2d")!;
  if (mirror) (ctx.translate(PHOTO_PX, 0), ctx.scale(-1, 1));
  ctx.drawImage(src, (w - side) / 2, (h - side) / 2, side, side, 0, 0, PHOTO_PX, PHOTO_PX);
  return c;
}

export function ProfilePhoto({ person, onDone }: { person: Person; onDone?: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [shot, setShot] = useState<{ canvas: HTMLCanvasElement; url: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openCamera = useCallback(async () => {
    setError(null);
    setReady(false);
    stream.current?.getTracks().forEach((t) => t.stop());
    const blocked = mediaAvailable();
    if (blocked) return setError(blocked);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      stream.current = s;
      if (video.current) video.current.srcObject = s;
    } catch (e) {
      setError(failText(e) ?? "Camera access was denied. You can choose a photo instead.");
    }
  }, []);

  useEffect(() => {
    void openCamera();
    return () => stream.current?.getTracks().forEach((t) => t.stop());
  }, [openCamera]);

  useEffect(() => () => void (shot && URL.revokeObjectURL(shot.url)), [shot]);

  const keep = (canvas: HTMLCanvasElement) => {
    canvas.toBlob(
      (b) => b && setShot({ canvas, url: URL.createObjectURL(b) }),
      "image/jpeg",
      0.9,
    );
  };

  const snap = () => {
    const v = video.current;
    if (!v?.videoWidth || count !== null) return;
    let n = 3;
    setCount(n);
    const t = setInterval(() => {
      n--;
      if (n > 0) return setCount(n);
      clearInterval(t);
      setCount(null);
      keep(cropSquare(v, v.videoWidth, v.videoHeight));
    }, 800);
  };

  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    try {
      const bmp = await createImageBitmap(f);
      keep(cropSquare(bmp, bmp.width, bmp.height));
    } catch {
      setError("That file isn't an image we can read.");
    }
  };

  const save = async () => {
    if (!shot) return;
    setSaving(true);
    setError(null);
    try {
      const blob: Blob = await new Promise((res, rej) => shot.canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", 0.9));
      const r = await fetch(`/api/people/${person.id}/photo`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: blob });
      if (!r.ok) throw new Error(`Couldn't save (${r.status})`);
      stream.current?.getTracks().forEach((t) => t.stop());
      onDone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const retake = () => {
    setShot(null);
    if (!stream.current?.active) void openCamera();
  };

  return (
    <div className="shr-photo">
      <div className="shr-photo-frame" data-state={shot ? "shot" : ready ? "live" : "idle"}>
        <video ref={video} muted autoPlay playsInline onPlaying={() => setReady(true)} style={{ visibility: shot ? "hidden" : "visible" }} />
        {shot && <img src={shot.url} alt={`${person.name}'s new photo`} />}
        {!shot && !ready && !error && <span className="shr-spin" />}
        {count !== null && (
          <div className="shr-count" key={count} aria-live="assertive">
            {count}
          </div>
        )}
      </div>

      <div className="shr-photo-actions">
        {shot ? (
          <>
            <button type="button" className="shr-btn ghost" onClick={retake} disabled={saving}>
              Retake
            </button>
            <button type="button" className="shr-btn primary" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Use this photo"}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="shr-btn primary" onClick={snap} disabled={!ready || count !== null}>
              {count !== null ? "Hold still…" : "Take photo"}
            </button>
            <button type="button" className="shr-btn ghost" onClick={() => file.current?.click()}>
              Choose a file
            </button>
          </>
        )}
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => (pickFile(e.target.files?.[0]), (e.target.value = ""))} />
      </div>
      {onDone && !shot && (
        <button type="button" className="shr-link" onClick={onDone}>
          Cancel
        </button>
      )}
      {error && (
        <p className="shr-err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function ScreenIcon({ big }: { big?: boolean }) {
  const s = big ? 26 : 15;
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.6" />
      <path d="M5.5 13.5h5M8 11v2.5" />
    </svg>
  );
}

function CameraIcon({ big }: { big?: boolean }) {
  const s = big ? 26 : 15;
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="1.75" y="4" width="8.5" height="8" rx="1.8" />
      <path d="M10.25 7.2 14.25 5v6l-4-2.2" />
    </svg>
  );
}
