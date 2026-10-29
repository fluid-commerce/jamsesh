// The big screen posts a driver's events into a build's frame with the session's frame key, to the frame's exact origin.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";

(globalThis as any).location ??= { origin: "http://127.0.0.1:4790", pathname: "/host", search: "" };
(globalThis as any).navigator ??= { onLine: true };
const { frameDriver, keepFrameCurrent, refreshFrameKey } = await import("../src/shared/drivetiles");

test("a frame gets events only once the key is in hand, to its own origin, with the key; a failed ask is made again", async () => {
  const asked: string[] = [];
  let answer: () => Response = () => new Response("no", { status: 500 });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (url === "/api/pair/info") return Response.json({ hostId: "h" });
    asked.push(url);
    return answer();
  }) as typeof fetch;
  try {
    const posted: [unknown, string][] = [];
    const iframe = { src: "http://localhost:5173/app?x=1", contentWindow: { postMessage: (m: unknown, o: string) => posted.push([m, o]) } } as any;
    const drive = frameDriver(iframe);
    const move = { k: "move" as const, lx: 0.25, ly: 0.5 };
    drive(move, "p1");
    await Bun.sleep(5);
    expect(posted).toEqual([]);
    // The ask failed: the next event asks again, and once the key arrives events go out.
    answer = () => Response.json({ key: "secret" });
    drive(move, "p1");
    await Bun.sleep(5);
    drive(move, "p1");
    drive({ k: "key", key: "a", down: true }, "p1");
    expect(asked).toEqual(["/api/drive/frame-key", "/api/drive/frame-key"]);
    expect(posted).toEqual([
      [{ jamDrive: { k: "move", lx: 0.25, ly: 0.5, x: 0.25, y: 0.5 }, key: "secret", who: "p1" }, "http://localhost:5173"],
      [{ jamDrive: { k: "key", key: "a", down: true }, key: "secret", who: "p1" }, "http://localhost:5173"],
    ]);
    // A frame whose address isn't a URL gets nothing (never posted to "*").
    const bad = { src: "", contentWindow: { postMessage: () => posted.push(["bad", "*"]) } } as any;
    frameDriver(bad)(move, "p1");
    expect(posted.length).toBe(2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("after a hub restart a reconnect asks for the key whether or not one was fetched, and tells the caller what it got", async () => {
  let key = "secret";
  let up = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (url === "/api/pair/info") return Response.json({ hostId: "h" });
    return up ? Response.json({ key }) : new Response("no", { status: 502 });
  }) as typeof fetch;
  try {
    const posted: any[] = [];
    const iframe = { src: "http://localhost:5173/app", contentWindow: { postMessage: (m: unknown) => posted.push(m) } } as any;
    const drive = frameDriver(iframe);
    const move = { k: "move" as const, lx: 0.1, ly: 0.2 };
    // The exact case of a build nobody has driven yet: no event has fetched a key, and the ask still happens and returns it.
    expect(await refreshFrameKey()).toBe("secret");
    drive(move, "p1");
    expect(posted.at(-1).key).toBe("secret");
    // The connection came back to the same hub: same key, so the caller leaves the frame alone.
    expect(await refreshFrameKey()).toBe("secret");
    // A new hub, a new key: events carry it and the caller sees it differ.
    key = "two";
    expect(await refreshFrameKey()).toBe("two");
    drive(move, "p1");
    expect(posted.at(-1).key).toBe("two");
    // The hub isn't answering yet: null (the caller reloads), and the next event asks again rather than sending a stale key.
    up = false;
    expect(await refreshFrameKey()).toBeNull();
    const n = posted.length;
    drive(move, "p1");
    await Bun.sleep(5);
    expect(posted.length).toBe(n);
    up = true;
    key = "three";
    drive(move, "p1");
    await Bun.sleep(5);
    drive(move, "p1");
    expect(posted.at(-1).key).toBe("three");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a frame loaded before any driving is reloaded when the hub restarted, and left alone when it didn't", async () => {
  let key: string | null = "one";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (url === "/api/pair/info") return Response.json({ hostId: "h" });
    return key ? Response.json({ key }) : new Response("no", { status: 502 });
  }) as typeof fetch;
  try {
    let reconnect: () => void = () => {};
    let reloads = 0;
    // The frame is mounted and nothing has been driven: no event has fetched a key.
    const stop = keepFrameCurrent(() => reloads++, (fn) => ((reconnect = fn), () => {}));
    await Bun.sleep(10);
    // Same hub: the key is unchanged, no reload.
    reconnect();
    await Bun.sleep(10);
    expect(reloads).toBe(0);
    // A restarted hub: new key, one reload; a further reconnect to that same hub reloads nothing more.
    key = "two";
    reconnect();
    await Bun.sleep(10);
    expect(reloads).toBe(1);
    reconnect();
    await Bun.sleep(10);
    expect(reloads).toBe(1);
    // A hub that isn't answering: the page can't be trusted, it reloads; once the hub answers again it reloads onto the new script.
    key = null;
    reconnect();
    await Bun.sleep(10);
    expect(reloads).toBe(2);
    key = "three";
    reconnect();
    await Bun.sleep(10);
    expect(reloads).toBe(3);
    // After the frame is gone, a reconnect does nothing.
    stop();
    key = "four";
    reconnect();
    await Bun.sleep(10);
    expect(reloads).toBe(3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a frame mounted before the hub first answered learns the key at its first reconnect and reloads", async () => {
  let key: string | null = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (url === "/api/pair/info") return Response.json({ hostId: "h" });
    return key ? Response.json({ key }) : new Response("no", { status: 502 });
  }) as typeof fetch;
  try {
    let reconnect: () => void = () => {};
    let reloads = 0;
    keepFrameCurrent(() => reloads++, (fn) => ((reconnect = fn), () => {}));
    await Bun.sleep(10);
    key = "fresh";
    reconnect();
    await Bun.sleep(10);
    expect(reloads).toBe(1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("overlapping key asks that finish out of order never put an older key back", async () => {
  const resolvers: ((r: Response) => void)[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    if (url === "/api/pair/info") return Promise.resolve(Response.json({ hostId: "h" }));
    return new Promise<Response>((res) => resolvers.push(res));
  }) as typeof fetch;
  try {
    const older = refreshFrameKey();
    const newer = refreshFrameKey();
    await Bun.sleep(5);
    expect(resolvers.length).toBe(2);
    // The newer ask is answered first; the older one (from before the hub restarted) comes back last.
    resolvers[1](Response.json({ key: "new-hub" }));
    expect(await newer).toBe("new-hub");
    resolvers[0](Response.json({ key: "old-hub" }));
    expect(await older).toBe("new-hub");
    const posted: any[] = [];
    frameDriver({ src: "http://localhost:5173/", contentWindow: { postMessage: (m: unknown) => posted.push(m) } } as any)({ k: "move", lx: 0, ly: 0 }, "p1");
    expect(posted.at(-1).key).toBe("new-hub");
    // A late failure of an older ask doesn't throw away the newer key either.
    const a = refreshFrameKey();
    const b = refreshFrameKey();
    await Bun.sleep(5);
    resolvers[3](Response.json({ key: "third" }));
    await b;
    resolvers[2](new Response("no", { status: 502 }));
    expect(await a).toBe("third");
  } finally {
    globalThis.fetch = realFetch;
  }
});
