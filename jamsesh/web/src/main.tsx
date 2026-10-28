import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClientView } from "./client/ClientView";
import { HostView } from "./host/HostView";
import { deviceId, hub } from "./shared/hub";
import "./styles.css";

const isHost = location.pathname.startsWith("/host");
hub.start(deviceId(isHost ? "host" : "client"));

createRoot(document.getElementById("root")!).render(<StrictMode>{isHost ? <HostView /> : <ClientView />}</StrictMode>);
