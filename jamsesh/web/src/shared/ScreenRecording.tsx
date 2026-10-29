// On the big screen itself while someone is recording it (6.2): each recording driver's dart leaves
// a rainbow trail that fades behind it, and a small chip says who is recording.
import { useEffect, useRef } from "react";
import type { ActiveRecording } from "../../../hub/src/types";
import { drive } from "./drive";
import type { HubState } from "./hub";
import { RainbowTrail, type TrailFeed } from "./trail";

function DriverTrail({ rec, screen }: { rec: ActiveRecording; screen: string }) {
  const feed = useRef<TrailFeed>({ push: null });
  const box = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      drive.get()?.onDart((s, sc) => {
        if (sc !== screen || s.driverId !== rec.personId) return;
        const r = box.current?.getBoundingClientRect();
        if (r) feed.current.push?.(s.sx * r.width, s.sy * r.height);
      }),
    [rec.personId, screen],
  );
  return (
    <div ref={box} className="rec-screen-lane">
      <RainbowTrail feed={feed} fixed={false} head={false} />
    </div>
  );
}

export function ScreenRecording({ state, screen }: { state: Pick<HubState, "recordings">; screen: string }) {
  const recs = (state.recordings ?? []).filter((r) => r.screenId === screen);
  if (!recs.length) return null;
  const names = recs.map((r) => r.personName);
  return (
    <div className="rec-screen" aria-hidden="true">
      {recs.map((r) => (
        <DriverTrail key={r.deviceId} rec={r} screen={screen} />
      ))}
      <span className="rec-screen-chip">
        <i />
        Recording · {names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]}
      </span>
    </div>
  );
}
