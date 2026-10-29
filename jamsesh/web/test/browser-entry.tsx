// Bundled for the browser test in silent.test.tsx: mounts the room's HTML frames (the shared frame and the stage's HTML tile) and lets the test flip the room's silent flag.
import { createRoot } from "react-dom/client";
import { HtmlTile } from "../src/host/Stage";
import { hub } from "../src/shared/hub";
import { HtmlFrame } from "../src/shared/htmlframe";

const set = (silent: boolean) => (hub as any).set({ state: { session: { silent, canvas: { status: "starting", reason: "" } }, devservers: [] } });
(window as any).setSilent = set;
set(false);
const doc = (window as any).__doc as string;
const which = (window as any).__which as string;
createRoot(document.getElementById("root")!).render(
  which === "tile" ? (
    <div style={{ position: "relative", width: 400, height: 300 }}>
      <HtmlTile html={doc} title="Tile" />
    </div>
  ) : (
    <HtmlFrame doc={`<!doctype html>${doc}`} title="Tile" style={{ width: 400, height: 300, border: 0 }} />
  ),
);
