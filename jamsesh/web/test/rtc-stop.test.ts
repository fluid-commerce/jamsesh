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

test("a share the host ended stays ended: its capture stops, and a missed end is refused on re-registering", async () => {
  const media = (globalThis.navigator as any).mediaDevices;
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const posts: string[] = [];
  let answer = (_body: any) => new Response(JSON.stringify({ error: "That share was ended." }), { status: 409 });
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (init.method === "POST" && url === "/api/shares") return (posts.push(String(init.body)), answer(JSON.parse(String(init.body))));
    return new Response("{}");
  }) as any;
  try {
    const rtc = await import("../src/shared/rtc");
    const { hub } = await import("../src/shared/hub");
    hub.deviceId = "dev-1";
    const start = async (id: string) => {
      const fake = fakeStream();
      Object.defineProperty(globalThis.navigator, "mediaDevices", { value: { getUserMedia: async () => fake.stream, getDisplayMedia: async () => fake.stream }, configurable: true });
      await rtc.publish("screen", id);
      return fake;
    };
    // The host ends it: the hub tells this window, and the capture stops without another call.
    const told = await start("sh-told");
    for (const fn of hub.messageListeners) fn({ type: "share-ended", shareId: "sh-told", deviceId: "dev-1", text: "The host stopped your screen share." });
    await new Promise((r) => setTimeout(r, 10));
    expect(told.track.stopped).toBe(true);
    expect(rtc.localPublication("sh-told")).toBeUndefined();
    // The end was missed (this window was offline): past the 10-second re-registration wait, the hub refuses it.
    const missed = await start("sh-missed");
    (hub as any).snap = { ...hub.get(), connected: true, state: { shares: [] } };
    Date.now = () => realNow() + 11_000;
    await rtc.reregister();
    expect(posts).toHaveLength(1);
    expect(missed.track.stopped).toBe(true);
    expect(rtc.localPublication("sh-missed")).toBeUndefined();
    await rtc.reregister();
    expect(posts).toHaveLength(1); // never again
    // A share lost to a dropped connection is registered again and keeps capturing.
    Date.now = realNow;
    const lost = await start("sh-lost");
    answer = (b) => Response.json({ id: "sh-lost-2", kind: b.kind, status: "live" });
    Date.now = () => realNow() + 11_000;
    await rtc.reregister();
    expect(lost.track.stopped).toBe(false);
    expect(rtc.localPublication("sh-lost-2")).toBeTruthy();
    await rtc.stopPublishing("sh-lost-2", { notifyHub: false });
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
    Object.defineProperty(globalThis.navigator, "mediaDevices", { value: media, configurable: true });
  }
});

test("two starts while the picker is open share one capture, and Stop releases every track", async () => {
  const media = (globalThis.navigator as any).mediaDevices;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}")) as any;
  const streams: ReturnType<typeof fakeStream>[] = [];
  let pick!: () => void;
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    value: {
      getDisplayMedia: () => {
        const fake = fakeStream();
        streams.push(fake);
        return new Promise((r) => (pick = () => r(fake.stream)));
      },
    },
    configurable: true,
  });
  try {
    const rtc = await import("../src/shared/rtc");
    const first = rtc.publish("screen", "sh-req-a");
    const second = rtc.publish("screen", "sh-req-b");
    await Bun.sleep(5);
    expect(streams).toHaveLength(1); // one picker
    pick();
    const [a, b] = await Promise.all([first, second]);
    expect(b).toBe(a);
    await rtc.stopPublishing(a.shareId);
    expect(streams.every((s) => s.track.stopped)).toBe(true);
    expect(rtc.activePublication("screen")).toBeUndefined();
    // Once the first is done, a new start opens the picker again.
    const third = rtc.publish("screen", "sh-req-c");
    await Bun.sleep(5);
    expect(streams).toHaveLength(2);
    pick();
    await rtc.stopPublishing((await third).shareId);
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(globalThis.navigator, "mediaDevices", { value: media, configurable: true });
  }
});

test("stopping a share while the hub is still registering it ends the share the hub then creates", async () => {
  const fake = fakeStream();
  const media = (globalThis.navigator as any).mediaDevices;
  Object.defineProperty(globalThis.navigator, "mediaDevices", { value: { getUserMedia: async () => fake.stream, getDisplayMedia: async () => fake.stream }, configurable: true });
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  let answer!: () => void;
  const held = new Promise<void>((r) => (answer = r));
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    if (init.method === "POST" && url.endsWith("/api/shares")) {
      await held;
      return new Response(JSON.stringify({ id: "sh-made", kind: "camera", status: "live" }));
    }
    return new Response("{}");
  }) as any;
  try {
    const { startShareForTest } = await import("../src/shared/share");
    const started = startShareForTest("camera");
    await new Promise((r) => setTimeout(r, 20));
    fake.end(); // the browser's Stop sharing, before the hub has answered
    await new Promise((r) => setTimeout(r, 20));
    answer();
    await expect(started).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toContain("DELETE /api/shares/sh-made");
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(globalThis.navigator, "mediaDevices", { value: media, configurable: true });
  }
});

test("a share registration whose reply was lost is cancelled by its attempt's own id, so it is ended whether or not it has arrived", async () => {
  const fake = fakeStream();
  const media = (globalThis.navigator as any).mediaDevices;
  Object.defineProperty(globalThis.navigator, "mediaDevices", { value: { getUserMedia: async () => fake.stream, getDisplayMedia: async () => fake.stream }, configurable: true });
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  let sentId = "";
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    if (init.method === "POST" && url.endsWith("/api/shares")) {
      sentId = JSON.parse(String(init.body)).clientId; // the hub got it (or will), under this attempt's own id; the answer never arrived
      throw new Error("reply lost");
    }
    return new Response("{}");
  }) as any;
  try {
    const { startShareForTest } = await import("../src/shared/share");
    await expect(startShareForTest("camera")).rejects.toThrow();
    expect(sentId.startsWith("cap-")).toBe(true);
    expect(calls).toContain(`DELETE /api/shares/${sentId}`);
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(globalThis.navigator, "mediaDevices", { value: media, configurable: true });
  }
});

test("the cancel for an accepted request's attempt is retried when it fails", async () => {
  const fake = fakeStream();
  const media = (globalThis.navigator as any).mediaDevices;
  Object.defineProperty(globalThis.navigator, "mediaDevices", { value: { getUserMedia: async () => fake.stream, getDisplayMedia: async () => fake.stream }, configurable: true });
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  let sentId = "";
  let cancels = 0;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    if (init.method === "POST" && url.endsWith("/api/shares")) {
      const b = JSON.parse(String(init.body));
      expect(b.shareId).toBe("sh-request"); // answering a request the hub already knows
      sentId = b.clientId;
      throw new Error("reply lost");
    }
    if (init.method === "DELETE" && url.includes("/api/shares/cap-") && ++cancels === 1) throw new Error("first cancel lost");
    return new Response("{}");
  }) as any;
  try {
    const { startShareForTest } = await import("../src/shared/share");
    await expect(startShareForTest("camera", "sh-request")).rejects.toThrow();
    expect(cancels).toBe(2);
    expect(calls).toContain(`DELETE /api/shares/${sentId}`);
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(globalThis.navigator, "mediaDevices", { value: media, configurable: true });
  }
});

test("a cancel the hub never acknowledged is sent again when the connection comes back", async () => {
  const fake = fakeStream();
  const media = (globalThis.navigator as any).mediaDevices;
  Object.defineProperty(globalThis.navigator, "mediaDevices", { value: { getUserMedia: async () => fake.stream, getDisplayMedia: async () => fake.stream }, configurable: true });
  const realFetch = globalThis.fetch;
  const { hub } = await import("../src/shared/hub");
  let cancels = 0;
  let acknowledge = false;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (init.method === "POST" && url.endsWith("/api/shares")) throw new Error("reply lost");
    if (init.method === "DELETE" && url.includes("/api/shares/cap-")) {
      cancels++;
      if (!acknowledge) throw new Error("down");
    }
    return new Response("{}");
  }) as any;
  try {
    const { startShareForTest } = await import("../src/shared/share");
    await expect(startShareForTest("camera")).rejects.toThrow();
    const afterQuickTries = cancels;
    expect(afterQuickTries).toBe(4); // a few quick tries, all lost
    acknowledge = true;
    for (const fn of (hub as any).reconnectListeners) fn(); // the connection is back
    await new Promise((r) => setTimeout(r, 30));
    expect(cancels).toBe(afterQuickTries + 1);
    for (const fn of (hub as any).reconnectListeners) fn(); // acknowledged: not sent again
    await new Promise((r) => setTimeout(r, 30));
    expect(cancels).toBe(afterQuickTries + 1);
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(globalThis.navigator, "mediaDevices", { value: media, configurable: true });
  }
}, 20_000);
