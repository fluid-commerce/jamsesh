// Run in its own process: a confirmed page whose relay later reaches another host reloads instead of staying on the old identity.
import "fake-indexeddb/auto";

(globalThis as any).location = { origin: "http://127.0.0.1:4790", pathname: "/client", search: "", reload: () => void ((globalThis as any).__reloads = ((globalThis as any).__reloads ?? 0) + 1) };
(globalThis as any).sessionStorage = { store: new Map<string, string>(), getItem(k: string) { return this.store.get(k) ?? null; }, setItem(k: string, v: string) { this.store.set(k, v); } };
(globalThis as any).navigator ??= {};
Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });

const { setHostKey } = await import("../../src/shared/identity");
setHostKey("hostA", true);
const { recheckHost } = await import("../../src/shared/offline");
let host = "hostA";
globalThis.fetch = (async () => Response.json({ hostId: host })) as any;
const same = await recheckHost();
host = "hostB";
const moved = await recheckHost();
const movedAgain = await recheckHost(); // the same destination again within seconds: not reloaded twice
host = "hostC";
const third = await recheckHost(); // a different destination: reloads
console.log(JSON.stringify({ same, moved, movedAgain, third, reloads: (globalThis as any).__reloads ?? 0 }));
process.exit(0);
