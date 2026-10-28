import { useEffect, useMemo, useState } from "react";
import { Logo } from "../host/HostView";
import { api, deviceId, hub, pref, setPref, useHub, type Artifact, type HubState } from "../shared/hub";
import { playChime } from "../shared/sound";
import { Mic, type MicStatus } from "../shared/mic";
import { SettingsDrawer } from "../shared/Settings";
import { AgentRow, ArtifactTile, Avatar, CanvasFrame, Meter, RoomFeed, Toasts, modeLabel } from "../shared/ui";
import { PhotoAvatar, ShareControls, ShareRequestPrompt } from "../shared/share";
import { ProfileDrawer, VoiceEnroll } from "./Profile";
import { Stage } from "../host/Stage";
import { GearIcon, MicIcon, MicOffIcon } from "../shared/icons";
import { AnnotateToggle, AnnotationsPanel, PinLayer, RecordPrompt, useAnnotateMode } from "../shared/annotate";

const DEVICE = deviceId("client");
const mic = new Mic(DEVICE);

type Tab = "canvas" | "screen" | "work" | "pins" | "agents";

export function ClientView() {
  const { state, connected } = useHub();
  const [personId, setPersonId] = useState(pref("personId"));
  const [tab, setTab] = useState<Tab>((pref("tab") as Tab) || "canvas");
  const [settings, setSettings] = useState(false);
  const [profile, setProfile] = useState(false);
  const [enrollAsked, setEnrollAsked] = useState(pref("enrollAsked") === "1");
  const [micStatus, setMicStatus] = useState<MicStatus>(mic.status);
  const me = state?.people.find((p) => p.id === personId);

  useEffect(() => mic.onChange(setMicStatus) as () => void, []);
  // Remote people don't hear the room speaker: the brain's voice and chime play here instead.
  const myDevice = state?.devices.find((d) => d.id === DEVICE);
  const remote = myDevice?.location === "remote";
  useEffect(() => {
    if (!remote) return;
    let audio: HTMLAudioElement | null = null;
    const onSpeak = (m: { audio: string | null; mime: string }) => {
      if (!m.audio || pref("hearBrain") === "off") return;
      audio?.pause();
      audio = new Audio(`data:${m.mime};base64,${m.audio}`);
      audio.play().catch(() => {});
    };
    hub.speakListeners.add(onSpeak);
    const offChime = hub.onMessage((m) => m.type === "chime" && m.deviceId !== hub.deviceId && pref("hearBrain") !== "off" && playChime());
    return () => {
      hub.speakListeners.delete(onSpeak);
      offChime();
      audio?.pause();
    };
  }, [remote]);
  // Heard you: the chime also plays on the laptop that spoke or recorded.
  useEffect(() => hub.onMessage((m) => m.type === "chime" && m.deviceId === hub.deviceId && playChime()) as () => void, []);
  useEffect(() => {
    if (!me) return;
    const location = pref("location") || undefined;
    api("/devices", { deviceId: DEVICE, label: `${me.name}'s laptop`, personId: me.id, micOn: micStatus.on, location }).catch(() => {});
  }, [me?.id, micStatus.on]);
  useEffect(() => setPref("tab", tab), [tab]);
  // M mutes or unmutes from anywhere outside a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "m" || e.metaKey || e.ctrlKey || (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
      if (mic.status.on) (mic.stop(), setPref("mic", "off"));
      else mic.start().then(() => setPref("mic", "on")).catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (me && pref("mic") === "on" && !mic.status.on) mic.start().catch(() => {});
  }, [me?.id]);

  if (!state) return <div style={{ height: "100%", display: "grid", placeItems: "center", color: "var(--muted)" }}>{connected ? "Loading…" : "Connecting to the host…"}</div>;
  if (!me) return <Onboarding state={state} onPick={(id) => (setPref("personId", id), setPersonId(id))} />;

  const toggleMic = async () => {
    if (micStatus.on) {
      mic.stop();
      setPref("mic", "off");
    } else {
      await mic.start().catch(() => {});
      setPref("mic", "on");
    }
  };
  const myAgents = state.agents.filter((a) => a.ownerId === me.id && a.status !== "offline");
  const mine = new Set(myAgents.map((a) => a.id));
  const pending = state.directives.filter((d) => ["pending", "delivered", "acked"].includes(d.status) && d.targets.some((t) => mine.has(t))).slice(0, 3);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <header className="app-header client-header" style={{ height: 56, padding: "0 16px", borderBottom: "1px solid var(--line)", flex: "none" }}>
        <div className="header-left">
          <Logo size={26} />
          <strong className="wordmark" style={{ fontWeight: 650 }}>JamSesh</strong>
          <span className="chip session-name ellipsis" style={{ maxWidth: 180 }}>{state.settings.sessionName}</span>
        </div>
        <nav className="header-center row" style={{ gap: 2, background: "var(--panel)", padding: 3, borderRadius: 999, border: "1px solid var(--line)", flex: "none" }}>
          {(
            [
              ["canvas", "Canvas"],
              ["screen", "Screen"],
              ["work", "Work"],
              ["pins", `Pins${state.annotations.filter((a) => a.status === "open").length ? ` · ${state.annotations.filter((a) => a.status === "open").length}` : ""}`],
              ["agents", "Agents"],
            ] as const
          ).map(([t, label]) => (
            <button key={t} className="btn small" style={{ height: 28, borderColor: "transparent", background: tab === t ? "var(--panel-3)" : "transparent", color: tab === t ? "var(--text)" : "var(--muted)" }} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="header-right">
          {remote && <span className="badge neutral" title="You're joining remotely: the Screen tab mirrors the big screen">Remote</span>}
          <span className="chip big-screen-chip ellipsis" title="What the big screen shows">
            On screen: {state.stage.mode === "welcome" ? "board" : state.stage.title || state.stage.mode}
          </span>
          <button className={`btn small mic-btn ${micStatus.on ? "on" : "muted"}`} style={{ height: 36 }} onClick={toggleMic} title={micStatus.error ?? (micStatus.on ? "Mute (M)" : "Unmute (M)")} aria-label={micStatus.on ? "Mute" : "Unmute"}>
            {micStatus.on ? <MicIcon size={16} /> : <MicOffIcon size={16} />}
            {micStatus.on && <Meter db={micStatus.level} />}
            <span className="mic-label">{micStatus.on ? (micStatus.speaking ? "Hearing you" : "Listening") : "Muted"}</span>
          </button>
          <RecordPrompt personId={me.id} brainName={state.settings.brainName} />
          <AnnotateToggle />
          <ShareControls personId={me.id} />
          <button className="row btn ghost small" style={{ height: 36, padding: "0 8px" }} onClick={() => setProfile(true)} title="Your profile: photo, title, voice" aria-label={`Your profile (${me.name})`}>
            <PhotoAvatar person={me} size={24} />
            <span className="me-name">{me.name}</span>
          </button>
          <button className="icon-btn" onClick={() => setSettings(true)} title="Settings" aria-label="Settings">
            <GearIcon size={17} />
          </button>
        </div>
      </header>
      {micStatus.error && (
        <div style={{ padding: "8px 16px", background: "var(--warn-bg)", color: "var(--warn)", fontSize: 13 }}>{micStatus.error}</div>
      )}

      <main className="client-main" style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) 380px" }}>
        <section style={{ minHeight: 0, minWidth: 0, position: "relative" }}>
          <div data-jam-target={JSON.stringify({ kind: "canvas", ref: "canvas", label: "Canvas" })} style={{ position: "absolute", inset: 0, display: tab === "canvas" ? "block" : "none" }}>
            <CanvasFrame kind="edit" name={me.name} title="Shared canvas" />
            <PinSlot target={{ kind: "canvas", ref: "canvas", label: "Canvas" }} personId={me.id} />
          </div>
          {tab === "screen" && (
            <div style={{ position: "absolute", inset: 0, padding: 18, display: "flex", flexDirection: "column" }}>
              <Stage state={state} interactive />
            </div>
          )}
          {tab === "work" && <WorkGallery state={state} personId={me.id} />}
          {tab === "pins" && (
            <div className="scrollbars-thin" style={{ position: "absolute", inset: 0, overflowY: "auto", padding: 20 }}>
              <AnnotationsPanel personId={me.id} />
            </div>
          )}
          {tab === "agents" && <AgentsPanel state={state} />}
        </section>

        <aside style={{ minHeight: 0, display: "flex", flexDirection: "column", borderLeft: "1px solid var(--line)", background: "var(--bg-2)" }}>
          <div className="scrollbars-thin" style={{ padding: "12px 14px 6px", borderBottom: "1px solid var(--line)", maxHeight: "42%", overflowY: "auto", flex: "none" }}>
            <div className="label" style={{ marginBottom: 4 }}>
              Your agents
            </div>
            {myAgents.length === 0 ? (
              <div className="empty-note" style={{ padding: "6px 0 10px", fontSize: 13 }}>
                Type <span className="mono">/jamsesh</span> in Claude Code or Codex to connect one.
              </div>
            ) : (
              myAgents.map((a) => <AgentRow key={a.id} agent={a} state={state} compact />)
            )}
            {pending.length > 0 && (
              <div style={{ margin: "6px 0 8px", display: "grid", gap: 6 }}>
                {pending.map((d) => (
                  <div key={d.id} style={{ fontSize: 13, padding: "8px 10px", borderRadius: 10, background: "var(--directive-bg)" }}>
                    <span className="tag" style={{ color: "var(--directive)", fontSize: 11, fontWeight: 650, letterSpacing: ".06em", textTransform: "uppercase" }}>
                      {modeLabel(d.mode)} · {d.status}
                    </span>
                    <div className="clamp" style={{ marginTop: 2 }} title={d.text}>{d.text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "10px 6px 0" }}>
            <div className="row between" style={{ padding: "0 8px 6px" }}>
              <span className="label">The room</span>
              <span className="chip" style={{ fontSize: 12 }}>Click a name to fix who said it</span>
            </div>
            <RoomFeed editable />
          </div>
          <SayBox personId={me.id} brainName={state.settings.brainName} />
        </aside>
      </main>
      <Toasts />
      <ShareRequestPrompt />
      {profile && <ProfileDrawer me={me} brainName={state.settings.brainName} onClose={() => setProfile(false)} />}
      {!enrollAsked && me.voiceSamples === 0 && (
        <>
          <div className="scrim" />
          <div className="modal-wrap">
          <div className="modal" role="dialog" aria-label="Teach JamSesh your voice">
            <VoiceEnroll me={me} brainName={state.settings.brainName} />
            <div className="row" style={{ justifyContent: "flex-end", paddingTop: 4 }}>
              <button className="btn ghost small" onClick={() => (setPref("enrollAsked", "1"), setEnrollAsked(true))}>
                {me.voiceSamples ? "Done" : "Skip for now"}
              </button>
            </div>
          </div>
          </div>
        </>
      )}
      {settings && (
        <SettingsDrawer
          host={false}
          onClose={() => setSettings(false)}
        />
      )}
    </div>
  );
}

function SayBox({ personId, brainName }: { personId: string; brainName: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(true);
  return (
    <form
      style={{ padding: 12, borderTop: "1px solid var(--line)" }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        setBusy(true);
        await api("/say", { personId, text, direct: ask }).catch(() => {});
        setText("");
        setBusy(false);
      }}
    >
      <div className="row" style={{ gap: 4, marginBottom: 8 }}>
        {[
          [true, `Ask ${brainName}`],
          [false, "Say to the room"],
        ].map(([v, label]) => (
          <button key={String(v)} type="button" className="btn small" style={{ height: 26, background: ask === v ? "var(--panel-3)" : "transparent", borderColor: ask === v ? "var(--line-2)" : "transparent", color: ask === v ? "var(--text)" : "var(--muted)" }} onClick={() => setAsk(v as boolean)}>
            {label as string}
          </button>
        ))}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <input className="grow" placeholder={ask ? `Tell ${brainName} what you need…` : "Say something to the room…"} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} />
        <button className="btn primary small" style={{ height: 38 }} disabled={!text.trim() || busy}>
          Send
        </button>
      </div>
    </form>
  );
}

function PinSlot({ target, personId }: { target: { kind: "canvas" | "artifact" | "web" | "screen"; ref: string; label: string }; personId: string }) {
  const mode = useAnnotateMode();
  return <PinLayer target={target} personId={personId} enabled={mode.on} />;
}

function WorkGallery({ state, personId }: { state: HubState; personId: string }) {
  const [filter, setFilter] = useState<"all" | "mockup" | "built">("all");
  const groups = useMemo(() => {
    const items = state.artifacts.filter((a) => filter === "all" || a.stage === filter);
    const map = new Map<string, Artifact[]>();
    for (const a of items) map.set(a.group || a.title, [...(map.get(a.group || a.title) ?? []), a]);
    return [...map.entries()];
  }, [state.artifacts, filter]);
  const show = (items: Artifact[], title: string) =>
    api("/stage", { mode: items.length > 1 ? "compare" : "spotlight", items: items.map((i) => i.id), title, by: "Someone in the room" });
  return (
    <div className="scrollbars-thin" style={{ position: "absolute", inset: 0, overflowY: "auto", padding: 20 }}>
      <div className="row between" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 650 }}>Everything the room has made</h2>
        <div className="row" style={{ gap: 4 }}>
          {(["all", "mockup", "built"] as const).map((f) => (
            <button key={f} className="btn small" style={{ background: filter === f ? "var(--panel-3)" : undefined }} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "mockup" ? "Mockups" : "Built"}
            </button>
          ))}
        </div>
      </div>
      {groups.length === 0 && <div className="empty-note">Nothing yet. Frames appear here as agents and people design on the canvas.</div>}
      {groups.map(([title, items]) => (
        <div key={title} style={{ marginBottom: 28 }}>
          <div className="row between" style={{ marginBottom: 10 }}>
            <strong style={{ fontWeight: 600 }}>{title}</strong>
            <button className="btn small" onClick={() => show(items.slice(0, 6), title)}>
              Show on big screen
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
            {items.map((a) => (
              <div key={a.id} data-jam-target={JSON.stringify({ kind: "artifact", ref: a.id, label: a.title })} style={{ height: 300, display: "flex", position: "relative" }}>
                <ArtifactTile art={a} state={state} variant={a.variant || undefined} live={false} onClick={() => show([a], a.title)} />
                <PinSlot target={{ kind: "artifact", ref: a.id, label: a.title }} personId={personId} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function AgentsPanel({ state }: { state: HubState }) {
  return (
    <div className="scrollbars-thin" style={{ position: "absolute", inset: 0, overflowY: "auto", padding: 20 }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 20, fontWeight: 650 }}>Agents</h2>
      {state.agents.length === 0 && <div className="empty-note">No agents have joined yet.</div>}
      {state.agents.map((a) => (
        <div key={a.id} style={{ borderBottom: "1px solid var(--line)" }}>
          <AgentRow agent={a} state={state} />
        </div>
      ))}
      <h2 style={{ margin: "28px 0 12px", fontSize: 20, fontWeight: 650 }}>What the session has settled</h2>
      <Facts state={state} />
      <h2 style={{ margin: "28px 0 12px", fontSize: 20, fontWeight: 650 }}>Session brief</h2>
      <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font)", color: "var(--muted)", margin: 0 }}>{state.digest || "The brief fills in as the session goes."}</pre>
      {state.devservers.length > 0 && (
        <>
          <h2 style={{ margin: "28px 0 12px", fontSize: 20, fontWeight: 650 }}>Dev servers on the host</h2>
          {state.devservers.map((d) => (
            <div key={d.id} className="row" style={{ padding: "6px 0" }}>
              <span className="dot" style={{ background: d.up ? "var(--built)" : "var(--faint)" }} />
              <a href={d.url} target="_blank" rel="noreferrer" style={{ color: "var(--text)" }}>
                {d.name}
              </a>
              <span className="chip mono">{d.url}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

const FACT_COLORS: Record<string, string> = { decision: "var(--decision)", requirement: "var(--built)", constraint: "var(--warn)", preference: "var(--mockup)", question: "var(--directive)", fact: "var(--muted)" };

function Facts({ state }: { state: HubState }) {
  const active = state.facts.filter((f) => f.status === "active");
  if (!active.length) return <div className="empty-note">Decisions, requirements and open questions collect here as the room works.</div>;
  const groups = new Map<string, typeof active>();
  for (const f of active) groups.set(f.workstream || "Whole session", [...(groups.get(f.workstream || "Whole session") ?? []), f]);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {[...groups].map(([ws, fs]) => (
        <div key={ws}>
          <div className="label" style={{ marginBottom: 6 }}>{ws}</div>
          {fs.map((f) => (
            <div key={f.id} className="row" style={{ alignItems: "flex-start", gap: 10, padding: "6px 0" }}>
              <span className="badge" style={{ color: FACT_COLORS[f.kind], background: "rgba(255,255,255,.05)", flex: "none", width: 92, justifyContent: "center" }}>{f.kind}</span>
              <span style={{ fontSize: 14 }}>
                {f.text}
                {f.by && <span style={{ color: "var(--dim)" }}> · {f.by}</span>}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** In the room or remote: decides how audio is grouped and whether the brain's voice plays here. */
export function WhereChooser({ compact }: { compact?: boolean }) {
  const { state } = useHub();
  const guess = state?.devices.find((d) => d.id === DEVICE)?.location;
  const [where, setWhere] = useState(pref("location") || guess || "room");
  const pick = (w: "room" | "remote") => {
    setWhere(w);
    setPref("location", w);
    api("/devices", { deviceId: DEVICE, location: w }).catch(() => {});
  };
  return (
    <div style={{ margin: compact ? 0 : "18px 0 4px" }}>
      {!compact && <div className="label" style={{ marginBottom: 8 }}>Where are you?</div>}
      <div className="row" style={{ gap: 8 }}>
        {(
          [
            ["room", "In the room", "With the big screen"],
            ["remote", "Remote", "Joining from elsewhere"],
          ] as const
        ).map(([w, title, sub]) => (
          <button key={w} type="button" className={`where-card ${where === w ? "on" : ""}`} onClick={() => pick(w)} aria-pressed={where === w}>
            <strong>{title}</strong>
            <span>{sub}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Onboarding({ state, onPick }: { state: HubState; onPick: (id: string) => void }) {
  const qsName = new URLSearchParams(location.search).get("name") ?? "";
  const existing = state.people.find((p) => p.name.toLowerCase() === qsName.toLowerCase());
  const [name, setName] = useState(qsName);
  const [role, setRole] = useState("");
  useEffect(() => {
    if (existing) onPick(existing.id);
  }, [existing?.id]);
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center", padding: 20 }}>
      <div style={{ width: "min(440px, 100%)" }}>
        <Logo size={40} />
        <h1 style={{ fontSize: 34, letterSpacing: "-0.03em", margin: "18px 0 6px" }}>Join {state.settings.sessionName}</h1>
        <p style={{ color: "var(--muted)", marginTop: 0 }}>Your name and title tell the room brain who's talking and whose call counts.</p>
        <WhereChooser />
        {state.people.length > 0 && (
          <div style={{ display: "grid", gap: 6, margin: "18px 0" }}>
            {state.people.map((p) => (
              <button key={p.id} className="btn" style={{ justifyContent: "flex-start", height: 48, gap: 12, paddingLeft: 10, borderRadius: 14 }} onClick={() => onPick(p.id)}>
                <PhotoAvatar person={p} size={28} />
                <span>I'm {p.name}</span>
                {p.role && <span style={{ color: "var(--dim)", marginLeft: "auto", paddingRight: 6 }}>{p.role}</span>}
              </button>
            ))}
          </div>
        )}
        {state.people.length > 0 && (
          <div className="row" style={{ gap: 12, margin: "6px 0 4px", color: "var(--dim)", fontSize: 13 }}>
            <span style={{ flex: 1, height: 1, background: "var(--line-2)" }} />
            or someone new
            <span style={{ flex: 1, height: 1, background: "var(--line-2)" }} />
          </div>
        )}
        <form
          style={{ display: "grid", gap: 10, marginTop: 10 }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            const p = await api("/people", { name: name.trim(), role: role.trim() });
            onPick(p.id);
          }}
        >
          <input placeholder="Your first name" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!state.people.length} />
          <input placeholder="Your title (for example designer, engineer, CPO)" value={role} onChange={(e) => setRole(e.target.value)} />
          <button className="btn primary" style={{ height: 44, justifyContent: "center" }}>
            Join the room
          </button>
        </form>
      </div>
    </div>
  );
}
