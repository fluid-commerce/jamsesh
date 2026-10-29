import { useEffect, useRef, useState } from "react";
import { api, type Person } from "../shared/hub";
import { encodeWav } from "../shared/mic";
import { PhotoAvatar, ProfilePhoto } from "../shared/share";
import { mediaAvailable } from "../shared/rtc";
import { WhereChooser } from "./ClientView";
import { beginRead, carriesToOtherHosts, endRead, carryChoice, pullCopy, setCarryAllowed } from "../shared/voiceprint";

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

// The hub owns the wording (it recognises the read in what the room's laptops heard); this is only
// what shows if the hub can't be asked. No wake word in it: the brain must not answer it.
const FALLBACK_SCRIPT = [
  "This is my voice, and this is how I sound while I work.",
  "When I ask for something to go up on the big screen, or to send a change to my agent, it is me talking.",
  "Here is me describing what I see: the layout, the colors, the spacing, and what I would change next.",
];

/** Read a few sentences; the hub turns them into a voiceprint so lines are attributed right from the start. */
export function VoiceEnroll({ me, brainName, micError }: { me: Person; brainName: string; micError?: string | null }) {
  const [state, setState] = useState<"idle" | "recording" | "saving" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const [secs, setSecs] = useState(0);
  const [script, setScript] = useState(FALLBACK_SCRIPT);
  // Ticked unless this person said no before (the choice is theirs, not this device's).
  const [carry, setCarry] = useState(true);
  useEffect(() => {
    let live = true;
    carryChoice(me.id).then((c) => live && setCarry(c ?? true));
    return () => void (live = false);
  }, [me.id]);
  const rec = useRef<{ stop: () => void } | null>(null);

  useEffect(() => {
    api<{ sentences?: string[] }>("/voice/script")
      .then((r) => r.sentences?.length && setScript(r.sentences))
      .catch(() => {});
  }, []);

  // Over plain http (the default LAN join address) the browser has no mic API at all.
  const blocked = micError || (mediaAvailable()?.replace("Sharing", "Reading aloud") ?? ("getUserMedia" in (navigator.mediaDevices ?? {}) ? null : "This page can't use the microphone. Open the host's secure address."));

  const start = async () => {
    if (blocked) return setState("error"), setMsg(blocked);
    // Every laptop hears the read, yours loudest: the host keeps it out of the transcript while you read.
    // If it can't, don't read, or the room would see it.
    try {
      await beginRead(me.id);
    } catch (e) {
      setState("error");
      return setMsg(`The host couldn't get ready for your read, so nothing was recorded. ${e instanceof Error ? e.message : ""}`.trim());
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
      const chunks: Blob[] = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => chunks.push(e.data);
      const t0 = Date.now();
      const tick = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 250);
      const auto = setTimeout(() => mr.state === "recording" && mr.stop(), 45_000);
      mr.onstop = async () => {
        clearInterval(tick);
        clearTimeout(auto);
        stream.getTracks().forEach((t) => t.stop());
        setState("saving");
        try {
          const wav = await toWav16k(new Blob(chunks, { type: mr.mimeType }));
          const res = await fetch(`/api/people/${me.id}/voice`, { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
          // The host ends the read itself once it has the recording (taken or refused); anything else, we end it.
          if (!res.ok) void endRead(me.id, true);
          const r = await res.json();
          if (r.ok) {
            await setCarryAllowed(me.id, carry).catch(() => setCarry(false));
            if (carry) await pullCopy(me.id);
            setState("done");
            setMsg(`${brainName} knows your voice.`);
          } else (setState("error"), setMsg(r.reason ?? r.error ?? "That didn't work. Try again."));
        } catch (e) {
          void endRead(me.id, true);
          setState("error");
          setMsg(String(e));
        }
      };
      rec.current = { stop: () => mr.state === "recording" && mr.stop() };
      mr.start();
      setSecs(0);
      setState("recording");
    } catch (e) {
      // No microphone, so nothing was read: the room is heard again at once.
      void endRead(me.id, false);
      setState("error");
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const l = me.voiceLearned;
  const learned = l && [l.read && `${l.read} from reading aloud`, l.corrections && `${l.corrections} correction${l.corrections === 1 ? "" : "s"}`, l.heard && `${l.heard} line${l.heard === 1 ? "" : "s"} heard`, l.carried && `${l.carried} brought from another host`].filter(Boolean);

  return (
    <div className="section">
      <h3>Teach {brainName} your voice</h3>
      <p className="help">
        Read these out loud. It takes about twenty seconds and makes speaker recognition much better, especially when you walk around the room.
        {learned?.length ? ` So far it knows you from ${learned.join(", ")}.` : ""}
      </p>
      <div className="voice-read" data-reading={state === "recording"}>
        {script.map((s) => (
          <p key={s}>{s}</p>
        ))}
      </div>
      <label className="check" style={{ display: "flex", gap: 8, alignItems: "flex-start", margin: "0 0 12px", fontSize: 13, color: "var(--muted)" }}>
        <input
          type="checkbox"
          checked={carry}
          onChange={(e) => {
            setCarry(e.target.checked);
            // Already known on this host: the copy for your next room is taken now, or dropped now.
            if (state !== "recording") {
              const on = e.target.checked;
              setCarryAllowed(me.id, on)
                .then(() => on && me.voiceSamples > 0 && pullCopy(me.id))
                .catch((err) => (setCarry(!on), setState("error"), setMsg(`Couldn't save that: ${err instanceof Error ? err.message : String(err)}`)));
            }
          }}
          style={{ marginTop: 2 }}
        />
        <span>
          {carriesToOtherHosts()
            ? "Keep my voice in the JamSesh app on this Mac and bring it to rooms I join. Only numbers that describe your voice, never a recording."
            : "Keep my voice in this browser for this host. Only numbers that describe your voice, never a recording. To bring it to other hosts, join with the JamSesh Mac app."}
        </span>
      </label>
      <div className="row">
        {state === "recording" ? (
          <button className="btn" onClick={() => rec.current?.stop()} style={{ borderColor: "rgba(255,107,94,.5)", color: "var(--warn)" }}>
            <span className="dot" style={{ background: "var(--warn)", animation: "pulse 1s infinite" }} /> Done reading · {secs}s
          </button>
        ) : (
          <button className="btn primary" onClick={start} disabled={state === "saving" || !!blocked}>
            {state === "saving" ? "Learning your voice…" : state === "done" ? "Read again" : "Start reading"}
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
