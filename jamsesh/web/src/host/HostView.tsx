import { useEffect, useRef, useState } from "react";
import { api, deviceId, hub, pref, setPref, useHub, type HubState, type StageMode } from "../shared/hub";
import { stageAction } from "../shared/StageControls";
import { Mic, type MicStatus } from "../shared/mic";
import { SettingsDrawer } from "../shared/Settings";
import { AgentRow, Avatar, Meter, RoomFeed, Toasts, useNow } from "../shared/ui";
import { Stage } from "./Stage";
import { CodeRing, JoinCard, useJoinCode } from "./JoinCard";
import { fadeOut, playChime } from "../shared/sound";
import { AnnotateToggle } from "../shared/annotate";
import { InviteButton } from "../client/Invite";
import { MicNotice } from "../shared/MicNotice";
import { isTypingTarget, plain, useReclaimFocus } from "../shared/keys";

const MODE_LABEL: Record<string, string> = { spotlight: "Spotlight", compare: "Compare", parity: "Parity", custom: "Custom view", layout: "Layout", join: "How to join" };
import { GearIcon, MicIcon, MicOffIcon } from "../shared/icons";

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
  const [invite, setInvite] = useState(false);
  const [micStatus, setMicStatus] = useState<MicStatus>(mic.status);
  const now = useNow(1000);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stageMode = useRef<StageMode>("board");
  stageMode.current = state?.stage.mode ?? "board";

  // Tell the brain the big screen's size and shape (and which display it's on) so it plans
  // layouts that fit. Again on every resize, move to another display, and reconnect.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const report = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void api("/display", { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, screenX: screenX + 1, screenY: screenY + 1 }).catch(() => {}), 400);
    };
    report();
    addEventListener("resize", report);
    const poll = setInterval(report, 60_000);
    const off = hub.onReconnect(report);
    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      removeEventListener("resize", report);
      off?.();
    };
  }, []);

  useEffect(() => {
    api("/devices", { deviceId: DEVICE, label: "Room mic (host)", kind: "host" }).catch(() => {});
    const off = mic.onChange(setMicStatus);
    // Play the brain's replies on the room speaker.
    const onSpeak = (m: { audio: string | null; mime: string }) => {
      if (!m.audio) return;
      const prev = audioRef.current;
      // Replaced, not finished: the new reply's echo suppression stays on.
      if (prev) (prev.onpause = null), prev.pause();
      const a = new Audio(`data:${m.mime};base64,${m.audio}`);
      // Once the voice stops, what the mic hears is people again.
      a.onended = () => mic.playbackEnded();
      a.onpause = () => mic.playbackEnded();
      audioRef.current = a;
      a.play().catch(() => mic.playbackEnded());
    };
    // Barge-in: someone in the room talks over the brain (louder than its echo), so it stops.
    const onBarge = () => {
      const a = audioRef.current;
      if (a && !a.paused) fadeOut(a);
    };
    mic.onBargeIn.add(onBarge);
    hub.speakListeners.add(onSpeak);
    const offChime = hub.onMessage((m) => m.type === "chime" && playChime());
    // The room mic listens unless someone muted it.
    if (pref("hostMic") !== "off") mic.start().catch(() => {});
    return () => {
      off();
      offChime();
      mic.onBargeIn.delete(onBarge);
      hub.speakListeners.delete(onSpeak);
    };
  }, []);

  useEffect(() => {
    api("/devices", { deviceId: DEVICE, label: "Room mic (host)", kind: "host", micOn: micStatus.on }).catch(() => {});
  }, [micStatus.on]);

  useReclaimFocus();
  const invOpen = useRef(false);
  invOpen.current = invite;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e) || !plain(e)) return;
      const k = e.key.toLowerCase();
      if (k === "escape") {
        if (invOpen.current) return setInvite(false);
        if (!settings) stageAction("/stage", { mode: "board", by: "Host" });
        return;
      }
      const m = MODES.find((x) => x.key === e.key);
      if (m) return void stageAction("/stage", { mode: m.mode, pinned: m.mode !== "board", by: "Host" });
      if (k === "j") return void stageAction("/stage", { mode: stageMode.current === "join" ? "board" : "join", by: "Host" });
      if (k === "f") return void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
      if (e.key === ",") return setSettings(true);
      if (k === "m") {
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
      <header className="app-header host-header" style={{ height: 44, flex: "none" }}>
        <div className="header-left">
          <Logo />
          <span style={{ fontSize: 20, fontWeight: 650, letterSpacing: "-0.02em" }}>JamSesh</span>
          <span className="session-name ellipsis" style={{ color: "var(--dim)", fontSize: 18, maxWidth: 260 }}>{state.settings.sessionName}</span>
        </div>

        <nav className="header-center row" style={{ gap: 4, background: "var(--panel)", border: "1px solid var(--line)", padding: 4, borderRadius: 999, marginInline: "auto" }}>
          {MODES.map((m) => {
            const active = state.stage.mode === m.mode || (m.mode === "board" && ["board", "welcome"].includes(state.stage.mode));
            return (
              <button
                key={m.mode}
                className="btn small"
                style={{ background: active ? "var(--panel-3)" : "transparent", borderColor: "transparent", color: active ? "var(--text)" : "var(--muted)", height: 32, padding: "0 16px", fontSize: 14 }}
                onClick={() => stageAction("/stage", { mode: m.mode, pinned: m.mode !== "board", by: "Host" })}
              >
                {m.label}
              </button>
            );
          })}
          {!["board", "welcome"].includes(state.stage.mode) && (
            <button
              className="btn small"
              style={{ height: 32, background: "var(--panel-3)", borderColor: "transparent", minWidth: 0 }}
              onClick={() => stageAction("/stage", { mode: "board", by: "Host" })}
              title={`${state.stage.pinned ? "Pinned: the room won't change this until you release it. " : "Comes back to the board by itself. "}Back to the board (Esc)`}
            >
              {state.stage.pinned && <PinGlyph />}
              <span className="stage-pill">{["canvas", "agents"].includes(state.stage.mode) ? "Pinned" : state.stage.title || MODE_LABEL[state.stage.mode] || state.stage.mode}</span>
              <span aria-hidden style={{ color: "var(--muted)" }}>✕</span>
            </button>
          )}
        </nav>

        <div className="header-right" style={{ gap: 14 }}>
          {thinking && (
            <span className="chip ellipsis" style={{ color: "var(--directive)", maxWidth: 260 }}>
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
          <button className={`btn small mic-btn ${micStatus.on ? "on" : "muted"} ${!micStatus.on && micStatus.error ? "broken" : ""}`} style={{ height: 36 }} onClick={toggleMic} title={micStatus.error ?? (micStatus.on ? "Mute the room mic (M)" : "Unmute the room mic (M)")}>
            {micStatus.on ? <MicIcon size={16} /> : <MicOffIcon size={16} />}
            {micStatus.on && <Meter db={micStatus.level} />}
            {micStatus.on ? (micStatus.speaking ? "Hearing…" : "Room mic") : micStatus.error ? (/reconnect/i.test(micStatus.error) ? "Reconnecting…" : "Mic problem") : "Muted"}
          </button>
          <AnnotateToggle />
          <PinsChip state={state} />
          <BrainPill status={brain.status} error={brain.lastError} name={state.settings.brainName} />
          <JoinPill onOpen={() => setInvite(true)} />
          <span className="mono clock" style={{ color: "var(--dim)", fontSize: 15 }}>
            {new Date(now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </span>
          <button className="icon-btn" onClick={() => setSettings(true)} title="Settings (,)" aria-label="Settings">
            <GearIcon size={17} />
          </button>
        </div>
      </header>

      <MicNotice status={micStatus} onRetry={toggleMic} />
      <main style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) clamp(320px, 22vw, 440px)", gap: 18 }}>
        <section style={{ minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <Stage state={state} interactive drive="replay" />
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
              {activeAgents.length === 0 && <div className="empty-note">No agents yet. Tell Claude Code or Codex “connect to jamsesh”.</div>}
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
      {invite && (
        <>
          <div className="scrim" onClick={() => setInvite(false)} />
          <div className="modal-wrap">
            <div className="modal" style={{ width: "auto", padding: "28px 36px" }} role="dialog" aria-label="Join this session">
              <JoinCard large />
              <div className="row" style={{ justifyContent: "center", marginTop: 14, gap: 10 }}>
                <InviteButton />
                <button className="btn small" onClick={() => setInvite(false)}>
                  Done
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function PinGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flex: "none", color: "var(--directive)" }}>
      <path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z" />
    </svg>
  );
}

/** Open pins from everyone, with one click to send them all to the brain as a single prompt. */
function PinsChip({ state }: { state: HubState }) {
  const open = state.annotations.filter((a) => a.status === "open").length;
  const [phase, setPhase] = useState<"idle" | "busy" | "done">("idle");
  if (!open && phase === "idle") return null;
  const send = async () => {
    setPhase("busy");
    await api("/annotations/send", { personId: null, ids: state.annotations.filter((a) => a.status === "open").map((a) => a.id) }).catch(() => {});
    setPhase("done");
    setTimeout(() => setPhase("idle"), 1800);
  };
  return (
    <button className="btn small pins-chip" style={{ height: 36 }} onClick={send} disabled={phase === "busy"} title={`Send ${open} open pin${open === 1 ? "" : "s"} to ${state.settings.brainName} as one prompt`}>
      <PinGlyph />
      {phase === "done" ? "Sent" : `Send ${open} pin${open === 1 ? "" : "s"}`}
    </button>
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
    <span className="chip" style={{ color: status === "no-key" ? "var(--warn)" : "var(--muted)" }} title={error ?? label}>
      <span className="dot" style={{ background: c }} /> <span className="brain-label">{label}</span>
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

/** The live join code in the header; opens the full invite card. */
function JoinPill({ onOpen }: { onOpen: () => void }) {
  const { code, left } = useJoinCode();
  return (
    <button className="btn small join-pill" style={{ height: 36 }} onClick={onOpen} title="Invite someone: QR, address and code. Press J to show it on the big screen">
      <CodeRing left={left} size={18} />
      <span className="mono" style={{ letterSpacing: "0.18em", fontSize: 15 }}>{code?.code ?? "····"}</span>
    </button>
  );
}
