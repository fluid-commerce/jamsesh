// A queued change whose body didn't reach the host whole comes back 408: the outbox keeps it and sends it again
// (with the same key, which the host doesn't remember for a 408), never drops it as refused. fetch stubbed.
import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";
import { sendEntry, type OutboxEntry } from "../src/shared/offline";

const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

test("an incomplete-body answer (408) is retried; a real refusal (400) is dropped", async () => {
  const entry = { idem: "k1", method: "DELETE", path: "/people/p1/voiceprint", body: undefined, createdAt: Date.now() } as unknown as OutboxEntry;
  globalThis.fetch = (async () => new Response('{"error":"The request didn\'t arrive whole. Try again."}', { status: 408 })) as any;
  expect(await sendEntry(entry)).toMatchObject({ kind: "retry" });
  globalThis.fetch = (async () => new Response('{"error":"bad"}', { status: 400 })) as any;
  expect(await sendEntry(entry)).toMatchObject({ kind: "drop", status: 400 });
});
