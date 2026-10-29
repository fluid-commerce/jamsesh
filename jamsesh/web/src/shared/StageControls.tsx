// What a person put on the big screen is theirs until they unlock it; agents' items wait here (3.1).
// Also the strip of recent screens people can tap to bring back (3.6) and the badge that opens a
// built screen's earlier versions (3.5).
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, pref, useHub, type Artifact, type HubState } from "./hub";
import "./stagecontrols.css";

function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** "2 min ago", for badges where "2m" would read as a unit. */
export function agoWords(ts: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 15) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

const Lock = () => (
  <svg width="1em" height="1em" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3.2" y="7.2" width="9.6" height="6.4" rx="1.6" />
    <path d="M5.4 7.2V5.4a2.6 2.6 0 0 1 5.2 0v1.8" />
  </svg>
);

/** Above the stage: who holds the screen, and what's waiting to go up. Nothing when neither applies. */
export function StageBar({ state, screen = "main" }: { state: HubState; screen?: string }) {
  const [open, setOpen] = useState(false);
  const lock = state.stage.lock;
  const ready = screen === "main" ? state.readyToShow.filter((r) => r.screen === screen) : [];
  if (!lock && !ready.length) return null;
  const me = pref("personId");
  return (
    <div className="stage-bar" role="region" aria-label="Screen lock and waiting items">
      <div className="stage-bar-row">
        {lock && (
          <span className="stage-lock">
            <Lock /> Locked by <b>{lock.by}</b>
            <button className="btn small" onClick={() => api("/stage/unlock", { screen })} title={lock.personId && lock.personId === me ? "Let the room's agents and the brain change this screen again" : `Let go of ${lock.by}'s hold on this screen`}>
              Unlock
            </button>
          </span>
        )}
        {ready.length > 0 && (
          <button className={`stage-ready ${open ? "open" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
            Ready to show <b>{ready.length}</b>
          </button>
        )}
      </div>
      {open && ready.length > 0 && (
        <ul className="stage-queue">
          {ready.map((r) => (
            <li key={r.id}>
              <span className="stage-queue-what">
                <b>{r.label}</b> <span>{r.agentName}</span>
              </span>
              <button className="btn small primary" onClick={() => api(`/stage/ready/${r.id}`, { action: "show", personId: me })}>
                Show
              </button>
              <button className="btn small" onClick={() => api(`/stage/ready/${r.id}`, { action: "dismiss" })}>
                Dismiss
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Recent screens, newest first. Tapping one brings it back, unless someone else's lock holds the screen. */
export function HistoryStrip({ state, screen = "main" }: { state: HubState; screen?: string }) {
  const now = useNow(15_000);
  const [note, setNote] = useState("");
  const all = state.stageHistory?.[screen] ?? [];
  const entries = all[0]?.at === (screen === "main" ? state.stage : state.screens.find((s) => s.id === screen)?.stage)?.since ? all.slice(1) : all;
  if (!entries.length) return null;
  const restore = async (id: string) => {
    setNote("");
    try {
      await api("/stage/restore", { id, screen, personId: pref("personId") });
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't bring that back.");
    }
  };
  return (
    <div className="history-strip" role="region" aria-label="Recent screens">
      <span className="history-label">Earlier</span>
      <div className="history-items">
        {entries.slice(0, 8).map((e) => (
          <button key={e.id} className="history-item" onClick={() => restore(e.id)} title={`Bring back ${e.label}`}>
            <span className="history-what">{e.label}</span>
            <span className="history-by">
              {e.by} · {agoWords(e.at, now)}
            </span>
          </button>
        ))}
      </div>
      {note && (
        <span className="history-note" role="alert">
          {note}
        </span>
      )}
    </div>
  );
}

/** "v3 · 2 min ago" on a built screen that has earlier versions; opens them. Nothing for a first build. */
export function VersionBadge({ art }: { art: Artifact }) {
  const [open, setOpen] = useState(false);
  const now = useNow(15_000);
  if (!art.version || art.version < 2) return null;
  return (
    <>
      <button
        className="version-badge"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title="See the earlier versions"
      >
        v{art.version} · {agoWords(art.updatedAt, now)}
      </button>
      {open && <Versions art={art} onClose={() => setOpen(false)} />}
    </>
  );
}

function Versions({ art, onClose }: { art: Artifact; onClose: () => void }) {
  const all = [{ version: art.version ?? 1, at: art.updatedAt, image: art.image, note: art.note }, ...[...(art.versions ?? [])].reverse()];
  const [pick, setPick] = useState(all[0]);
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal-wrap" onClick={onClose}>
        <div className="modal versions-modal" role="dialog" aria-label={`Versions of ${art.title}`} onClick={(e) => e.stopPropagation()}>
          <div className="row between">
            <b className="versions-title">{art.title}</b>
            <button className="btn small" onClick={onClose}>
              Done
            </button>
          </div>
          <div className="versions-main">{pick.image ? <img src={pick.image} alt={`${art.title}, version ${pick.version}`} /> : <div className="empty-note">No image for this version.</div>}</div>
          <div className="versions-rail">
            {all.map((v) => (
              <button key={v.version} className={`versions-thumb ${v.version === pick.version ? "on" : ""}`} onClick={() => setPick(v)}>
                {v.image && <img src={v.image} alt="" />}
                <span>
                  v{v.version}
                  {v.version === art.version ? " · newest" : ""}
                </span>
                <span className="versions-when">{agoWords(v.at)}</span>
              </button>
            ))}
          </div>
          {pick.note && <div className="versions-note">{pick.note}</div>}
        </div>
      </div>
    </>,
    document.body,
  );
}

/** Mounted with the host's build requests: the question to a lock's owner, on the big screen and in the owner's own window. */
export function useShowAsks(big?: boolean) {
  const { state } = useHub();
  const me = pref("personId");
  return (state?.showRequests ?? []).filter((r) => r.status === "pending" && (big || (r.ownerId && r.ownerId === me)));
}
