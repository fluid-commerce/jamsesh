import { createRoot } from "react-dom/client";
import "../../src/styles.css";
import { ConnectionBanner } from "../../src/shared/ConnectionBanner";
import { api, hub, deviceId, useHub } from "../../src/shared/hub";
import { audioBuffer, Mic } from "../../src/shared/mic";
import { outbox, registerServiceWorker, useOutbox } from "../../src/shared/offline";

hub.autoRedirect = false;
hub.start(deviceId("client"));
registerServiceWorker();
const mic = new Mic(deviceId("client"));
Object.assign(window, { __t: { api, hub, outbox, audioBuffer, mic } });

function App() {
  const h = useHub();
  const ob = useOutbox();
  return (
    <div style={{ padding: 24 }}>
      <header style={{ display: "flex", gap: 12, alignItems: "center", height: 48 }}>
        <b>JamSesh harness</b>
        <button id="hdr-btn">Header control</button>
        <span id="status">{h.status}</span>
        <span id="pending">{ob.pending}</span>
        <span id="events">{h.state?.events.length ?? -1}</span>
      </header>
      <pre id="state">{h.state ? `${h.state.utterances.length} utterances` : "no state"}</pre>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<><App /><ConnectionBanner /></>);
