// "Put on screen": with two or more big screens, a cast asks which one first, with a live thumbnail
// of what each shows. With one screen nothing changes: the cast goes straight to it.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Stage } from "../host/Stage";
import { api, hub, useHub, type HubState, type ScreenInfo, type Stage as StageState } from "../shared/hub";

type Request = { stage: Partial<StageState> & { mode: StageState["mode"] }; done: (picked: boolean) => void };
let ask: ((r: Request) => void) | null = null;

/** Puts something on a big screen: the picker opens when there is a choice, otherwise it just goes. Resolves with whether it was put up. */
export async function cast(stage: Request["stage"]): Promise<boolean> {
  const screens = hub.get().state?.screens ?? [];
  if (screens.length < 2 || !ask) {
    await api("/stage", stage);
    return true;
  }
  return new Promise((done) => ask?.({ stage, done }));
}

/** What a screen shows, drawn at that screen's own size and shrunk to fit, live. */
export function ScreenThumb({ state, screen }: { state: HubState; screen: ScreenInfo }) {
  const box = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(0.2);
  const w = screen.width || 1920;
  const h = screen.height || 1080;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setK(el.clientWidth / w);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w]);
  return (
    <div ref={box} className="cast-thumb" style={{ aspectRatio: `${w} / ${h}` }} aria-hidden>
      <div className="cast-thumb-inner" style={{ width: w, height: h, transform: `scale(${k})` }} inert>
        <div className="in-thumb">
          <Stage state={{ ...state, stage: screen.stage }} tilePins={false} />
        </div>
      </div>
    </div>
  );
}

export function CastPicker({ state }: { state: HubState }) {
  const [req, setReq] = useState<Request | null>(null);
  useEffect(() => {
    ask = (r) => setReq((old) => (old?.done(false), r));
    return () => void (ask = null);
  }, []);
  useEffect(() => {
    if (!req) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && close(false);
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  });
  if (!req) return null;
  const close = (picked: boolean) => {
    req.done(picked);
    setReq(null);
  };
  const screens = state.screens ?? [];
  const put = (sc: ScreenInfo) => {
    void api("/stage", { ...req.stage, screen: sc.id });
    close(true);
  };
  return (
    <>
      <div className="scrim cast-scrim" onClick={() => close(false)} />
      <div className="modal-wrap cast-wrap">
        <div className="modal cast-modal" role="dialog" aria-label="Put on screen">
          <h2 className="cast-title">Put on screen</h2>
          <div className="cast-grid">
            {screens.map((sc) => (
              <button key={sc.id} className="cast-card" onClick={() => put(sc)} aria-label={`Put on ${sc.name}`}>
                <ScreenThumb state={state} screen={sc} />
                <span className="cast-name ellipsis">{sc.name}</span>
                <span className="cast-now ellipsis">{sc.stage.mode === "board" || sc.stage.mode === "welcome" ? "Showing the board" : `Showing ${sc.stage.title || sc.stage.mode}`}</span>
              </button>
            ))}
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn ghost small" onClick={() => close(false)}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/** Mounted once in people's apps (not on a big screen). */
export function CastHost() {
  const { state } = useHub();
  return state ? <CastPicker state={state} /> : null;
}
