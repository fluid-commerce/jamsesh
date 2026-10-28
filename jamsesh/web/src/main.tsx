import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClientView } from "./client/ClientView";
import { HostView } from "./host/HostView";
import { ExtraScreen } from "./host/ExtraScreen";
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
import { ErrorBoundary } from "./shared/ErrorBoundary";
import { BuildRequests } from "./shared/BuildRequests";

function PinSlot({ target }: { target: PinTarget }) {
  const mode = useAnnotateMode();
  return <PinLayer target={target} personId={pref("personId")} enabled={mode.on} />;
}

tileSlots.screen = (share) => <ShareTile share={share} />;
tileSlots.render = (target) => <PinSlot target={target as PinTarget} />;

const isHost = location.pathname.startsWith("/host");
// A user-less host's other displays: /host?screen=screen-2 and so on.
const extraScreen = isHost ? new URLSearchParams(location.search).get("screen") : null;
const isConnect = location.pathname.startsWith("/connect");
const isSetup = location.pathname.startsWith("/setup");
if (!isConnect && !isSetup) hub.start(deviceId(extraScreen ? extraScreen : isHost ? "host" : "client"));

registerServiceWorker();

// Inside the Mac app the window has no title bar: the header holds the window controls and drags
// the window.
if ("__TAURI_INTERNALS__" in window) {
  document.documentElement.classList.add("in-app");
  new MutationObserver(() => document.querySelectorAll(".app-header:not([data-tauri-drag-region])").forEach((h) => h.setAttribute("data-tauri-drag-region", ""))).observe(document.body, { childList: true, subtree: true });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      {isConnect ? <ConnectView /> : isSetup ? <SetupView /> : extraScreen ? <ExtraScreen id={extraScreen} /> : isHost ? <HostView /> : <ClientView />}
    </ErrorBoundary>
    {!isConnect && !isSetup && (
      <ErrorBoundary label="The connection banner">
        <ConnectionBanner />
      </ErrorBoundary>
    )}
    {!isConnect && !isSetup && !extraScreen && <BuildRequests big={isHost} />}
  </StrictMode>,
);
