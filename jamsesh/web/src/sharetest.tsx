import { createRoot } from "react-dom/client";
import { api, deviceId, hub, useHub } from "./shared/hub";
import { PhotoAvatar, ProfilePhoto, ShareControls, ShareRequestPrompt, ShareTile } from "./shared/share";
import "./styles.css";

const q = new URLSearchParams(location.search);
const personId = q.get("person") ?? "";
hub.start(deviceId("client"));
(window as any).hub = hub;
api("/devices", { deviceId: hub.deviceId, personId, label: q.get("label") ?? "test", kind: "client" });

function App() {
  const { state } = useHub();
  const me = state?.people.find((p) => p.id === personId);
  const others = (state?.shares ?? []).filter((s) => s.status === "live" && s.deviceId !== hub.deviceId);
  return (
    <div style={{ padding: 16, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        {me && <PhotoAvatar person={me} size={36} />}
        <ShareControls personId={personId} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: 12 }}>
        {others.map((s) => (
          <div key={s.id} style={{ position: "relative", aspectRatio: "16/10", borderRadius: 14, overflow: "hidden" }}>
            <ShareTile share={s} />
          </div>
        ))}
      </div>
      {q.has("photo") && me && <ProfilePhoto person={me} onDone={() => console.log("photo done")} />}
      <ShareRequestPrompt />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
