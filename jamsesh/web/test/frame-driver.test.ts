// The big screen posts a driver's events into a build's frame with the session's frame key, to the frame's exact origin.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";

(globalThis as any).location ??= { origin: "http://127.0.0.1:4790", pathname: "/host", search: "" };
(globalThis as any).navigator ??= { onLine: true };
const { frameDriver, refreshFrameKey } = await import("../src/shared/drivetiles");

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
      [{ jamDrive: { k: "move", lx: 0.25, ly: 0.5, x: 0.25, y: 0.5 }, key: "secret" }, "http://localhost:5173"],
      [{ jamDrive: { k: "key", key: "a", down: true }, key: "secret" }, "http://localhost:5173"],
    ]);
    // A frame whose address isn't a URL gets nothing (never posted to "*").
    const bad = { src: "", contentWindow: { postMessage: () => posted.push(["bad", "*"]) } } as any;
    frameDriver(bad)(move, "p1");
    expect(posted.length).toBe(2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("after a hub restart the new key is used, the frames are told to reload, and an unchanged key leaves them alone", async () => {
  // (The key from the test above is still the page's: a page keeps its key for its lifetime.)
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
    drive(move, "p1");
    expect(posted.at(-1).key).toBe("secret");
    // The connection came back to the same hub: nothing changes.
    expect(await refreshFrameKey()).toBe(false);
    // A new hub, a new key: events carry it and the caller reloads the frame.
    key = "two";
    expect(await refreshFrameKey()).toBe(true);
    drive(move, "p1");
    expect(posted.at(-1).key).toBe("two");
    // The hub isn't answering yet: the caller reloads, and the next event asks again rather than sending a stale key.
    up = false;
    expect(await refreshFrameKey()).toBe(true);
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
