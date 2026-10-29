import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Logo } from "../host/HostView";
import { api, deviceId, hub, pref, setPref, useHub, type Artifact, type HubState, type Stage as StageState } from "../shared/hub";
import { fadeOut, playChime } from "../shared/sound";
import { HistoryStrip, StageBar } from "../shared/StageControls";
import { Mic, type MicStatus } from "../shared/mic";
import { SettingsDrawer } from "../shared/Settings";
import { AgentRow, ArtifactTile, Avatar, CanvasFrame, Meter, RoomFeed, Toasts, modeLabel } from "../shared/ui";
import { PhotoAvatar, ShareControls, ShareRequestPrompt } from "../shared/share";
import { CloseIcon, RoomIcon, SendIcon, useLayout, usePhoneChrome, type Layout } from "./mobile";
import { ProfileDrawer, VoiceEnroll } from "./Profile";
import { Stage, expandTile, stageTiles } from "../host/Stage";
import { cast, putOnScreen } from "./CastPicker";
import { InviteButton } from "./Invite";
import { WorkViewer } from "./WorkViewer";
import { groupArtifacts, settle, type WorkFilter } from "./viewerNav";
import { isTypingTarget, plain } from "../shared/keys";
import { MicNotice } from "../shared/MicNotice";
import { canShareScreen } from "../shared/rtc";
import { GearIcon, MicIcon, MicOffIcon, SpeakerIcon, SpeakerOffIcon } from "../shared/icons";
import { TasksView, triageCount } from "../shared/Tasks";
import { WikiView } from "../wiki/WikiView";
import { SettledLinks } from "../wiki/SettledLinks";
import { onWikiOpen } from "../wiki/nav";
import { AttachButton, AttachTray, composerState, filesFrom, hasFiles, useAttachments } from "../shared/attach";
import { AnnotateToggle, AnnotationsPanel, PinLayer, RecordPrompt, useAnnotateMode } from "../shared/annotate";

const DEVICE = deviceId("client");
const mic = new Mic(DEVICE);
const PHONE_MIRROR_SCALE = { phone: 0.62, landscape: 0.74 } as const;

type Tab = "canvas" | "screen" | "work" | "wiki" | "tasks" | "pins" | "agents";

export function ClientView() {
  const { state, connected } = useHub();
  const [personId, setPersonId] = useState(pref("personId"));
  const [tab, setTab] = useState<Tab>((pref("tab") as Tab) || "canvas");
  const [settings, setSettings] = useState(false);
  const [profile, setProfile] = useState(false);
  const [enrollAsked, setEnrollAsked] = useState(pref("enrollAsked") === "1");
  const [micStatus, setMicStatus] = useState<MicStatus>(mic.status);
  const me = state?.people.find((p) => p.id === personId);
  // Which person the host has bound this window to (its acknowledged registration), or why it won't yet.
  const [registered, setRegistered] = useState<string | null>(null);
  const [refused, setRefused] = useState("");
  // The join read is asked for once the host knows this window is them (only their own window may read for them).
  const voiceReady = !!me && registered === me.id;
  const layout = useLayout();

  // A link elsewhere in the app (the Work tab) asked for a wiki page.
  useEffect(() => {
    const off = onWikiOpen(() => setTab("wiki"));
    return () => void off();
  }, []);
  useEffect(() => {
    const off = mic.onChange(setMicStatus);
    return () => void off();
  }, []);
  // Remote people don't hear the room speaker: the brain's voice and chime play here instead.
  const myDevice = state?.devices.find((d) => d.id === DEVICE);
  // What this person picked in the room-or-remote chooser wins over the hub's network guess.
  const remote = myDevice?.location === "remote" && pref("location") !== "room";
  useEffect(() => {
    mic.remote = remote;
    if (!remote) return;
    let audio: HTMLAudioElement | null = null;
    const onSpeak = (m: { audio: string | null; mime: string }) => {
      if (!m.audio || pref("hearBrain") === "off") return;
      if (audio) (audio.onpause = null), audio.pause();
      const a = (audio = new Audio(`data:${m.mime};base64,${m.audio}`));
      a.onended = () => mic.playbackEnded();
      a.onpause = () => mic.playbackEnded();
      a.play().catch(() => mic.playbackEnded());
    };
    // Talking over the brain stops it here too, as it does on the room speaker.
    const onBarge = () => audio && !audio.paused && fadeOut(audio);
    mic.onBargeIn.add(onBarge);
    hub.speakListeners.add(onSpeak);
    const offChime = hub.onMessage((m) => m.type === "chime" && m.deviceId !== hub.deviceId && pref("hearBrain") !== "off" && playChime());
    return () => {
      hub.speakListeners.delete(onSpeak);
      mic.onBargeIn.delete(onBarge);
      offChime();
      if (audio) (audio.onpause = null), audio.pause();
    };
  }, [remote]);
  // Heard you: the chime also plays on the laptop that spoke or recorded.
  useEffect(() => {
    const off = hub.onMessage((m) => m.type === "chime" && m.deviceId === hub.deviceId && playChime());
    return () => void off();
  }, []);
  useEffect(() => {
    if (!me) return;
    // Never leave it to the hub's guess on the host Mac itself (loopback is always in the room).
    const location = pref("location") || (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(window.location.hostname) ? "room" : undefined);
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // Sent now, never queued: the voiceprint sync waits for the answer. Refused (the host hasn't let this
    // laptop in as them yet) or not reached, it's asked again until it is.
    const register = () =>
      api<{ personId?: string | null }>("/devices", { deviceId: DEVICE, label: `${me.name}'s laptop`, personId: me.id, micOn: micStatus.on, location }, "POST", { queue: false }).then(
        (d) => {
          if (!live) return;
          setRegistered(d?.personId ?? null);
          setRefused("");
        },
        (e) => {
          if (!live) return;
          if ((e as { status?: number }).status === 403) setRefused((e as Error).message);
          retry = setTimeout(register, 10_000);
        },
      );
    void register();
    return () => {
      live = false;
      clearTimeout(retry);
    };
  }, [me?.id, micStatus.on, connected]);
  useEffect(() => {
    setPref("tab", tab);
  }, [tab]);
  // M mutes or unmutes from anywhere outside a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "m" || !plain(e) || isTypingTarget(e)) return;
      if (mic.status.on) (mic.stop(), setPref("mic", "off"));
      else mic.start().then(() => setPref("mic", "on")).catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    // Your mic listens from the moment you join, unless you muted it. On the host Mac itself the room
    // mic (in the big screen) already hears you: a second capture of the same mic only competes.
    if (me && pref("mic") !== "off" && !mic.status.on)
      api<{ onHost: boolean }>("/me")
        .then((m) => {
          if (!m.onHost) void mic.start().catch(() => {});
        })
        .catch(() => mic.start().catch(() => {}));
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

  if (layout !== "desktop") {
    return (
      <PhoneClient
        layout={layout}
        state={state}
        me={me}
        tab={tab}
        setTab={setTab}
        micStatus={micStatus}
        toggleMic={toggleMic}
        myAgents={myAgents}
        pending={pending}
        remote={remote}
        openProfile={() => setProfile(true)}
        openSettings={() => setSettings(true)}
        overlays={
          <>
            <Toasts />
            {refused && <Refused text={refused} onPickAgain={() => (setPref("personId", ""), setPersonId(""))} />}
            <ShareRequestPrompt />
            {profile && <ProfileDrawer me={me} micError={micStatus.error} brainName={state.settings.brainName} onClose={() => setProfile(false)} />}
            {voiceReady && !enrollAsked && me.voiceSamples === 0 && !micStatus.error && <EnrollModal me={me} brainName={state.settings.brainName} done={() => (setPref("enrollAsked", "1"), setEnrollAsked(true))} />}
            {settings && <SettingsDrawer host={false} onClose={() => setSettings(false)} />}
          </>
        }
      />
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <header className={`app-header client-header ${remote ? "remote" : ""}`} style={{ height: 56, padding: "0 16px", borderBottom: "1px solid var(--line)", flex: "none" }}>
        <div className="header-left">
          <Logo size={26} />
          <strong className="wordmark" style={{ fontWeight: 650 }}>JamSesh</strong>
          <span className="chip session-name ellipsis" style={{ maxWidth: 180 }}>{state.settings.sessionName}</span>
        </div>
        <TabNav state={state} tab={tab} setTab={setTab} />
        <div className="header-right">
          {remote && <span className="badge neutral" title="You're joining remotely: the Screen tab mirrors the big screen" >Remote</span>}
          <BigScreenChip stage={state.stage} />
          <button className={`btn small mic-btn ${micStatus.on ? "on" : "muted"}`} style={{ height: 36 }} onClick={toggleMic} title={micStatus.error ?? (micStatus.on ? "Mute (M)" : "Unmute (M)")} aria-label={micStatus.on ? "Mute" : "Unmute"}>
            {micStatus.on ? <MicIcon size={16} /> : <MicOffIcon size={16} />}
            {micStatus.on && <Meter db={micStatus.level} />}
            <span className="mic-label">{micStatus.on ? (micStatus.speaking ? "Hearing you" : "Listening") : "Muted"}</span>
          </button>
          {remote && <HearBrainToggle brainName={state.settings.brainName} />}
          <RecordPrompt personId={me.id} brainName={state.settings.brainName} mic={mic} />
          <AnnotateToggle />
          <ShareControls personId={me.id} />
          <InviteButton compact />
          <button className="row btn ghost small" style={{ height: 36, padding: "0 8px" }} onClick={() => setProfile(true)} title="Your profile: photo, title, voice" aria-label={`Your profile (${me.name})`}>
            <PhotoAvatar person={me} size={24} />
            <span className="me-name">{me.name}</span>
          </button>
          <button className="icon-btn" onClick={() => setSettings(true)} title="Settings" aria-label="Settings">
            <GearIcon size={17} />
          </button>
        </div>
      </header>
      <MicNotice status={micStatus} onRetry={toggleMic} />
      {refused && <Refused text={refused} onPickAgain={() => (setPref("personId", ""), setPersonId(""))} />}

      <main className="client-main" style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) 380px" }}>
        <section style={{ minHeight: 0, minWidth: 0, position: "relative" }}>
          <TabContent tab={tab} state={state} me={me} layout="desktop" />
        </section>

        <aside style={{ minHeight: 0, display: "flex", flexDirection: "column", borderLeft: "1px solid var(--line)", background: "var(--bg-2)" }}>
          <RoomPanel state={state} me={me} myAgents={myAgents} pending={pending} layout="desktop" />
        </aside>
      </main>
      <Toasts />
      <ShareRequestPrompt />
      {profile && <ProfileDrawer me={me} micError={micStatus.error} brainName={state.settings.brainName} onClose={() => setProfile(false)} />}
      {voiceReady && !enrollAsked && me.voiceSamples === 0 && !micStatus.error && <EnrollModal me={me} brainName={state.settings.brainName} done={() => (setPref("enrollAsked", "1"), setEnrollAsked(true))} />}
      {settings && <SettingsDrawer host={false} onClose={() => setSettings(false)} />}
    </div>
  );
}

/** The host won't let this window be that person yet: say why, and let them pick someone else. */
function Refused({ text, onPickAgain }: { text: string; onPickAgain: () => void }) {
  return (
    <div className="mic-notice info" role="status">
      <span>{text}</span>
      <button className="btn small" onClick={onPickAgain}>
        Pick someone else
      </button>
    </div>
  );
}

/** What the big screen shows. Off the board it is a button, so nobody is stuck with someone else's pick. */
function BigScreenChip({ stage }: { stage: StageState }) {
  const home = stage.mode === "welcome" || stage.mode === "board";
  if (home) {
    return (
      <span className="chip big-screen-chip ellipsis" title="What the big screen shows">
        On screen: board
      </span>
    );
  }
  return (
    <button
      className="chip big-screen-chip release"
      onClick={() => void putOnScreen({ mode: "board", by: "Someone in the room" })}
      title={stage.pinned ? "Pinned. Click to put the big screen back on the board" : "Click to put the big screen back on the board"}
    >
      <span className="bsc-what ellipsis">On screen: {stage.title || stage.mode}</span>
      <span className="bsc-back">Back to board</span>
    </button>
  );
}

type Tab_ = Tab;
const TABS: Tab_[] = ["canvas", "screen", "work", "wiki", "tasks", "pins", "agents"];
const TAB_LABEL: Record<Tab_, string> = { canvas: "Canvas", screen: "Screen", work: "Work", wiki: "Wiki", tasks: "Tasks", pins: "Pins", agents: "Agents" };

function TabNav({ state, tab, setTab, phone }: { state: HubState; tab: Tab; setTab: (t: Tab) => void; phone?: boolean }) {
  const open = state.annotations.filter((a) => a.status === "open").length;
  const waiting = triageCount(state);
  return (
    <nav className={phone ? "m-tabs" : "header-center row"} aria-label="Views" style={phone ? undefined : { gap: 2, background: "var(--panel)", padding: 3, borderRadius: 999, border: "1px solid var(--line)", flex: "none" }}>
      {TABS.map((t) => (
        <button
          key={t}
          className={phone ? `m-tab ${tab === t ? "on" : ""}` : "btn small"}
          style={phone ? undefined : { height: 28, borderColor: "transparent", background: tab === t ? "var(--panel-3)" : "transparent", color: tab === t ? "var(--text)" : "var(--muted)" }}
          aria-current={tab === t ? "page" : undefined}
          onClick={() => setTab(t)}
        >
          {TAB_LABEL[t]}
          {t === "tasks" && waiting > 0 && (phone ? <span className="m-tab-count">{waiting}</span> : ` · ${waiting}`)}
          {t === "pins" && open > 0 && (phone ? <span className="m-tab-count">{open}</span> : ` · ${open}`)}
        </button>
      ))}
    </nav>
  );
}

function EnrollModal({ me, brainName, done }: { me: HubState["people"][number]; brainName: string; done: () => void }) {
  return (
    <>
      <div className="scrim" />
      <div className="modal-wrap">
        <div className="modal" role="dialog" aria-label="Teach JamSesh your voice">
          <VoiceEnroll me={me} brainName={brainName} />
          <div className="row" style={{ justifyContent: "flex-end", paddingTop: 4 }}>
            <button className="btn ghost small modal-skip" onClick={done}>
              {me.voiceSamples ? "Done" : "Skip for now"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/** The seven views, the same on every screen size except the Screen tab, which a phone scales down. */
function TabContent({ tab, state, me, layout }: { tab: Tab; state: HubState; me: HubState["people"][number]; layout: Layout }) {
  const phone = layout !== "desktop";
  return (
    <>
      <div data-jam-target={JSON.stringify({ kind: "canvas", ref: "canvas", label: "Canvas" })} style={{ position: "absolute", inset: 0, display: tab === "canvas" ? "block" : "none" }}>
        <CanvasFrame kind={phone ? "view" : "edit"} name={me.name} title="Shared canvas" panels={!phone} />
        <PinSlot target={{ kind: "canvas", ref: "canvas", label: "Canvas" }} personId={me.id} />
      </div>
      {tab === "screen" &&
        (phone ? (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", padding: "0 12px" }}>
            <div style={{ flex: "none", paddingTop: 8 }}>
              <StageBar state={state} drive />
            </div>
            <div style={{ position: "relative", flex: 1, minHeight: 0, margin: "0 -12px" }}>
              <MirrorStage state={state} personId={me.id} scale={PHONE_MIRROR_SCALE[layout as "phone" | "landscape"]} />
            </div>
            <TileBar state={state} />
            <HistoryStrip state={state} />
          </div>
        ) : (
          <div style={{ position: "absolute", inset: 0, padding: 18, display: "flex", flexDirection: "column" }}>
            <div style={{ flex: 1, minHeight: 0 }}>
              <Stage state={state} interactive drive="trackpad" />
            </div>
            <HistoryStrip state={state} />
          </div>
        ))}
      {tab === "work" && <WorkGallery state={state} personId={me.id} />}
      {tab === "wiki" && (
        <div className="tab-pane wiki-pane">
          <WikiView />
        </div>
      )}
      {tab === "tasks" && (
        <div className="tab-pane tasks-pane">
          <TasksView state={state} personId={me.id} />
        </div>
      )}
      {tab === "pins" && (
        <div className="tab-pane scrollbars-thin pins-pane">
          <AnnotationsPanel personId={me.id} />
        </div>
      )}
      {tab === "agents" && <AgentsPanel state={state} />}
    </>
  );
}

type Person_ = HubState["people"][number];

/** Your agents, what's pending for them, the room's transcript and the typed prompt box. */
function RoomPanel({ state, me, myAgents, pending, layout, say = true }: { state: HubState; me: Person_; myAgents: HubState["agents"]; pending: HubState["directives"]; layout: Layout; say?: boolean }) {
  const touch = layout !== "desktop";
  return (
    <>
      <div className="scrollbars-thin" style={{ padding: "12px 14px 6px", borderBottom: "1px solid var(--line)", maxHeight: "42%", overflowY: "auto", flex: "none" }}>
        <div className="label" style={{ marginBottom: 4 }}>
          Your agents
        </div>
        {myAgents.length === 0 ? (
          <div className="empty-note" style={{ padding: "6px 0 10px", fontSize: 13 }}>
            Tell Claude Code or Codex <span className="mono">connect to jamsesh</span> to bring one in.
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
          <span className="chip" style={{ fontSize: 12 }}>{touch ? "Tap" : "Click"} a name to fix who said it</span>
        </div>
        <RoomFeed editable />
      </div>
      {say && <SayBox personId={me.id} brainName={state.settings.brainName} phone={touch} />}
    </>
  );
}

/** Phone and landscape-phone shell: tabs on top, the mic / record / pin controls in a thumb-height dock. */
function PhoneClient({
  layout,
  state,
  me,
  tab,
  setTab,
  micStatus,
  toggleMic,
  myAgents,
  pending,
  remote,
  openProfile,
  openSettings,
  overlays,
}: {
  layout: Layout;
  state: HubState;
  me: Person_;
  tab: Tab;
  setTab: (t: Tab) => void;
  micStatus: MicStatus;
  toggleMic: () => void;
  myAgents: HubState["agents"];
  pending: HubState["directives"];
  remote: boolean;
  openProfile: () => void;
  openSettings: () => void;
  overlays: React.ReactNode;
}) {
  const [dock, setDock] = useState<HTMLElement | null>(null);
  const [room, setRoom] = useState(false);
  const annotate = useAnnotateMode();
  const land = layout === "landscape";
  usePhoneChrome(layout, dock);
  useEffect(() => {
    if (!room) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setRoom(false);
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [room]);

  const micBtn = (
    <button className={`m-act mic-btn ${micStatus.on ? "on" : "muted"}`} onClick={toggleMic} aria-label={micStatus.on ? "Mute your microphone" : "Unmute your microphone"} aria-pressed={micStatus.on}>
      {micStatus.on ? <MicIcon size={18} /> : <MicOffIcon size={18} />}
      <span className="m-act-label">{micStatus.on ? (micStatus.speaking ? "Hearing" : "Mic on") : "Muted"}</span>
      {micStatus.on && <Meter db={micStatus.level} />}
    </button>
  );
  const roomBtn = (
    <button className="m-act room-btn" onClick={() => setRoom(true)} aria-label="Open the room: transcript, agents and typed prompt">
      <RoomIcon />
      <span className="m-act-label">Room</span>
    </button>
  );

  return (
    <div className={`m-app ${land ? "land" : ""}`}>
      <header className="m-header">
        <Logo size={26} />
        {!land && <span className="m-title ellipsis">{state.settings.sessionName}</span>}
        {land && <TabNav state={state} tab={tab} setTab={setTab} phone />}
        {land && (
          <div className="m-header-actions">
            {micBtn}
            <RecordPrompt personId={me.id} brainName={state.settings.brainName} mic={mic} />
            <AnnotateToggle label="Pin" />
            {roomBtn}
          </div>
        )}
        {!land && remote && <span className="badge neutral m-remote">Remote</span>}
        <button className="m-icon" onClick={openProfile} aria-label={`Your profile (${me.name})`}>
          <PhotoAvatar person={me} size={30} />
        </button>
        <button className="m-icon" onClick={openSettings} aria-label="Settings">
          <GearIcon size={20} />
        </button>
      </header>
      {!land && <TabNav state={state} tab={tab} setTab={setTab} phone />}
      <MicNotice status={micStatus} onRetry={toggleMic} phone />

      <main className="m-main">
        <TabContent tab={tab} state={state} me={me} layout={layout} />
        {annotate.on && (
          <div className="m-hint" role="status">
            Tap anywhere to drop a pin
            <button onClick={() => annotate.set(false)} aria-label="Stop pinning">
              Done
            </button>
          </div>
        )}
      </main>

      {!land && (
        <footer className="m-dock" ref={setDock}>
          <SayBox personId={me.id} brainName={state.settings.brainName} phone />
          <div className="m-actions">
            {micBtn}
            <RecordPrompt personId={me.id} brainName={state.settings.brainName} mic={mic} />
            <AnnotateToggle label="Pin" />
            {roomBtn}
          </div>
        </footer>
      )}

      {room && (
        <>
          <div className="m-scrim" onClick={() => setRoom(false)} />
          <section className="m-sheet" role="dialog" aria-label="The room">
            <header>
              <h2>The room</h2>
              <ShareControls personId={me.id} kinds={canShareScreen() ? ["screen", "camera"] : ["camera"]} />
              {remote && <HearBrainToggle brainName={state.settings.brainName} />}
              <InviteButton compact />
              <button className="m-icon" onClick={() => setRoom(false)} aria-label="Close">
                <CloseIcon />
              </button>
            </header>
            <div className="m-sheet-body">
              <RoomPanel state={state} me={me} myAgents={myAgents} pending={pending} layout={layout} />
            </div>
          </section>
        </>
      )}
      {overlays}
    </div>
  );
}

/** Under the phone's mirror (too small to hit a tile's own Expand): one chip per tile, and Collapse. */
function TileBar({ state }: { state: HubState }) {
  const tiles = useMemo(() => stageTiles(state), [state]);
  const open = state.stage.expanded;
  if (tiles.length < 2 && !open) return null;
  return (
    <div className="m-tilebar" role="group" aria-label="Fill the big screen with one tile">
      {open && (
        <button className="btn small primary" onClick={() => expandTile(null)}>
          Collapse
        </button>
      )}
      {tiles.map((t, i) => (
        <button key={t.key} className={`btn small ${t.key === open ? "on" : ""}`} aria-pressed={t.key === open} onClick={() => expandTile(t.key)}>
          <b>{i + 1}</b>
          <span>{t.label}</span>
        </button>
      ))}
    </div>
  );
}

/** The big screen, laid out wide and scaled down to the phone so the whole picture fits. Tap to pin. */
function MirrorStage({ state, personId, scale }: { state: HubState; personId: string; scale: number }) {
  const mode = useAnnotateMode();
  const stage = state.stage;
  const empty = stage.mode === "welcome" && state.artifacts.length === 0;
  // Layout stages carry their own pin layers per tile; everything else gets one over the whole picture
  // (a finger can't aim at a tile that small), so the stage's own tile pins stay off.
  const solo = stage.mode === "spotlight" && stage.items.length === 1 ? state.artifacts.find((a) => a.id === stage.items[0]) : undefined;
  const target = solo
    ? { kind: (solo.kind === "devserver" ? "web" : "artifact") as "web" | "artifact", ref: solo.kind === "devserver" ? solo.url ?? solo.id : solo.id, label: solo.title }
    : { kind: "screen" as const, ref: `stage:${stage.mode}`, label: stage.title || "Big screen" };
  const pinAll = !empty && stage.mode !== "layout";
  return (
    <div className="m-mirror" data-jam-target={pinAll ? JSON.stringify(target) : undefined}>
      {empty ? (
        <div className="m-mirror-empty">
          <strong>Nothing on the big screen yet</strong>
          <span>When the room shares work, it mirrors here live. Tap it to pin a note.</span>
        </div>
      ) : (
        // Laid out larger and scaled down, in percentages, so it follows a resize in the same frame.
        <div className="m-mirror-inner" style={{ width: `${100 / scale}%`, height: `${100 / scale}%`, transform: `scale(${scale})` }}>
          <Stage state={state} interactive tilePins={false} drive="trackpad" />
        </div>
      )}
      {pinAll && <PinLayer target={target} personId={personId} enabled={mode.on} />}
    </div>
  );
}

function SayBox({ personId, brainName, phone }: { personId: string; brainName: string; phone?: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(true);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const files = useAttachments();
  const { canSend, blocked } = composerState(text, files.items, busy);
  return (
    <form
      className={`say ${phone ? "say-phone" : ""} ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDragging(false)}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        files.add(filesFrom(e.dataTransfer));
      }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!canSend) return;
        setBusy(true);
        const sent = await api("/say", { personId, text, direct: ask, attachments: files.ids }).then(
          () => true,
          () => false,
        );
        setBusy(false);
        // A send that failed keeps the words and the files, so nothing has to be added again.
        if (!sent) return;
        setText("");
        files.clear();
        if (phone) input.current?.blur();
      }}
    >
      <div className="say-modes">
        {[
          [true, `Ask ${brainName}`],
          [false, "Say to the room"],
        ].map(([v, label]) => (
          <button
            key={String(v)}
            type="button"
            className={`say-mode ${ask === v ? "on" : ""}`}
            aria-pressed={ask === v}
            // Keep the keyboard up while switching.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => setAsk(v as boolean)}
          >
            {label as string}
          </button>
        ))}
      </div>
      <AttachTray items={files.items} onRemove={files.remove} onRetry={files.retry} />
      {blocked && (
        <p className="say-blocked" role="status">
          {blocked}
        </p>
      )}
      <div className="say-row">
        <AttachButton onFiles={files.add} disabled={busy} />
        <input
          ref={input}
          className="grow"
          placeholder={ask ? `Tell ${brainName} what you need…` : "Say something to the room…"}
          aria-label={ask ? `Type a prompt for ${brainName}` : "Type something to say to the room"}
          enterKeyHint="send"
          autoComplete="off"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = filesFrom(e.clipboardData);
            if (!pasted.length) return;
            e.preventDefault();
            files.add(pasted);
          }}
          disabled={busy}
        />
        <button className="btn primary small say-send" disabled={!canSend} aria-label="Send">
          {phone ? <SendIcon /> : "Send"}
        </button>
      </div>
      {dragging && <div className="say-drop">Drop to attach</div>}
    </form>
  );
}

function PinSlot({ target, personId }: { target: { kind: "canvas" | "artifact" | "web" | "screen"; ref: string; label: string }; personId: string }) {
  const mode = useAnnotateMode();
  return <PinLayer target={target} personId={personId} enabled={mode.on} />;
}

function WorkGallery({ state, personId }: { state: HubState; personId: string }) {
  const [filter, setFilter] = useState<WorkFilter>("all");
  const groups = useMemo(() => groupArtifacts(state.artifacts, filter), [state.artifacts, filter]);
  // The viewer holds an item by id, so a newer version arriving or a neighbour being removed doesn't move it.
  const [viewing, setViewing] = useState<{ group: string; id: string } | null>(null);
  const name = state.people.find((p) => p.id === personId)?.name ?? "Someone in the room";
  const items = viewing ? groups.find(([g]) => g === viewing.group)?.[1] ?? [] : [];
  const index = viewing ? settle(items, viewing.id, 0) : 0;
  const close = useCallback(() => setViewing(null), []);
  const goTo = useCallback((i: number) => items[i] && setViewing((v) => v && { group: v.group, id: items[i].id }), [items]);
  // Putting work on the big screen is a deliberate act, shown to the room under the person's name.
  const show = (shown: Artifact[], title: string) =>
    cast({ mode: shown.length > 1 ? "compare" : "spotlight", items: shown.map((i) => i.id), title, caption: `${name} put this up`, pinned: false, by: name });
  return (
    <div className="tab-pane scrollbars-thin">
      <SettledLinks />
      <div className="row between wrap-row" style={{ margin: "28px 0 16px" }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 650 }}>Everything the room has made</h2>
        <div className="row filter-row" style={{ gap: 4 }}>
          {(["all", "mockup", "built"] as const).map((f) => (
            <button key={f} className="btn small" style={{ background: filter === f ? "var(--panel-3)" : undefined }} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "mockup" ? "Mockups" : "Built"}
            </button>
          ))}
        </div>
      </div>
      {groups.length === 0 && <div className="empty-note">Nothing yet. Frames appear here as agents and people design on the canvas.</div>}
      {groups.map(([title, list]) => (
        <div key={title} style={{ marginBottom: 28 }}>
          <div className="row between wrap-row" style={{ marginBottom: 10 }}>
            <strong style={{ fontWeight: 600 }}>{title}</strong>
            <button className="btn small" onClick={() => show(list.slice(0, 6), title)}>
              Show on big screen
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
            {list.map((a) => (
              <div key={a.id} data-jam-target={JSON.stringify({ kind: "artifact", ref: a.id, label: a.title })} style={{ height: 300, display: "flex", position: "relative" }}>
                <ArtifactTile art={a} state={state} variant={a.variant || undefined} live={false} onClick={() => setViewing({ group: title, id: a.id })} />
                <PinSlot target={{ kind: "artifact", ref: a.id, label: a.title }} personId={personId} />
              </div>
            ))}
          </div>
        </div>
      ))}
      {viewing && items.length > 0 && <WorkViewer items={items} index={index} state={state} name={name} onIndex={goTo} onClose={close} onShow={(shown) => show(shown, shown.length > 1 ? viewing.group : shown[0].title)} />}
    </div>
  );
}

function AgentsPanel({ state }: { state: HubState }) {
  return (
    <div className="tab-pane scrollbars-thin">
      <h2 style={{ margin: "0 0 12px", fontSize: 20, fontWeight: 650 }}>Agents</h2>
      {state.agents.length === 0 && <div className="empty-note">No agents have joined yet.</div>}
      {state.agents.map((a) => (
        <div key={a.id} style={{ borderBottom: "1px solid var(--line)" }}>
          <AgentRow agent={a} state={state} />
        </div>
      ))}
      <h2 style={{ margin: "28px 0 12px", fontSize: 20, fontWeight: 650 }}>Session brief</h2>
      <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font)", color: "var(--muted)", margin: 0 }}>{state.digest || "The brief fills in as the session goes."}</pre>
      {state.devservers.length > 0 && (
        <>
          <h2 style={{ margin: "28px 0 12px", fontSize: 20, fontWeight: 650 }}>Dev servers on the host</h2>
          {state.devservers.map((d) => (
            <div key={d.id} className="row dev-row" style={{ padding: "6px 0" }}>
              <span className="dot" style={{ background: d.up ? "var(--built)" : "var(--faint)" }} />
              <a href={d.url} target="_blank" rel="noreferrer" style={{ color: "var(--text)" }}>
                {d.name}
              </a>
              <span className="chip mono ellipsis">{d.problem ?? d.url}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/** In the room or remote: decides how audio is grouped and whether the brain's voice plays here. */
export function WhereChooser({ compact }: { compact?: boolean }) {
  const { state } = useHub();
  // The host Mac's own window is always in the room: nothing to choose.
  const [onHost, setOnHost] = useState(false);
  useEffect(() => {
    api<{ onHost: boolean }>("/me")
      .then((m) => {
        setOnHost(!!m.onHost);
        if (m.onHost) {
          setPref("location", "room"); // the host Mac's own window is always in the room
          api("/devices", { deviceId: DEVICE, location: "room" }).catch(() => {});
        }
      })
      .catch(() => {});
  }, []);
  const guess = state?.devices.find((d) => d.id === DEVICE)?.location;
  const [where, setWhere] = useState(pref("location") || guess || "room");
  const pick = (w: "room" | "remote") => {
    setWhere(w);
    setPref("location", w);
    api("/devices", { deviceId: DEVICE, location: w }).catch(() => {});
  };
  if (onHost) return null;
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
    <div className="onboard">
      <div className="onboard-card">
        <Logo size={40} />
        <div className="label" style={{ marginBottom: 6 }}>
          {state.settings.sessionName}
        </div>
        <h1 className="onboard-h">Join the session</h1>
        <p style={{ color: "var(--muted)", marginTop: 0 }}>Your name and title tell the room brain who's talking and whose call counts.</p>
        <WhereChooser />
        {state.people.length > 0 && (
          <div style={{ display: "grid", gap: 6, margin: "18px 0" }}>
            {state.people.map((p) => (
              <button key={p.id} className="btn person-pick" onClick={() => onPick(p.id)}>
                <PhotoAvatar person={p} size={28} />
                <span className="ellipsis">I'm {p.name}</span>
                {p.role && <span className="ellipsis" style={{ color: "var(--dim)", marginLeft: "auto", paddingRight: 6, flex: "0 1 auto" }}>{p.role}</span>}
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
          <input placeholder="Your first name" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!state.people.length} autoComplete="given-name" autoCapitalize="words" enterKeyHint="next" />
          <input placeholder="Your title (designer, engineer, CPO)" value={role} onChange={(e) => setRole(e.target.value)} autoCapitalize="sentences" enterKeyHint="go" />
          <button className="btn primary onboard-go">
            Join the room
          </button>
        </form>
      </div>
    </div>
  );
}

/** Remote people hear the brain on their own laptop; this turns that voice (and its chime) off or on. */
function HearBrainToggle({ brainName }: { brainName: string }) {
  const [on, setOn] = useState(pref("hearBrain") !== "off");
  const flip = () => {
    setPref("hearBrain", on ? "off" : "on");
    setOn(!on);
  };
  return (
    <button className="btn small ghost" style={{ height: 36, padding: "0 8px" }} onClick={flip} aria-pressed={on} title={on ? `Stop hearing ${brainName} on this laptop` : `Hear ${brainName}'s voice on this laptop`} aria-label={on ? `Mute ${brainName}'s voice` : `Hear ${brainName}'s voice`}>
      {on ? <SpeakerIcon size={16} /> : <SpeakerOffIcon size={16} />}
    </button>
  );
}
