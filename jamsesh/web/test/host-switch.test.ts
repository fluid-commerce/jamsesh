// An edit sent straight to the hub (not queued) that reaches another host after the Mac app's
// relay switched hosts is kept, under its own idempotency key and host, and lands on its host later.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";

(globalThis as any).location ??= { origin: "http://127.0.0.1:4790", pathname: "/client", search: "" };
(globalThis as any).navigator ??= {};
Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });

const { confirmHostKey, currentHostKey, setHostKey } = await import("../src/shared/identity");
const { idbTable, outbox } = await import("../src/shared/offline");
const { api } = await import("../src/shared/hub");

test("a host-switch 409 on a direct call queues it for its own host instead of losing it", async () => {
  // The page's host (other test files in this run may have set it already: it's set once per page).
  setHostKey("hostA");
  const hostA = currentHostKey();
  confirmHostKey(hostA);
  await idbTable("outbox").clear();
  let host = `${hostA}-other`; // the relay already points at another host
  const sent: { path: string; idem: string | null; stamp: string | null }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers);
    if (url === "/api/pair/info") return Response.json({ hostId: host });
    sent.push({ path: url, idem: h.get("x-jam-idem"), stamp: h.get("x-jam-host") });
    if (h.get("x-jam-host") && h.get("x-jam-host") !== host)
      return new Response("That change was made for a different JamSesh host.", { status: 409, headers: { "content-type": "text/plain" } });
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    const r = await api<any>("/annotations", { text: "move the logo" });
    expect(r.queued).toBe(true);
    expect(sent[0].stamp).toBe(hostA);
    expect(r.idem).toBe(sent[0].idem);
    const queued = outbox.get().items;
    expect(queued.map((e) => e.idem)).toEqual([r.idem]);

    // Back on host A: it replays with the same key and stamp, once.
    host = hostA;
    await outbox.kick();
    for (let i = 0; i < 50 && outbox.get().pending; i++) await new Promise((res) => setTimeout(res, 5));
    expect(outbox.get().pending).toBe(0);
    const delivered = sent.filter((x) => x.idem === r.idem);
    expect(delivered.at(-1)).toEqual({ path: "/api/annotations", idem: r.idem, stamp: hostA });
  } finally {
    globalThis.fetch = realFetch;
    outbox.stop();
  }
});
