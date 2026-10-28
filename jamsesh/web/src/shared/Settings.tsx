import { useEffect, useState } from "react";
import { api, useHub, type Person, type Settings as S } from "./hub";
import { Avatar, Meter, Section, Toggle } from "./ui";

export function SettingsDrawer({ onClose, host }: { onClose: () => void; host: boolean }) {
  const { state, levels } = useHub();
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [engines, setEngines] = useState<{ transcription: { label: string; inflight: number; healthy: boolean }[]; voiceprints: number } | null>(null);
  useEffect(() => {
    api("/engines").then(setEngines).catch(() => {});
    const close = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
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
            <div className="row between" style={{ fontSize: 14 }}>
              <span>
                Join code <strong className="mono">{state.session.code}</strong>
              </span>
              <span className="chip mono">{state.session.hubUrl}</span>
            </div>
          </Section>

          <Section title="Room brain" help="Say its name to talk to it directly. It keeps notes on how the room wants it to behave.">
            <label className="field">
              <span>Name</span>
              <input defaultValue={s.brainName} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== s.brainName && update({ brainName: e.target.value.trim() })} />
            </label>
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
              right={<Toggle on={s.brainEnabled} onChange={(v) => update({ brainEnabled: v })} label="Brain on" />}
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
                  <input className="grow mono" type="password" placeholder={s.gatewayKeySet ? "Paste a new key to replace it" : "vck_…"} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
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
              <label className="field">
                <span>Voice</span>
                <select defaultValue={s.voice} onChange={(e) => update({ voice: e.target.value })}>
                  {["nova", "alloy", "echo", "fable", "onyx", "shimmer"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <div className="row between">
                <span>Let the brain drive this Mac (apps, windows, Simulator, shell)</span>
                <Toggle on={s.hostControl} onChange={(v) => update({ hostControl: v })} />
              </div>
            </Section>
          )}

          <Section title="Transcription" help="Local whisper runs first: on the host, then on laptops that offer theirs. The gateway is the fallback.">
            <select value={s.transcription} onChange={(e) => update({ transcription: e.target.value as S["transcription"] })} style={{ marginBottom: 12 }}>
              <option value="auto">Local first, gateway fallback</option>
              <option value="local">Local only</option>
              <option value="gateway">Gateway only</option>
            </select>
            {engines && (
              <div className="chip" style={{ display: "block", whiteSpace: "normal" }}>
                {engines.transcription.length ? engines.transcription.map((e) => `${e.label}${e.healthy ? "" : " (failing)"}`).join(" · ") : "No local whisper; using the gateway."}
              </div>
            )}
          </Section>

          <Section title="People" help="Each person's title weighs in when instructions conflict. Voice samples come from lines you label, and from people talking at their own laptops.">
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

          <Section title="Connect a laptop">
            <p className="help">On each laptop, run this in a terminal. It sets up Claude Code and Codex and opens the JamSesh window.</p>
            <code className="mono" style={{ display: "block", padding: 12, background: "var(--panel)", borderRadius: 10, fontSize: 13, userSelect: "all" }}>
              curl -fsSL {state.session.hubUrl}/join.sh | bash
            </code>
          </Section>
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
        <button className="btn ghost small" title={`Ask ${p.name} to share their screen`} onClick={() => api("/shares/request", { personId: p.id, kind: "screen", reason: "The room wants to see your screen", by: "Host" }).catch((e) => alert(e.message))}>
          Screen
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

function NoteInput({ onAdd }: { onAdd: (n: string) => void }) {
  const [v, setV] = useState("");
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) (onAdd(v.trim()), setV(""));
      }}
    >
      <input className="grow" placeholder="Add a note, for example: ask before building anything big" value={v} onChange={(e) => setV(e.target.value)} />
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
