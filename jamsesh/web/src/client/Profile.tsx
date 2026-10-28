import { useEffect, useRef, useState } from "react";
import { api, type Person } from "../shared/hub";
import { encodeWav, holdMic } from "../shared/mic";
import { PhotoAvatar, ProfilePhoto } from "../shared/share";
import { mediaAvailable } from "../shared/rtc";
import { WhereChooser } from "./ClientView";

/** Your profile: photo, name, title, and the voice sample JamSesh recognizes you by. */
export function ProfileDrawer({ me, brainName, onClose, micError }: { me: Person; brainName: string; onClose: () => void; micError?: string | null }) {
  const [photo, setPhoto] = useState(false);
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && !photo && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose, photo]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer profile-drawer scrollbars-thin" style={{ width: "min(440px, 100vw)" }} role="dialog" aria-label="Your profile">
        <header>
          <h2>Your profile</h2>
          <button className="btn small drawer-done" onClick={onClose}>
            Done
          </button>
        </header>
        <div className="body">
          <div className="section" style={{ display: "grid", justifyItems: "center", gap: 12, textAlign: "center" }}>
            {photo ? (
              <ProfilePhoto person={me} onDone={() => setPhoto(false)} />
            ) : (
              <>
                <PhotoAvatar person={me} size={96} />
                <button className="btn small" onClick={() => setPhoto(true)}>
                  {me.photo ? "Retake photo" : "Take a photo"}
                </button>
              </>
            )}
          </div>
          <div className="section">
            <label className="field">
              <span>Name</span>
              <input defaultValue={me.name} autoComplete="given-name" autoCapitalize="words" enterKeyHint="next" onBlur={(e) => e.target.value.trim() && e.target.value !== me.name && api(`/people/${me.id}`, { name: e.target.value.trim() }, "PATCH")} />
            </label>
            <label className="field">
              <span>Title</span>
              <input defaultValue={me.role} placeholder="For example Design lead, Engineer, CPO" autoCapitalize="sentences" enterKeyHint="done" onBlur={(e) => e.target.value !== me.role && api(`/people/${me.id}`, { role: e.target.value.trim() }, "PATCH")} />
            </label>
            <p className="help" style={{ margin: 0 }}>
              {brainName} uses your title to weigh calls when people disagree, and agents see it next to your name.
            </p>
          </div>
          <div className="section">
            <h3>Where you are</h3>
            <p className="help">Remote devices are kept apart from the room's microphones, show the big screen in the Screen tab, and play {brainName}'s voice here.</p>
            <WhereChooser compact />
          </div>
          <VoiceEnroll me={me} brainName={brainName} micError={micError} />
        </div>
      </aside>
    </>
  );
}

// No wake word in it: the room's microphones hear this too, and the brain must not answer it.
const SENTENCE =
  "This is my voice. When I ask for something to go up on the big screen, or to send a change to my agent, this is how I sound. I talk like this while I work, so here is me describing what I see: the layout, the colors, the spacing, and what I would change next on this screen.";

/** Read one sentence; the hub turns it into a voiceprint so lines are attributed right from the start. */
export function VoiceEnroll({ me, brainName, micError }: { me: Person; brainName: string; micError?: string | null }) {
  const [state, setState] = useState<"idle" | "recording" | "saving" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const [secs, setSecs] = useState(0);
  const rec = useRef<{ stop: () => void } | null>(null);

  // Over plain http (the default LAN join address) the browser has no mic API at all.
  const blocked = micError || (mediaAvailable()?.replace("Sharing", "Reading aloud") ?? ("getUserMedia" in (navigator.mediaDevices ?? {}) ? null : "This page can't use the microphone. Open the host's secure address."));

  const start = async () => {
    if (blocked) return setState("error"), setMsg(blocked);
    // Your own laptop's always-on mic hears you read this; keep it from sending it to the room.
    const release = holdMic();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
      const chunks: Blob[] = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => chunks.push(e.data);
      const t0 = Date.now();
      const tick = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 250);
      const auto = setTimeout(() => mr.state === "recording" && mr.stop(), 30_000);
      mr.onstop = async () => {
        release();
        clearInterval(tick);
        clearTimeout(auto);
        stream.getTracks().forEach((t) => t.stop());
        setState("saving");
        try {
          const wav = await toWav16k(new Blob(chunks, { type: mr.mimeType }));
          const r = await fetch(`/api/people/${me.id}/voice`, { method: "POST", headers: { "content-type": "audio/wav" }, body: wav }).then((x) => x.json());
          if (r.ok) (setState("done"), setMsg(`${brainName} knows your voice (${r.samples} samples).`));
          else (setState("error"), setMsg(r.reason ?? r.error ?? "That didn't work. Try again."));
        } catch (e) {
          setState("error");
          setMsg(String(e));
        }
      };
      rec.current = { stop: () => mr.state === "recording" && mr.stop() };
      mr.start();
      setSecs(0);
      setState("recording");
    } catch (e) {
      release();
      setState("error");
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="section">
      <h3>Teach {brainName} your voice</h3>
      <p className="help">
        Read this out loud. It takes about twenty seconds and makes speaker recognition much better, especially when you walk around the room.
        {me.voiceSamples ? ` You have ${me.voiceSamples} voice sample${me.voiceSamples === 1 ? "" : "s"} so far.` : ""}
      </p>
      <blockquote style={{ margin: "0 0 14px", padding: "14px 16px", borderRadius: 14, background: "var(--panel)", border: "1px solid var(--line)", fontSize: 17, lineHeight: 1.45, color: state === "recording" ? "var(--text)" : "var(--muted)" }}>
        {SENTENCE}
      </blockquote>
      <div className="row">
        {state === "recording" ? (
          <button className="btn" onClick={() => rec.current?.stop()} style={{ borderColor: "rgba(255,107,94,.5)", color: "var(--warn)" }}>
            <span className="dot" style={{ background: "var(--warn)", animation: "pulse 1s infinite" }} /> Done reading · {secs}s
          </button>
        ) : (
          <button className="btn primary" onClick={start} disabled={state === "saving" || !!blocked}>
            {state === "saving" ? "Learning your voice…" : state === "done" ? "Record again" : "Start reading"}
          </button>
        )}
        {blocked && !msg && <span className="chip" style={{ whiteSpace: "normal", color: "var(--warn)" }}>{blocked}</span>}
        {msg && <span className="chip" style={{ whiteSpace: "normal", color: state === "error" ? "var(--warn)" : "var(--built)" }}>{msg}</span>}
      </div>
    </div>
  );
}

async function toWav16k(blob: Blob): Promise<ArrayBuffer> {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  await ctx.close();
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return encodeWav(out.getChannelData(0));
}
