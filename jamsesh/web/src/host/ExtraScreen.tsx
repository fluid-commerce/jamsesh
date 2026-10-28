// One more big screen on a user-less host: a display that only presents. No header, room mic, or
// side panels (the main screen has those); the brain decides what each screen shows.
import { useEffect } from "react";
import { api, hub, useHub } from "../shared/hub";
import { Stage } from "./Stage";

export function ExtraScreen({ id }: { id: string }) {
  const { state } = useHub();

  // Tell the brain this screen's size and shape, as the main screen does.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const report = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void api("/display", { screen: id, width: innerWidth, height: innerHeight, dpr: devicePixelRatio, screenX: screenX + 1, screenY: screenY + 1 }).catch(() => {}), 400);
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
  }, [id]);

  if (!state) return <div className="extra-screen" />;
  const stage = state.screens?.find((sc) => sc.id === id)?.stage ?? { ...state.stage, mode: "board" as const, title: "", items: [] };
  return (
    <div className="extra-screen">
      <Stage state={{ ...state, stage }} />
    </div>
  );
}
