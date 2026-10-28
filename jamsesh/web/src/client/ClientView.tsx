import { useEffect, useMemo, useState } from "react";
import { Logo } from "../host/HostView";
import { api, deviceId, pref, setPref, useHub, type Artifact, type HubState } from "../shared/hub";
import { Mic, type MicStatus } from "../shared/mic";
import { SettingsDrawer } from "../shared/Settings";
import { AgentRow, ArtifactTile, Avatar, CanvasFrame, Meter, RoomFeed, Toasts, modeLabel } from "../shared/ui";
import { PhotoAvatar, ShareControls, ShareRequestPrompt } from "../shared/share";
import { ProfileDrawer, VoiceEnroll } from "./Profile";

const DEVICE = deviceId("client");
const mic = new Mic(DEVICE);

type Tab = "canvas" | "work" | "agents";

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
  useEffect(() => {
    if (!me) return;
    api("/devices", { deviceId: DEVICE, label: `${me.name}'s laptop`, personId: me.id, micOn: micStatus.on }).catch(() => {});
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
      <header className="row between" style={{ height: 56, padding: "0 16px", borderBottom: "1px solid var(--line)", flex: "none" }}>
        <div className="row" style={{ gap: 12 }}>
          <Logo size={26} />
          <strong style={{ fontWeight: 650 }}>JamSesh</strong>
          <span className="chip">{state.settings.sessionName}</span>
        </div>
        <nav className="row" style={{ gap: 2, background: "var(--panel)", padding: 3, borderRadius: 999, border: "1px solid var(--line)" }}>
          {(
            [
              ["canvas", "Canvas"],
              ["work", "Work"],
              ["agents", "Agents"],
            ] as const
          ).map(([t, label]) => (
            <button key={t} className="btn small" style={{ height: 28, borderColor: "transparent", background: tab === t ? "var(--panel-3)" : "transparent", color: tab === t ? "var(--text)" : "var(--muted)" }} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="row" style={{ gap: 10 }}>
          <span className="chip" title="What the big screen shows">
            Big screen: {state.stage.mode === "welcome" ? "board" : state.stage.title || state.stage.mode}
          </span>
          <button className={`btn small ${micStatus.on ? "on" : ""}`} onClick={toggleMic} title={micStatus.error ?? "Mute or unmute (M). Your laptop's mic helps JamSesh hear and recognize you."}>
            {micStatus.on ? <Meter db={micStatus.level} /> : null}
            {micStatus.on ? (micStatus.speaking ? "Hearing you" : "Listening") : "Muted"}
          </button>
          <ShareControls personId={me.id} />
          <button className="row btn ghost small" onClick={() => setProfile(true)} title="Your profile: photo, title, voice">
            <PhotoAvatar person={me} size={22} />
            {me.name}
          </button>
          <button className="btn ghost small" onClick={() => setSettings(true)} title="Settings" aria-label="Settings">
            ⚙︎
          </button>
        </div>
      </header>
      {micStatus.error && (
        <div style={{ padding: "8px 16px", background: "var(--warn-bg)", color: "var(--warn)", fontSize: 13 }}>{micStatus.error}</div>
      )}

      <main style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) 380px" }}>
        <section style={{ minHeight: 0, minWidth: 0, position: "relative" }}>
          <div style={{ position: "absolute", inset: 0, display: tab === "canvas" ? "block" : "none" }}>
            <CanvasFrame kind="edit" name={me.name} title="Shared canvas" />
          </div>
          {tab === "work" && <WorkGallery state={state} />}
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
          <div className="drawer" style={{ top: "50%", left: "50%", right: "auto", bottom: "auto", transform: "translate(-50%, -50%)", width: "min(520px, 92vw)", borderRadius: 22, border: "1px solid var(--line-2)", padding: "8px 24px 20px" }}>
            <VoiceEnroll me={me} brainName={state.settings.brainName} />
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost small" onClick={() => (setPref("enrollAsked", "1"), setEnrollAsked(true))}>
                {me.voiceSamples ? "Done" : "Skip for now"}
              </button>
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

function WorkGallery({ state }: { state: HubState }) {
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
              <div key={a.id} style={{ height: 300, display: "flex" }}>
                <ArtifactTile art={a} state={state} variant={a.variant || undefined} live={false} onClick={() => show([a], a.title)} />
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
        <p style={{ color: "var(--muted)", marginTop: 0 }}>Your name and role tell the room brain who's talking and whose call counts.</p>
        {state.people.length > 0 && (
          <div style={{ display: "grid", gap: 6, margin: "18px 0" }}>
            {state.people.map((p) => (
              <button key={p.id} className="btn" style={{ justifyContent: "flex-start", height: 44 }} onClick={() => onPick(p.id)}>
                <PhotoAvatar person={p} size={26} /> I'm {p.name}
                {p.role && <span style={{ color: "var(--dim)" }}>· {p.role}</span>}
              </button>
            ))}
          </div>
        )}
        <form
          style={{ display: "grid", gap: 10, marginTop: 14 }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            const p = await api("/people", { name: name.trim(), role: role.trim() });
            onPick(p.id);
          }}
        >
          <input placeholder="Your first name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <input placeholder="Your role (for example designer, engineer, CPO)" value={role} onChange={(e) => setRole(e.target.value)} />
          <button className="btn primary" style={{ height: 44, justifyContent: "center" }}>
            Join the room
          </button>
        </form>
      </div>
    </div>
  );
}
