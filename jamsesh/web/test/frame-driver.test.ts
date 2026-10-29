// The big screen posts a driver's events into a build's frame with the session's frame key, to the frame's exact origin.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";

(globalThis as any).location ??= { origin: "http://127.0.0.1:4790", pathname: "/host", search: "" };
(globalThis as any).navigator ??= { onLine: true };
const { frameDriver } = await import("../src/shared/drivetiles");

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
