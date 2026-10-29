import "fake-indexeddb/auto";
import { expect, test } from "bun:test";

(globalThis as any).location ??= { origin: "http://127.0.0.1:4790", pathname: "/client", search: "" };
(globalThis as any).navigator ??= {};
Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });

function fakeStream() {
  const handlers: (() => void)[] = [];
  const track = { kind: "video", stopped: false, addEventListener: (_: string, fn: () => void) => void handlers.push(fn), stop: () => void (track.stopped = true) };
  return { stream: { getTracks: () => [track], getVideoTracks: () => [track] }, track, end: () => handlers.forEach((fn) => fn()) };
}

test("ending the track after registration renamed the share stops the renamed share on the hub", async () => {
  const fake = fakeStream();
  const media = (globalThis.navigator as any).mediaDevices;
  Object.defineProperty(globalThis.navigator, "mediaDevices", { value: { getUserMedia: async () => fake.stream, getDisplayMedia: async () => fake.stream }, configurable: true });
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => (calls.push(`${init.method ?? "GET"} ${url}`), new Response("{}"))) as any;
  try {
    const rtc = await import("../src/shared/rtc");
    const pub = await rtc.publish("camera", "sh-temp");
    rtc.renamePublication("sh-temp", "sh-final");
    expect(rtc.localPublication("sh-final")).toBe(pub as any);
    fake.end();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toContain("DELETE /api/shares/sh-final");
    expect(calls.some((c) => c.includes("sh-temp"))).toBe(false);
    expect(fake.track.stopped).toBe(true);
    expect(rtc.activePublication("camera")).toBeUndefined();
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(globalThis.navigator, "mediaDevices", { value: media, configurable: true });
  }
});
