import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClientView } from "./client/ClientView";
import { HostView } from "./host/HostView";
import { deviceId, hub } from "./shared/hub";
import "./styles.css";
import { tileSlots } from "./host/Stage";
import { ShareTile } from "./shared/share";
import { PinLayer, useAnnotateMode, type PinTarget } from "./shared/annotate";
import { pref } from "./shared/hub";

function PinSlot({ target }: { target: PinTarget }) {
  const mode = useAnnotateMode();
  return <PinLayer target={target} personId={pref("personId")} enabled={mode.on} />;
}

tileSlots.screen = (share) => <ShareTile share={share} />;
tileSlots.render = (target) => <PinSlot target={target as PinTarget} />;

const isHost = location.pathname.startsWith("/host");
hub.start(deviceId(isHost ? "host" : "client"));

createRoot(document.getElementById("root")!).render(<StrictMode>{isHost ? <HostView /> : <ClientView />}</StrictMode>);
