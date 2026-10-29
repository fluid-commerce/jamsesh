// Beside the lock badge: start driving the screen you hold, hand it to someone, or drive together (SPEC 10.6).
import { useState } from "react";
import { driveTogether, driverState, passControl, startDriving, stopDriving } from "./driving";
import { pref, type HubState } from "./hub";

export function DriveControls({ state, screen }: { state: HubState; screen: string }) {
  const me = pref("personId");
  const ds = driverState(screen, state, me);
  const [menu, setMenu] = useState<"pass" | "together" | null>(null);
  const [note, setNote] = useState("");
  if (!me) return null;
  const run = async (f: () => Promise<unknown>) => {
    setNote("");
    try {
      await f();
      setMenu(null);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "That didn't work.");
    }
  };
  const others = state.people.filter((p) => p.id !== me);
  const names = ds.drivers.filter((d) => d.id !== me).map((d) => d.name);
  return (
    <span className="drive-controls">
      {ds.me.driving ? (
        <>
          <span className="drive-who">{ds.me.isOwner ? "You're driving" : `${ds.owner?.name ?? "The owner"} passed you control`}</span>
          <button className="btn small" onClick={() => run(() => stopDriving(screen))}>
            Stop driving
          </button>
        </>
      ) : ds.me.isOwner ? (
        <button className="btn small primary" onClick={() => run(() => startDriving(screen))} title="Use this window's trackpad as your own cursor on the big screen">
          Drive
        </button>
      ) : null}
      {ds.me.isOwner && (
        <>
          <button className={`btn small ${menu === "pass" ? "primary" : ""}`} onClick={() => setMenu(menu === "pass" ? null : "pass")} aria-expanded={menu === "pass"} disabled={!others.length}>
            Pass control
          </button>
          <button className={`btn small ${menu === "together" ? "primary" : ""}`} onClick={() => setMenu(menu === "together" ? null : "together")} aria-expanded={menu === "together"} disabled={!others.length}>
            Drive together
          </button>
        </>
      )}
      {menu && (
        <span className="drive-menu" role="menu">
          {others.map((p) => (
            <button key={p.id} role="menuitem" className="btn small" onClick={() => run(() => (menu === "pass" ? passControl(p.id, screen) : driveTogether(p.id, screen)))}>
              {p.name}
            </button>
          ))}
        </span>
      )}
      {names.length > 0 && !ds.me.driving && <span className="drive-who">{names.join(" and ")} {names.length > 1 ? "are" : "is"} driving</span>}
      {names.length > 0 && ds.me.driving && <span className="drive-who">with {names.join(" and ")}</span>}
      {note && (
        <span className="drive-note" role="alert">
          {note}
        </span>
      )}
    </span>
  );
}
