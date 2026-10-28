// Learns which host this is before anything reads the saved identity (some modules read it as they
// load), then starts the app. Offline, the last host seen at this address stands in.
import { setHostKey } from "./shared/identity";

const remembered = `jamsesh.lastHost::${location.origin}`;

async function hostId(): Promise<string> {
  try {
    const r = await fetch("/api/pair/info", { signal: AbortSignal.timeout(2500) });
    const id = String((await r.json()).hostId ?? "");
    if (id) {
      try {
        localStorage.setItem(remembered, id);
      } catch {}
    }
    return id;
  } catch {
    try {
      return localStorage.getItem(remembered) ?? "";
    } catch {
      return "";
    }
  }
}

setHostKey(await hostId());
await import("./main");
