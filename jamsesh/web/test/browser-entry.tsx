// Bundled for the browser test in silent.test.tsx: mounts the room's HTML frame and lets the test flip the room's silent flag.
import { createRoot } from "react-dom/client";
import { hub } from "../src/shared/hub";
import { HtmlFrame } from "../src/shared/htmlframe";

const set = (silent: boolean) => (hub as any).set({ state: { session: { silent, canvas: { status: "starting", reason: "" } }, devservers: [] } });
(window as any).setSilent = set;
set(false);
const doc = (window as any).__doc as string;
createRoot(document.getElementById("root")!).render(<HtmlFrame doc={doc} title="Tile" style={{ width: 400, height: 300, border: 0 }} />);
