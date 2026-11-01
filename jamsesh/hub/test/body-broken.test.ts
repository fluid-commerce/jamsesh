// A body that breaks off is a request that did not arrive whole (retryable), never "too large".
import { expect, test } from "bun:test";
import { BODY_LIMITS, buffered, readBytes } from "../src/body";

const broken = () => new Request("http://x/api/say", { method: "POST", headers: { "content-type": "application/json" }, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{\"a\":")); c.error(new Error("reset")); } }), duplex: "half" } as any);

test("a stream that breaks off is 408, not 413", async () => {
  expect(await readBytes(broken(), 1000)).toBe("timeout");
  const r = await buffered(broken());
  expect("status" in r && r.status).toBe(408);
});

test("a body over the cap is still 413", async () => {
  const big = new Request("http://x/api/say", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(BODY_LIMITS.json + 10) });
  const r = await buffered(big);
  expect("status" in r && r.status).toBe(413);
});
