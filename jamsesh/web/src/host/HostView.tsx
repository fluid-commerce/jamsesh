import { useEffect, useRef, useState } from "react";
import { api, deviceId, hub, pref, setPref, useHub, type StageMode } from "../shared/hub";
import { Mic, type MicStatus } from "../shared/mic";
import { SettingsDrawer } from "../shared/Settings";
import { AgentRow, Avatar, Meter, RoomFeed, Toasts, useNow } from "../shared/ui";
import { Stage } from "./Stage";
import { AnnotateToggle } from "../shared/annotate";

const DEVICE = deviceId("host");
const mic = new Mic(DEVICE);

const MODES: { mode: StageMode; label: string; key: string }[] = [
  { mode: "board", label: "Board", key: "1" },
  { mode: "canvas", label: "Canvas", key: "2" },
  { mode: "agents", label: "Agents", key: "3" },
];

export function HostView() {
  const { state, connected, thinking, speaking, levels } = useHub();
  const [settings, setSettings] = useState(false);
  const [micStatus, setMicStatus] = useState<MicStatus>(mic.status);
  const now = useNow(1000);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    api("/devices", { deviceId: DEVICE, label: "Room mic (host)", kind: "host" }).catch(() => {});
    const off = mic.onChange(setMicStatus);
    // Play the brain's replies on the room speaker.
    const onSpeak = (m: { audio: string | null; mime: string }) => {
      if (!m.audio) return;
      audioRef.current?.pause();
      audioRef.current = new Audio(`data:${m.mime};base64,${m.audio}`);
      audioRef.current.play().catch(() => {});
    };
    hub.speakListeners.add(onSpeak);
    if (pref("hostMic") === "on") mic.start().catch(() => {});
    return () => {
      off();
      hub.speakListeners.delete(onSpeak);
    };
  }, []);

  useEffect(() => {
    api("/devices", { deviceId: DEVICE, label: "Room mic (host)", kind: "host", micOn: micStatus.on }).catch(() => {});
  }, [micStatus.on]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      const m = MODES.find((x) => x.key === e.key);
      if (m) api("/stage", { mode: m.mode, pinned: m.mode !== "board", by: "Host" });
      if (e.key === "Escape" && !settings) api("/stage", { mode: "board", by: "Host" });
      if (e.key === "f") document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
      if (e.key === ",") setSettings(true);
      if (e.key.toLowerCase() === "m" && !e.metaKey && !e.ctrlKey) {
        if (mic.status.on) (mic.stop(), setPref("hostMic", "off"));
        else mic.start().then(() => setPref("hostMic", "on")).catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settings]);

  if (!state) return <Splash connected={connected} />;

  const toggleMic = async () => {
    if (micStatus.on) {
      mic.stop();
      setPref("hostMic", "off");
    } else {
      await mic.start().catch(() => {});
      setPref("hostMic", "on");
    }
  };
  const activeAgents = state.agents.filter((a) => a.status !== "offline");
  const micDevices = state.devices.filter((d) => d.micOn);
  const brain = state.brain;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", padding: "18px 22px 22px", gap: 16 }}>
      <header className="row between" style={{ height: 44, flex: "none" }}>
        <div className="row" style={{ gap: 14 }}>
          <Logo />
          <span style={{ fontSize: 20, fontWeight: 650, letterSpacing: "-0.02em" }}>JamSesh</span>
          <span style={{ color: "var(--dim)", fontSize: 18 }}>{state.settings.sessionName}</span>
        </div>

        <nav className="row" style={{ gap: 4, background: "var(--panel)", border: "1px solid var(--line)", padding: 4, borderRadius: 999 }}>
          {MODES.map((m) => {
            const active = state.stage.mode === m.mode || (m.mode === "board" && ["board", "welcome"].includes(state.stage.mode));
            return (
              <button
                key={m.mode}
                className="btn small"
                style={{ background: active ? "var(--panel-3)" : "transparent", borderColor: "transparent", color: active ? "var(--text)" : "var(--muted)", height: 32, padding: "0 16px", fontSize: 14 }}
                onClick={() => api("/stage", { mode: m.mode, pinned: m.mode !== "board", by: "Host" })}
              >
                {m.label}
              </button>
            );
          })}
          {!["board", "welcome", "canvas", "agents"].includes(state.stage.mode) && (
            <button className="btn small" style={{ height: 32, background: "var(--panel-3)", borderColor: "transparent" }} onClick={() => api("/stage", { mode: "board", by: "Host" })} title="Back to the board (Esc)">
              {state.stage.title || state.stage.mode} ✕
            </button>
          )}
        </nav>

        <div className="row" style={{ gap: 16 }}>
          {thinking && (
            <span className="chip" style={{ color: "var(--directive)" }}>
              <span className="dot" style={{ background: "var(--directive)", animation: "pulse 1s infinite" }} /> {thinking}
            </span>
          )}
          <span className="row" style={{ gap: 6 }} title={`${micDevices.length} mic${micDevices.length === 1 ? "" : "s"} listening`}>
            {micDevices.map((d) => {
              const p = state.people.find((x) => x.id === d.personId);
              const lvl = levels[d.id] ?? -90;
              return (
                <span key={d.id} style={{ borderRadius: "50%", boxShadow: lvl > -45 ? `0 0 0 3px ${p?.color ?? "#fff"}55` : "none", transition: "box-shadow .15s" }}>
                  <Avatar name={p?.name ?? "Room"} color={p?.color ?? "#5d6168"} size={26} photo={p?.photo} />
                </span>
              );
            })}
          </span>
          <button className={`btn small ${micStatus.on ? "on" : ""}`} onClick={toggleMic} title={micStatus.error ?? "The host's room microphone"}>
            {micStatus.on ? <Meter db={micStatus.level} /> : null}
            {micStatus.on ? "Room mic" : "Room mic muted"}
          </button>
          <AnnotateToggle />
          <BrainPill status={brain.status} error={brain.lastError} name={state.settings.brainName} />
          <span className="mono" style={{ color: "var(--muted)", letterSpacing: "0.14em", fontSize: 15 }} title="Join code">
            {state.session.code}
          </span>
          <span className="mono" style={{ color: "var(--dim)", fontSize: 15 }}>
            {new Date(now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </span>
          <button className="btn ghost small" onClick={() => setSettings(true)} title="Settings (,)">
            <Gear />
          </button>
        </div>
      </header>

      <main style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) clamp(320px, 22vw, 440px)", gap: 18 }}>
        <section style={{ minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <Stage state={state} interactive />
        </section>
        <aside style={{ minHeight: 0, display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="tile" style={{ flex: 1, padding: "14px 12px 10px", animation: "none" }}>
            <div className="row between" style={{ padding: "0 8px 8px" }}>
              <span className="label">The room</span>
              {state.digest && <span className="chip" title={state.digest}>brief ready</span>}
            </div>
            <RoomFeed big filter="room" />
          </div>
          <div className="tile" style={{ flex: "none", padding: "12px 18px", animation: "none", maxHeight: "38%" }}>
            <div className="label" style={{ marginBottom: 2 }}>
              Agents {activeAgents.length ? `· ${activeAgents.length}` : ""}
            </div>
            <div style={{ overflowY: "auto", scrollbarWidth: "none" }}>
              {activeAgents.length === 0 && <div className="empty-note">No agents yet. Type /jamsesh in Claude Code or Codex.</div>}
              {activeAgents.map((a) => (
                <AgentRow key={a.id} agent={a} state={state} compact />
              ))}
            </div>
          </div>
        </aside>
      </main>

      {speaking && (
        <div style={{ position: "fixed", left: "50%", bottom: 34, transform: "translateX(-50%)", maxWidth: "70vw", padding: "16px 26px", borderRadius: 20, background: "rgba(22,24,27,.94)", border: "1px solid var(--line-2)", fontSize: 24, animation: "rise .35s var(--ease) both", display: "flex", gap: 14, alignItems: "center" }}>
          <Logo size={26} />
          {speaking}
        </div>
      )}
      {!connected && <Offline />}
      <Toasts big />
      {settings && <SettingsDrawer host onClose={() => setSettings(false)} />}
    </div>
  );
}

function BrainPill({ status, error, name }: { status: string; error: string | null; name: string }) {
  const map: Record<string, [string, string]> = {
    ready: ["var(--built)", `${name} is listening`],
    thinking: ["var(--directive)", `${name} is thinking`],
    offline: ["var(--faint)", `${name} is off`],
    "no-key": ["var(--warn)", "Add a gateway key"],
  };
  const [c, label] = map[status] ?? map.ready;
  return (
    <span className="chip" style={{ color: status === "no-key" ? "var(--warn)" : "var(--muted)" }} title={error ?? undefined}>
      <span className="dot" style={{ background: c }} /> {label}
    </span>
  );
}

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="16" fill="#1c1f23" />
      <circle cx="24" cy="32" r="10" fill="#FF6B4A" />
      <circle cx="40" cy="32" r="10" fill="#3E8BFF" fillOpacity=".9" style={{ mixBlendMode: "screen" }} />
    </svg>
  );
}

function Gear() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}

function Splash({ connected }: { connected: boolean }) {
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
      <div className="row" style={{ gap: 14, color: "var(--muted)" }}>
        <Logo />
        {connected ? "Loading the session…" : "Connecting to the hub…"}
      </div>
    </div>
  );
}

function Offline() {
  return (
    <div style={{ position: "fixed", bottom: 20, left: 20, padding: "10px 16px", borderRadius: 12, background: "var(--warn-bg)", color: "var(--warn)", border: "1px solid rgba(255,107,94,.3)" }}>
      Lost the hub. Reconnecting…
    </div>
  );
}
