import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClientView } from "./client/ClientView";
import { HostView } from "./host/HostView";
import { ConnectView } from "./connect/ConnectView";
import { SetupView } from "./setup/SetupView";
import { deviceId, hub } from "./shared/hub";
import "./styles.css";
import { tileSlots } from "./host/Stage";
import { ShareTile } from "./shared/share";
import { PinLayer, useAnnotateMode, type PinTarget } from "./shared/annotate";
import { pref } from "./shared/hub";
import { registerServiceWorker } from "./shared/offline";
import { ConnectionBanner } from "./shared/ConnectionBanner";
import { BuildRequests } from "./shared/BuildRequests";

function PinSlot({ target }: { target: PinTarget }) {
  const mode = useAnnotateMode();
  return <PinLayer target={target} personId={pref("personId")} enabled={mode.on} />;
}

tileSlots.screen = (share) => <ShareTile share={share} />;
tileSlots.render = (target) => <PinSlot target={target as PinTarget} />;

const isHost = location.pathname.startsWith("/host");
const isConnect = location.pathname.startsWith("/connect");
const isSetup = location.pathname.startsWith("/setup");
if (!isConnect && !isSetup) hub.start(deviceId(isHost ? "host" : "client"));

registerServiceWorker();

// Inside the Mac app the window has no title bar: the header holds the window controls and drags
// the window.
if ("__TAURI_INTERNALS__" in window) {
  document.documentElement.classList.add("in-app");
  new MutationObserver(() => document.querySelectorAll(".app-header:not([data-tauri-drag-region])").forEach((h) => h.setAttribute("data-tauri-drag-region", ""))).observe(document.body, { childList: true, subtree: true });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isConnect ? <ConnectView /> : isSetup ? <SetupView /> : isHost ? <HostView /> : <ClientView />}
    {!isConnect && !isSetup && <ConnectionBanner />}
    {!isConnect && !isSetup && <BuildRequests big={isHost} />}
  </StrictMode>,
);
