import "fake-indexeddb/auto";
import { expect, test } from "bun:test";

// Each page boots once with one host id, so this runs as a fresh page: in its own process.
if (!process.env.JAM_FIRST_HOST_PAGE) {
  test("an offline first visit confirms the host the hub names once it answers, and the outbox sends", () => {
    const r = Bun.spawnSync([process.execPath, "test", import.meta.path], { env: { ...process.env, JAM_FIRST_HOST_PAGE: "1" }, cwd: import.meta.dir + "/.." });
    const out = r.stdout.toString() + r.stderr.toString();
    expect(out).toContain("1 pass");
    expect(r.exitCode).toBe(0);
  }, 60_000);
} else {
  // A first visit while the hub was unreachable: boot found no host id, live or remembered.
  const store = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  (globalThis as any).location ??= { origin: "http://127.0.0.1:4790", pathname: "/client", search: "" };
  (globalThis as any).navigator ??= {};
  Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });

  test("an offline first visit confirms the host the hub names once it answers, and the outbox sends", async () => {
    const id = await import("../src/shared/identity");
    expect(id.currentHostKey()).toBe("");
    const o = location.origin;
    id.setHostKey("", false);
    store.set(`jamsesh.identity::${o}`, JSON.stringify({ name: "Rae" })); // typed while offline
    expect(id.isHostConfirmed()).toBe(false);
    const realFetch = globalThis.fetch;
    const sent: string[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      if (url === "/api/pair/info") return Response.json({ hostId: "host-1" });
      sent.push(`${init.method} ${url} ${(init.headers as any)?.["x-jam-host"] ?? ""}`);
      return Response.json({ ok: true });
    }) as any;
    try {
      const { hostVerified, outbox } = await import("../src/shared/offline");
      await outbox.enqueue("POST", "/say", { text: "hello" }, "idem-1");
      expect(await hostVerified()).toBe(true);
      expect(id.currentHostKey()).toBe("host-1");
      // A different id later is still another host, never adopted.
      expect(id.confirmHostKey("host-2")).toBe(true);
      expect(id.currentHostKey()).toBe("host-1");
      // What they typed offline moved to this host's record; the next boot starts from this host.
      expect(id.getIdentity().name).toBe("Rae");
      expect(store.get(`jamsesh.lastHost::${o}`)).toBe("host-1");
      await outbox.kick();
      await new Promise((r) => setTimeout(r, 30));
      expect(sent.some((l) => l.startsWith("POST /api/say"))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}
