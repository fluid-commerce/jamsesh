import { useEffect, useRef, useState } from "react";
import { api, type Person } from "../shared/hub";
import { encodeWav } from "../shared/mic";
import { PhotoAvatar, ProfilePhoto } from "../shared/share";
import { mediaAvailable } from "../shared/rtc";
import { WhereChooser } from "./ClientView";
import { deviceCopiesProblem } from "../shared/voiceprint";
import { browserReadDeps, VoiceRead, type ReadView } from "../shared/voiceRead";

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
  const [view, setView] = useState<ReadView>({ state: "idle", msg: "", secs: 0 });
  const [script, setScript] = useState(FALLBACK_SCRIPT);
  const [oldCopy, setOldCopy] = useState<string | null>(() => deviceCopiesProblem());
  const reader = useRef<VoiceRead | null>(null);

  useEffect(() => {
    api<{ sentences?: string[] }>("/voice/script")
      .then((r) => r.sentences?.length && setScript(r.sentences))
      .catch(() => {});
  }, []);

  // One reader per person; closing the profile (unmount) or switching person cancels a read wherever it is.
  useEffect(() => {
    const r = new VoiceRead(me.id, brainName, browserReadDeps(toWav16k), setView);
    reader.current = r;
    return () => {
      r.cancel();
      if (reader.current === r) reader.current = null;
    };
  }, [me.id, brainName]);

  useEffect(() => {
    if (!oldCopy) return;
    const t = setInterval(() => setOldCopy(deviceCopiesProblem()), 15_000);
    return () => clearInterval(t);
  }, [oldCopy]);

  const blocked = micError || (mediaAvailable()?.replace("Sharing", "Reading aloud") ?? ("getUserMedia" in (navigator.mediaDevices ?? {}) ? null : "This page can't use the microphone. Open the host's secure address."));
  const { state, msg, secs } = view;

  const start = () => {
    if (blocked) return setView({ ...view, state: "error", msg: blocked });
    void reader.current?.start();
  };

  const l = me.voiceLearned;
  const learned = l && [l.read && `${l.read} from reading aloud`, l.corrections && `${l.corrections} correction${l.corrections === 1 ? "" : "s"}`, l.heard && `${l.heard} line${l.heard === 1 ? "" : "s"} heard`].filter(Boolean);

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
      <p className="help" style={{ margin: "0 0 12px" }}>
        This host keeps your voice so it knows you next time: numbers that describe it, never a recording. It isn't taken to other hosts; on a new one, read again. Reset in Settings forgets it.
      </p>
      <div className="row">
        {state === "recording" ? (
          <button className="btn" onClick={() => reader.current?.stop()} style={{ borderColor: "rgba(255,107,94,.5)", color: "var(--warn)" }}>
            <span className="dot" style={{ background: "var(--warn)", animation: "pulse 1s infinite" }} /> Done reading · {secs}s
          </button>
        ) : (
          <button className="btn primary" onClick={start} disabled={state === "saving" || !!blocked || !!reader.current?.busy}>
            {state === "saving" ? "Learning your voice…" : state === "done" ? "Read again" : "Start reading"}
          </button>
        )}
        {blocked && !msg && <span className="chip" style={{ whiteSpace: "normal", color: "var(--warn)" }}>{blocked}</span>}
        {msg && <span className="chip" style={{ whiteSpace: "normal", color: state === "error" ? "var(--warn)" : "var(--built)" }}>{msg}</span>}
        {oldCopy && <span className="chip" style={{ whiteSpace: "normal", color: "var(--warn)" }}>{oldCopy}</span>}
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
