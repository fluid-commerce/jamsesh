// Learns which host this is before anything reads the saved identity (some modules read it as they
// load), then starts the app. Offline, the last host seen at this address stands in.
import { setHostKey } from "./shared/identity";

const remembered = `jamsesh.lastHost::${location.origin}`;

async function hostId(): Promise<{ id: string; confirmed: boolean }> {
  try {
    const r = await fetch("/api/pair/info", { signal: AbortSignal.timeout(2500) });
    const id = String((await r.json()).hostId ?? "");
    if (id) {
      try {
        localStorage.setItem(remembered, id);
      } catch {}
    }
    if (id) return { id, confirmed: true };
    throw new Error("no host id");
  } catch {
    try {
      return { id: localStorage.getItem(remembered) ?? "", confirmed: false };
    } catch {
      return { id: "", confirmed: false };
    }
  }
}

const host = await hostId();
setHostKey(host.id, host.confirmed);
await import("./main");
