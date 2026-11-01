// Run in its own process (the host id is set once per page): a page whose host id came from memory sends nothing until the hub names the host, and queues instead.
import "fake-indexeddb/auto";

(globalThis as any).location = { origin: "http://127.0.0.1:4790", pathname: "/client", search: "", reload: () => void ((globalThis as any).__reloads = ((globalThis as any).__reloads ?? 0) + 1) };
(globalThis as any).sessionStorage = { store: new Map<string, string>(), getItem(k: string) { return this.store.get(k) ?? null; }, setItem(k: string, v: string) { this.store.set(k, v); } };
(globalThis as any).navigator ??= {};
Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });

const { setHostKey } = await import("../../src/shared/identity");
setHostKey("hostA", false); // remembered, not confirmed: the hub did not answer at boot
const { api } = await import("../../src/shared/hub");
const { outbox } = await import("../../src/shared/offline");
const sent: string[] = [];
globalThis.fetch = (async (url: string) => {
  if (url === "/api/pair/info") return Response.json({ hostId: "hostB" }); // the relay now reaches another host
  sent.push(url);
  return Response.json({ ok: true });
}) as any;
const r: any = await api("/annotations", { text: "move the logo" }, "POST");
outbox.stop();
console.log(JSON.stringify({ queued: r.queued === true, sentToHub: sent, reloads: (globalThis as any).__reloads ?? 0 }));
process.exit(0);
