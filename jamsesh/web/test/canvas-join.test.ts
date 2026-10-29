// A person's canvas joins inside its iframe; the page reads how that's going and rejoins when it
// fails, instead of leaving a blank document up. It also loads fonts from the person's own Mac.
import { expect, test } from "bun:test";
import { FontTries, friendlyReason, JoinWatch, joinLabel, joinStateOf, loadLocalFonts, rejoinDelay } from "../src/shared/canvasJoin";

test("the join state comes from the canvas's own session", () => {
  expect(joinStateOf({ status: "live" })).toEqual({ state: "live" });
  expect(joinStateOf({ status: "connecting" })).toEqual({ state: "connecting" });
  expect(joinStateOf({ status: "reconnecting", reason: "connection lost" })).toEqual({ state: "reconnecting", reason: "connection lost" });
  expect(joinStateOf({ status: "failed", reason: "This device isn't paired" })).toEqual({ state: "failed", reason: "This device isn't paired" });
  // The blank document the canvas starts on isn't in a session; the join shows in `sessions`.
  expect(joinStateOf({ status: "off", sessions: [{ status: "connecting" }] })).toEqual({ state: "connecting" });
  expect(joinStateOf({ status: "off", sessions: [{ status: "failed", reason: "401" }] })).toEqual({ state: "failed", reason: "401" });
  expect(joinStateOf({ status: "off", sessions: [{ status: "failed" }, { status: "live" }] })).toEqual({ state: "live" });
  // A join that never started (a bad link) is a failure too, never a silent blank page.
  expect(joinStateOf({ status: "off", sessions: [] }).state).toBe("failed");
  expect(joinStateOf(null).state).toBe("failed");
});

test("a failed join is retried by itself, backing off to every 30 s", () => {
  expect([0, 1, 2, 3, 4, 10].map(rejoinDelay)).toEqual([3000, 6000, 12000, 24000, 30000, 30000]);
});

test("the page bar says something whenever the canvas isn't live", () => {
  expect(joinLabel({ state: "live" })).toBeNull();
  for (const j of [{ state: "loading" }, { state: "connecting" }, { state: "reconnecting", reason: null }, { state: "stale" }] as const) expect(joinLabel(j)).toBeTruthy();
  // The pill stays short: the reason is on the card over the canvas, said once.
  expect(joinLabel({ state: "failed", reason: "WebSocket error: 401" })).toBe("Reconnecting…");
});

test("join errors read as a few plain reasons", () => {
  expect(friendlyReason("collab: 401 This device isn't paired")).toBe("This device isn't paired with the host.");
  expect(friendlyReason("ws://10.0.0.2:47900: Connection refused (os error 61)")).toBe("Can't reach the host on the network.");
  expect(friendlyReason("The canvas server didn't answer.")).toBe("Can't reach the host on the network.");
  expect(friendlyReason("The canvas isn't in the session.")).toBe("The host's canvas is restarting.");
  expect(friendlyReason("file not found on the server")).toBe("The host's canvas is restarting.");
  expect(friendlyReason("something odd")).toBe("The connection to the host dropped.");
  expect(friendlyReason(null)).toBe("The connection to the host dropped.");
});

/** A canvas that lacks `missing` until a font for it is loaded. */
function fakeCanvas(missing: string[]) {
  const left = new Set(missing);
  const loaded: string[] = [];
  const fc = {
    async execute(command: string, params: any) {
      if (command === "text.missingFonts") return { families: [...left].map((family) => ({ family, layers: 1 })) };
      if (command === "text.loadFont") {
        const family = atob(params.data);
        loaded.push(family);
        left.delete(family);
        return { families: [family], refitted: [] };
      }
      throw new Error(`unexpected ${command}`);
    },
  };
  return { fc, loaded };
}

test("fonts this Mac has are loaded into the canvas, each family asked for once", async () => {
  const { fc, loaded } = fakeCanvas(["Helvetica Neue", "Söhne"]);
  const asked: string[][] = [];
  const invoke = async (cmd: string, args: any) => {
    expect(cmd).toBe("local_fonts");
    asked.push(args.families);
    // This Mac has Helvetica Neue, not Söhne.
    return args.families.filter((f: string) => f === "Helvetica Neue").map((family: string) => ({ family, data: btoa(family) }));
  };
  const tried = new FontTries();
  expect(await loadLocalFonts(fc, invoke, tried)).toEqual(["Söhne"]);
  expect(loaded).toEqual(["Helvetica Neue"]);
  // Polling again doesn't ask the Mac for what it didn't have.
  expect(await loadLocalFonts(fc, invoke, tried)).toEqual(["Söhne"]);
  expect(asked).toEqual([["Helvetica Neue", "Söhne"]]);
});

test("in a browser there's no Mac to ask: the missing families are only listed", async () => {
  const { fc, loaded } = fakeCanvas(["Helvetica Neue"]);
  expect(await loadLocalFonts(fc, null, new FontTries())).toEqual(["Helvetica Neue"]);
  expect(loaded).toEqual([]);
});

test("a hung or failing collab.peers becomes a failed join, one read at a time", async () => {
  let calls = 0;
  let mode: "hang" | "reject" | "live" = "hang";
  let settle: (v: any) => void = () => {};
  const fc = {
    execute: (cmd: string) => {
      expect(cmd).toBe("collab.peers");
      calls++;
      if (mode === "hang") return new Promise<any>((r) => (settle = r));
      if (mode === "reject") return Promise.reject(new Error("canvas gone"));
      return Promise.resolve({ status: "live" });
    },
  };
  const watch = new JoinWatch(20);
  // Polls while one is still running don't start another.
  const first = watch.poll(fc);
  expect(await watch.poll(fc)).toBeNull();
  expect(calls).toBe(1);
  expect(await first).toBeNull(); // timed out: one miss is a blip
  // The timed-out read is still out: no new read goes on top of it, and the canvas counts as not answering.
  expect(await watch.poll(fc)).toEqual({ state: "failed", reason: "The canvas stopped answering." });
  expect(calls).toBe(1);
  // Its late answer is ignored; once it is back, reads start again.
  mode = "live";
  settle({ status: "live" });
  await Bun.sleep(5);
  expect(await watch.poll(fc)).toEqual({ state: "live" });
  expect(calls).toBe(2);
  // A rejection counts as a miss; an answer resets the count.
  mode = "reject";
  expect(await watch.poll(fc)).toBeNull();
  expect((await watch.poll(fc))?.state).toBe("failed");
  expect(calls).toBe(4);
});

test("a font load that failed for a passing reason is tried again, with backoff; one the Mac lacks isn't", async () => {
  const { fc, loaded } = fakeCanvas(["Helvetica Neue", "Söhne"]);
  let down = true;
  let asks = 0;
  const invoke = async (_cmd: string, args: any) => {
    asks++;
    if (down) throw new Error("app busy");
    return args.families.filter((f: string) => f === "Helvetica Neue").map((family: string) => ({ family, data: btoa(family) }));
  };
  const tries = new FontTries();
  expect(await loadLocalFonts(fc, invoke, tries)).toEqual(["Helvetica Neue", "Söhne"]);
  // Not again straight away…
  await loadLocalFonts(fc, invoke, tries);
  expect(asks).toBe(1);
  // …but after the backoff, and then it loads.
  down = false;
  expect(tries.due("Helvetica Neue", Date.now() + 5_001)).toBe(true);
  const realNow = Date.now;
  Date.now = () => realNow() + 5_001;
  try {
    expect(await loadLocalFonts(fc, invoke, tries)).toEqual(["Söhne"]);
  } finally {
    Date.now = realNow;
  }
  expect(loaded).toEqual(["Helvetica Neue"]);
  // Söhne isn't on this Mac: never asked for again.
  await loadLocalFonts(fc, invoke, tries);
  expect(asks).toBe(2);
});
