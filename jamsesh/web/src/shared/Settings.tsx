import { useEffect, useState } from "react";
import { ago, api, useHub, type Person, type Settings as S } from "./hub";
import { Avatar, Meter, Section, Toggle } from "./ui";
import { ScreenIcon } from "./icons";

export function SettingsDrawer({ onClose, host }: { onClose: () => void; host: boolean }) {
  const { state, levels } = useHub();
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [engines, setEngines] = useState<Engines | null>(null);
  useEffect(() => {
    const load = () => api("/engines").then(setEngines).catch(() => {});
    void load();
    // A first download takes minutes; keep its progress current while Settings is open.
    const poll = setInterval(load, 4000);
    const close = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => (clearInterval(poll), window.removeEventListener("keydown", close));
  }, [onClose]);
  if (!state) return null;
  const s = state.settings;
  const update = async (patch: Partial<S> & { gatewayKey?: string }) => {
    await api("/settings", patch);
    setSaved("Saved");
    setTimeout(() => setSaved(null), 1500);
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer scrollbars-thin">
        <header>
          <h2>Settings</h2>
          <div className="row">
            {saved && <span className="chip" style={{ color: "var(--built)" }}>{saved}</span>}
            <button className="btn small" onClick={onClose}>
              Done
            </button>
          </div>
        </header>
        <div className="body">
          <Section title="Session">
            <label className="field">
              <span>Name</span>
              <input defaultValue={s.sessionName} onBlur={(e) => e.target.value.trim() && e.target.value !== s.sessionName && update({ sessionName: e.target.value.trim() })} />
            </label>
            <div className="chip mono">{state.session.addresses?.map((a) => a.url).join("  ·  ") ?? state.session.hubUrl}</div>
          </Section>

          <Section
            title="Room brain"
            help="Say its name to talk to it directly. It keeps notes on how the room wants it to behave."
            right={
              host ? (
                <label className="row" style={{ gap: 8, fontSize: 13, color: "var(--muted)" }}>
                  {s.brainEnabled ? "On" : "Off"}
                  <Toggle on={s.brainEnabled} onChange={(v) => update({ brainEnabled: v })} label="Room brain on" />
                </label>
              ) : undefined
            }
          >
            <label className="field">
              <span>Name</span>
              <input defaultValue={s.brainName} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== s.brainName && update({ brainName: e.target.value.trim() })} />
            </label>
            <div className="field">
              <span>Also answers to</span>
              <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                {s.brainAliases.length === 0 && <span className="empty-note" style={{ padding: 0 }}>Nothing else. Add the other words your room uses, like "Computer".</span>}
                {s.brainAliases.map((a) => (
                  <span key={a} className="badge neutral" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13, gap: 6 }}>
                    {a}
                    <button className="btn ghost small" style={{ padding: "0 4px", minHeight: 0 }} onClick={() => update({ brainAliases: s.brainAliases.filter((x) => x !== a) })} title={`Stop answering to ${a}`} aria-label={`Stop answering to ${a}`}>
                      ✕
                    </button>
                  </span>
                ))}
              </div>
              <NoteInput placeholder="Another name, for example Computer" onAdd={(n) => !s.brainAliases.some((a) => a.toLowerCase() === n.toLowerCase()) && update({ brainAliases: [...s.brainAliases, n].slice(-8) })} />
            </div>
            <div className="field">
              <span>What it has learned about how to behave</span>
              {s.brainNotes.length === 0 && <div className="empty-note" style={{ padding: "4px 0" }}>Nothing yet. Tell it, for example, "{s.brainName}, keep your answers to one sentence."</div>}
              {s.brainNotes.map((n, i) => (
                <div key={i} className="row" style={{ padding: "6px 10px", background: "var(--panel)", borderRadius: 10, fontSize: 14 }}>
                  <span className="grow">{n}</span>
                  <button className="btn ghost small" onClick={() => update({ brainNotes: s.brainNotes.filter((_, j) => j !== i) })} title="Forget this">
                    ✕
                  </button>
                </div>
              ))}
              <NoteInput onAdd={(n) => update({ brainNotes: [...s.brainNotes, n] })} />
            </div>
          </Section>

          {host && (
            <Section
              title="Gateway"
              help="The room brain runs on the Vercel AI Gateway. The key stays on this machine."
            >
              <label className="field">
                <span>
                  AI Gateway API key{" "}
                  {s.gatewayKeySet ? (
                    <span style={{ color: "var(--built)" }}>· set{s.gatewayKeySource === "env" ? " from ~/.jamsesh/.env" : ""}</span>
                  ) : (
                    <span style={{ color: "var(--warn)" }}>· not set</span>
                  )}
                </span>
                <div className="row">
                  <input className="grow" type="password" placeholder={s.gatewayKeySet ? "Paste a new key to replace it" : "vck_…"} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
                  <button className="btn" disabled={!key.trim()} onClick={() => update({ gatewayKey: key.trim() }).then(() => setKey(""))}>
                    Save
                  </button>
                </div>
              </label>
              {state.brain.lastError && <p className="help" style={{ color: "var(--warn)" }}>Last error: {state.brain.lastError}</p>}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {(Object.keys(s.models) as (keyof S["models"])[]).map((k) => (
                  <label key={k} className="field" style={{ margin: 0 }}>
                    <span>{MODEL_LABELS[k]}</span>
                    <input className="mono" style={{ fontSize: 12 }} defaultValue={s.models[k]} onBlur={(e) => e.target.value.trim() !== s.models[k] && update({ models: { ...s.models, [k]: e.target.value.trim() } })} />
                  </label>
                ))}
              </div>
            </Section>
          )}

          {host && (
            <Section title="Voice and host">
              <div className="row between" style={{ marginBottom: 12 }}>
                <span>Speak replies on the room speaker</span>
                <Toggle on={s.voiceReplies} onChange={(v) => update({ voiceReplies: v })} />
              </div>
              <VoicePicker voice={s.voice} model={s.models.speech} onChange={(v) => update({ voice: v })} />
              <div className="row between">
                <span>Let the brain drive this Mac (apps, windows, Simulator, shell)</span>
                <Toggle on={s.hostControl} onChange={(v) => update({ hostControl: v })} />
              </div>
            </Section>
          )}

          <Saved />

          <Section title="Transcription" help="The host's speech model runs first, then whisper on the host or on laptops that offer theirs. The gateway is the fallback.">
            <select value={s.transcription} onChange={(e) => update({ transcription: e.target.value as S["transcription"] })} style={{ marginBottom: 12 }}>
              <option value="auto">Local first, gateway fallback</option>
              <option value="local">Local only</option>
              <option value="gateway">Gateway only</option>
            </select>
            {engines && (
              <div className="chip" style={{ display: "block", whiteSpace: "normal" }}>
                {engines.transcription.length ? engines.transcription.map((e) => `${e.label}${e.healthy ? "" : " (failing)"}`).join(" · ") : "No local engine; using the gateway."}
                {engines.speechModel && engines.speechModel.state !== "ready" && (
                  <div style={{ color: engines.speechModel.state === "failed" ? "var(--warn)" : "var(--dim)", marginTop: 4 }}>
                    {engines.speechModel.engine}: {engines.speechModel.detail}
                    {engines.speechModel.progress !== null && ` ${engines.speechModel.progress}%`}
                  </div>
                )}
              </div>
            )}
            <div className="field" style={{ marginTop: 12 }}>
              <span>Words to listen for</span>
              <div className="empty-note" style={{ padding: "0 0 6px" }}>
                People, agents and workstreams are included on their own. Add product names and how they get misheard, like "Chey: Shay".
              </div>
              <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                {s.vocabulary.map((w) => (
                  <span key={w} className="badge neutral" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13, gap: 6 }}>
                    {w}
                    <button className="btn ghost small" style={{ padding: "0 4px", minHeight: 0 }} onClick={() => update({ vocabulary: s.vocabulary.filter((x) => x !== w) })} title={`Stop listening for ${w}`} aria-label={`Stop listening for ${w}`}>
                      ✕
                    </button>
                  </span>
                ))}
              </div>
              <NoteInput placeholder="A word, or a word: how it's misheard" onAdd={(w) => !s.vocabulary.some((x) => x.toLowerCase() === w.toLowerCase()) && update({ vocabulary: [...s.vocabulary, w] })} />
            </div>
          </Section>

          <Section title="People" help="Each person's title weighs in when instructions conflict. Voice samples come from lines you label, and from people talking at their own laptops.">
            {!state.voiceprints.available && <VoiceMatchingOff reason={state.voiceprints.reason} />}
            {state.people.map((p) => (
              <PersonRow key={p.id} p={p} />
            ))}
            <AddPerson />
          </Section>

          <Section title="Devices" help="Whose laptop is whose tells JamSesh who is speaking. A laptop's owner is set when they join.">
            {state.devices.length === 0 && <div className="empty-note">No devices yet.</div>}
            {state.devices.map((d) => (
              <div key={d.id} className="row" style={{ marginBottom: 8 }}>
                <span className="dot" style={{ background: d.micOn ? "var(--built)" : "var(--faint)" }} />
                <span className="grow chip" style={{ color: "var(--text)" }}>
                  {d.label} <span style={{ color: "var(--dim)" }}>{d.kind === "host" ? "· room mic" : ""}</span>
                </span>
                <Meter db={levels[d.id]} />
                <select
                  value={d.personId ?? ""}
                  onChange={(e) => api("/devices", { deviceId: d.id, personId: e.target.value || null, label: d.label, kind: d.kind })}
                  style={{ width: 150, padding: "6px 8px" }}
                >
                  <option value="">Nobody (room)</option>
                  {state.people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </Section>

{host && <RemoteAccess />}
          <Paired host={host} />
        </div>
      </aside>
    </>
  );
}

const MODEL_LABELS: Record<string, string> = {
  triage: "Triage (every line)",
  router: "Router",
  presenter: "Presenter",
  digest: "Digests",
  speech: "Speech",
  transcribe: "Transcription fallback",
};

function PersonRow({ p }: { p: Person }) {
  return (
    <div className="person-row">
      <Avatar name={p.name} color={p.color} size={26} photo={p.photo} />
      <input defaultValue={p.name} onBlur={(e) => e.target.value.trim() && e.target.value !== p.name && api(`/people/${p.id}`, { name: e.target.value.trim() }, "PATCH")} />
      <input defaultValue={p.role} placeholder="Title (for example CPO)" onBlur={(e) => e.target.value !== p.role && api(`/people/${p.id}`, { role: e.target.value }, "PATCH")} />
      <select defaultValue={String(p.weight)} onChange={(e) => api(`/people/${p.id}`, { weight: Number(e.target.value) }, "PATCH")} title="How much their call counts">
        <option value="1">×1</option>
        <option value="2">×2</option>
        <option value="3">×3</option>
      </select>
      <span className="row" style={{ gap: 4 }}>
        <span className="chip" title="Voice samples" style={{ fontSize: 12 }}>
          {p.voiceSamples ? `${p.voiceSamples} 🎙` : "no voice"}
        </span>
        <button className="icon-btn small" title={`Ask ${p.name} to share their screen`} aria-label={`Ask ${p.name} to share their screen`} onClick={() => api("/shares/request", { personId: p.id, kind: "screen", reason: "The room wants to see your screen", by: "Host" }).catch((e) => alert(e.message))}>
          <ScreenIcon size={15} />
        </button>
        {p.voiceSamples > 0 && (
          <button className="btn ghost small" title="Forget their voice" onClick={() => api(`/people/${p.id}/voiceprint`, undefined, "DELETE")}>
            Reset
          </button>
        )}
        <button className="btn ghost small" title="Remove" onClick={() => confirm(`Remove ${p.name}?`) && api(`/people/${p.id}`, undefined, "DELETE")}>
          ✕
        </button>
      </span>
    </div>
  );
}

function RemoteAccess() {
  const [st, setSt] = useState<{ enabled: boolean; configured: boolean; publicUrl?: string; cert: { state: string }; reachable: string } | null>(null);
  useEffect(() => {
    api("/net/status").then(setSt).catch(() => {});
  }, []);
  const live = st?.enabled && st.cert.state === "ok";
  return (
    <Section
      title="Remote access"
      help="Make this host reachable from anywhere at its own HTTPS address, so people can join from home and phones work too."
      right={
        <a className="btn small" href="/setup">
          {st?.configured ? "Open setup" : "Set up"}
        </a>
      }
    >
      <div className="chip" style={{ whiteSpace: "normal" }}>
        {!st ? "Checking…" : live ? `On at ${st.publicUrl}${st.reachable === "yes" ? "" : " (not confirmed reachable yet)"}` : st.configured ? "Set up, but not finished" : "Room only: people on this network can join."}
      </div>
    </Section>
  );
}

function Paired({ host }: { host: boolean }) {
  const [list, setList] = useState<{ id: string; kind: string; label: string; lastSeen: number; ip: string }[]>([]);
  const load = () => api("/paired").then(setList).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  return (
    <Section title="Connected devices" help="Laptops, phones and agents paired with this host. Disconnecting one revokes its access right away; it can pair again with a new code.">
      {list.length === 0 && <div className="empty-note">Nothing paired yet.</div>}
      {list.map((d) => (
        <div key={d.id} className="row" style={{ padding: "7px 0", borderTop: "1px solid var(--line)", fontSize: 14 }}>
          <span className="badge neutral" style={{ width: 62, justifyContent: "center" }}>{d.kind === "agent" ? "Agent" : "App"}</span>
          <span className="grow ellipsis">{d.label}</span>
          <span className="chip mono" style={{ fontSize: 12 }}>{ago(d.lastSeen)}</span>
          {host && (
            <button className="btn ghost small" onClick={() => confirm(`Disconnect ${d.label}?`) && api(`/paired/${d.id}`, undefined, "DELETE").then(load)}>
              Disconnect
            </button>
          )}
        </div>
      ))}
    </Section>
  );
}

function Saved() {
  const [data, setData] = useState<{ snapshots: { id: string; label: string; at: number; canvas: boolean }[]; layouts: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api("/snapshots").then(setData).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  const last = data?.snapshots[0];
  return (
    <Section
      title="Saved"
      help="Everything saves as it happens. JamSesh also keeps a snapshot every five minutes while things change, and one when the host stops: the canvas file, the session's decisions and context, and readable notes."
      right={
        <button className="btn small" disabled={busy} onClick={async () => (setBusy(true), await api("/snapshots", { label: "saved by hand" }).catch(() => {}), await load(), setBusy(false))}>
          {busy ? "Saving…" : "Save now"}
        </button>
      }
    >
      <div className="chip" style={{ marginBottom: 10 }}>{last ? `Last snapshot ${ago(last.at)} ago${last.label ? ` · ${last.label}` : ""}` : "No snapshots yet"}</div>
      {data?.snapshots.slice(0, 5).map((x) => (
        <div key={x.id} className="row" style={{ fontSize: 13, padding: "5px 0", borderTop: "1px solid var(--line)" }}>
          <span className="grow ellipsis">{new Date(x.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}{x.label ? ` · ${x.label}` : ""}</span>
          <a className="btn ghost small" href={`/api/snapshots/${x.id}/notes.md`}>Notes</a>
          {x.canvas && <a className="btn ghost small" href={`/api/snapshots/${x.id}/canvas.figcraft`}>Canvas</a>}
        </div>
      ))}
      {!!data?.layouts.length && (
        <div style={{ marginTop: 12 }}>
          <div className="label" style={{ marginBottom: 6 }}>Saved screen layouts</div>
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            {data.layouts.map((n) => (
              <span key={n} className="badge neutral" style={{ textTransform: "none", letterSpacing: 0, fontSize: 12 }}>{n}</span>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

/** Voices the speech models offer by name (matches `hub/src/brain/speech.ts`); any other provider gets a free-text field. */
const OPENAI_VOICES = ["nova", "alloy", "echo", "fable", "onyx", "shimmer", "coral", "sage", "ash"];
const MAI_VOICES = ["Grant", "Iris", "Jasper"];

/** The voices to list for a model, with "" for the model's own default voice where it has one. */
function voicesFor(model: string): string[] | null {
  if (model.startsWith("openai/")) return OPENAI_VOICES;
  if (model.startsWith("microsoft/mai-voice")) return ["", ...MAI_VOICES];
  return null;
}

function VoicePicker({ voice, model, onChange }: { voice: string; model: string; onChange: (v: string) => void }) {
  const [chosen, setChosen] = useState(voice);
  const [phase, setPhase] = useState<"idle" | "busy" | "error">("idle");
  const [err, setErr] = useState("");
  const listed = voicesFor(model);
  const preview = async () => {
    setPhase("busy");
    try {
      const r = await api<{ audio: string; mime: string }>("/voice-preview", { voice: chosen }, undefined, { queue: false, timeoutMs: 30000 });
      await new Audio(`data:${r.mime};base64,${r.audio}`).play();
      setPhase("idle");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't play the sample");
      setPhase("error");
    }
  };
  return (
    <div className="field">
      <span>Voice</span>
      <div className="row">
        {listed ? (
          <select className="grow" value={chosen} onChange={(e) => (setChosen(e.target.value), onChange(e.target.value))}>
            {(listed.includes(chosen) ? listed : [chosen, ...listed]).map((v) => (
              <option key={v} value={v}>
                {v || "Default voice"}
              </option>
            ))}
          </select>
        ) : (
          <input className="grow" value={chosen} onChange={(e) => setChosen(e.target.value)} onBlur={() => chosen.trim() && chosen !== voice && onChange(chosen.trim())} />
        )}
        <button className="btn" onClick={preview} disabled={phase === "busy"}>
          {phase === "busy" ? "Playing…" : "Preview"}
        </button>
      </div>
      {phase === "error" && <p className="help" style={{ color: "var(--warn)", margin: "6px 0 0" }}>{err}</p>}
    </div>
  );
}

/** The host's speaker model didn't load, so lines are labelled by device alone. */
function VoiceMatchingOff({ reason }: { reason: string }) {
  return (
    <p className="help" style={{ color: "var(--warn)", margin: "0 0 12px" }}>
      Voice matching is off on this host{reason ? `: ${reason}` : ""}. Lines are labelled by which laptop heard them, and corrections can't teach anyone's voice.
    </p>
  );
}

interface Engines {
  transcription: { label: string; inflight: number; healthy: boolean }[];
  speechModel?: { engine: string; state: string; detail: string; progress: number | null };
  voiceprints: { available: boolean; reason: string; enrolled: number };
}

function NoteInput({ onAdd, placeholder = "Add a note, for example: ask before building anything big" }: { onAdd: (n: string) => void; placeholder?: string }) {
  const [v, setV] = useState("");
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) (onAdd(v.trim()), setV(""));
      }}
    >
      <input className="grow" placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} />
      <button className="btn" type="submit">
        Add
      </button>
    </form>
  );
}

function AddPerson() {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        api("/people", { name: name.trim(), role: role.trim() }).then(() => (setName(""), setRole("")));
      }}
    >
      <input className="grow" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="grow" placeholder="Title (for example CPO)" value={role} onChange={(e) => setRole(e.target.value)} />
      <button className="btn" type="submit">
        Add
      </button>
    </form>
  );
}
