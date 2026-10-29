// A change whose body didn't reach the host whole comes back 408 and nothing ran there. Sent straight away, it goes
// into the outbox with its idempotency key; the outbox then sends it again with that same key. fetch stubbed.
import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";
import { api } from "../src/shared/hub";
import { idbTable, outbox } from "../src/shared/offline";

const realFetch = globalThis.fetch;
// The host check (pair/info) is another test's business: here the host is taken as the right one, so nothing about
// which host this window shows is changed for later tests.
const deps = (outbox as any).d;
const realCanSend = deps.canSend;
afterEach(async () => {
  globalThis.fetch = realFetch;
  deps.canSend = realCanSend;
  outbox.stop();
  await idbTable("outbox").clear();
  (outbox as any).entries = [];
  (outbox as any).publish();
});

test("a first send answered 408 is kept in the outbox and resent with the same key; a 400 is a real refusal", async () => {
  deps.canSend = async () => true;
  await outbox.load();
  const sent: { path: string; idem: string | null }[] = [];
  let answer = 408;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const path = String(url);
    sent.push({ path, idem: new Headers(init.headers).get("x-jam-idem") });
    return new Response(answer === 200 ? "{}" : '{"error":"x"}', { status: answer });
  }) as any;
  const r = await api<{ queued?: boolean; idem?: string }>("/people/p1", { name: "Ana" }, "PATCH");
  expect(r).toMatchObject({ queued: true });
  expect(outbox.get().items.map((e: any) => e.idem)).toEqual([r.idem]);
  // Saved durably, not only in memory.
  expect((await idbTable<any>("outbox").all()).map((e) => e.idem)).toEqual([r.idem]);
  expect(sent[0].idem).toBe(r.idem!);
  // The outbox's own send: the same key, and once taken, it's gone.
  answer = 200;
  await (outbox as any).flush();
  // However many times the outbox tried (it may have tried on its own already), every send carried the same key.
  const keys = sent.filter((x) => x.path.includes("/people/p1")).map((x) => x.idem);
  expect(keys.length).toBeGreaterThanOrEqual(2);
  expect(new Set(keys)).toEqual(new Set([r.idem!]));
  expect(outbox.get().pending).toBe(0);
  // A real refusal isn't queued.
  answer = 400;
  await expect(api("/people/p1", { name: "Bo" }, "PATCH")).rejects.toThrow();
  expect(outbox.get().pending).toBe(0);
});
