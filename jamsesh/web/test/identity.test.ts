import { describe, expect, test } from "bun:test";

describe("legacy identity migration", () => {
  test("is recorded even when the scoped identity already exists, so a second host can't claim it", async () => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    (globalThis as any).location = { origin: "http://127.0.0.1:4790" };
    const o = "http://127.0.0.1:4790";
    store.set(`jamsesh.identity::${o}`, '{"name":"legacy"}');
    store.set(`jamsesh.identity::${o}#A`, '{"name":"scoped"}');
    const id = await import("../src/shared/identity");
    id.setHostKey("A");
    expect(store.get(`jamsesh.identityMoved::${o}`)).toBe("A");
    expect(store.get(`jamsesh.identity::${o}#A`)).toBe('{"name":"scoped"}');
  });
});
