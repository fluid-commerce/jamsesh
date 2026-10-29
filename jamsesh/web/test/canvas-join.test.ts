// A person's canvas joins inside its iframe; the page reads how that's going and rejoins when it
// fails, instead of leaving a blank document up. It also loads fonts from the person's own Mac.
import { expect, test } from "bun:test";
import { FontTries, friendlyReason, JoinWatch, RejoinTimer, joinLabel, joinStateOf, loadLocalFonts, rejoinDelay } from "../src/shared/canvasJoin";

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

test("a family kept in several font files loads every file", async () => {
  const { fc, loaded } = fakeCanvas(["Acme"]);
  const invoke = async () => ({ fonts: [{ family: "Acme", data: btoa("Acme") }, { family: "Acme", data: btoa("Acme") }, { family: "Acme", data: btoa("Acme") }], deferred: [] });
  const tried = new FontTries();
  await loadLocalFonts(fc, invoke, tried);
  expect(loaded).toEqual(["Acme", "Acme", "Acme"]);
  expect(tried.done.has("acme")).toBe(true);
});

test("one face failing to load keeps the family due for a retry", async () => {
  const faces: string[] = [];
  const fc = {
    async execute(command: string, params: any) {
      if (command === "text.missingFonts") return { families: [{ family: "Acme" }] };
      if (params.data === "bad") throw new Error("bad font");
      faces.push(params.data);
      return {};
    },
  };
  const tried = new FontTries();
  await loadLocalFonts(fc, async () => ({ fonts: [{ family: "Acme", data: "ok" }, { family: "Acme", data: "bad" }], deferred: [] }), tried);
  expect(faces).toEqual(["ok"]); // the good face still went
  expect(tried.done.has("acme")).toBe(false);
  expect(tried.due("Acme", Date.now() + 5_001)).toBe(true);
});

test("families the Mac didn't get to are asked again, not marked absent", async () => {
  const { fc, loaded } = fakeCanvas(["A", "B", "Gone"]);
  const asked: string[][] = [];
  // Round one: the Mac reads A and defers B; it has no Gone.
  const invoke = async (_c: string, args: any) => {
    asked.push(args.families);
    const fams: string[] = args.families;
    const later = fams.includes("A") ? ["B"] : [];
    return { fonts: fams.filter((f) => f === "A" || (f === "B" && !later.length)).map((family) => ({ family, data: btoa(family) })), deferred: later };
  };
  const tried = new FontTries();
  expect(await loadLocalFonts(fc, invoke, tried)).toEqual(["B", "Gone"]);
  expect(tried.done.has("b")).toBe(false);
  expect(tried.done.has("gone")).toBe(true);
  expect(await loadLocalFonts(fc, invoke, tried)).toEqual(["Gone"]);
  expect(asked).toEqual([["A", "B", "Gone"], ["B"]]);
  expect(loaded).toEqual(["A", "B"]);
});

test("a family the Mac sent only in part is not settled and stays listed as substituted", async () => {
  const { fc, loaded } = fakeCanvas(["Acme", "Huge"]);
  const invoke = async () => ({
    // Acme: one file arrived, another was over the limit. Huge: nothing arrived (all its files too big).
    fonts: [{ family: "Acme", data: btoa("Acme") }],
    deferred: [],
    incomplete: ["Acme", "Huge"],
  });
  const tried = new FontTries();
  const left = await loadLocalFonts(fc, invoke, tried);
  expect(loaded).toEqual(["Acme"]);
  expect(left.sort()).toEqual(["Acme", "Huge"]);
  expect(tried.done.has("acme")).toBe(false);
  expect(tried.done.has("huge")).toBe(false);
  // Not asked again until the backoff, but still listed.
  expect((await loadLocalFonts(fc, invoke, tried)).sort()).toEqual(["Acme", "Huge"]);
  expect(tried.due("Huge", Date.now() + 5_001)).toBe(true);
});

test("a partial family is asked for again after its first face stops it being reported missing, until all faces load", async () => {
  const { fc, loaded } = fakeCanvas(["Acme"]); // reports Acme missing only until one face loads
  const asked: string[][] = [];
  let whole = false;
  const invoke = async (_c: string, args: any) => {
    asked.push(args.families);
    return { fonts: [{ family: "Acme", data: btoa("Acme") }], deferred: [], incomplete: whole ? [] : ["Acme"] };
  };
  const tried = new FontTries();
  expect(await loadLocalFonts(fc, invoke, tried)).toEqual(["Acme"]); // loaded one face; still listed
  expect(await loadLocalFonts(fc, invoke, tried)).toEqual(["Acme"]); // backing off: not asked yet
  expect(asked).toHaveLength(1);
  whole = true;
  const realNow = Date.now;
  Date.now = () => realNow() + 5_001;
  try {
    expect(await loadLocalFonts(fc, invoke, tried)).toEqual([]); // asked again though the canvas no longer reports it
  } finally {
    Date.now = realNow;
  }
  expect(asked).toEqual([["Acme"], ["Acme"]]);
  expect(loaded).toHaveLength(2);
  expect(tried.done.has("acme")).toBe(true);
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

test("a canvas bridge that throws instead of rejecting counts as failed reads, so the join fails and rejoins", async () => {
  const fc = {
    execute: (): Promise<any> => {
      throw new Error("bridge gone");
    },
  };
  const watch = new JoinWatch(20);
  expect(await watch.poll(fc)).toBeNull();
  expect(await watch.poll(fc)).toEqual({ state: "failed", reason: "The canvas stopped answering." });
});

test("a canvas that comes back live before its scheduled rejoin isn't reloaded", async () => {
  const failures = { current: 1 };
  let fired = 0;
  const timer = new RejoinTimer(failures, () => void fired++);
  const at = timer.update({ state: "failed", reason: "gone" });
  expect(at! - Date.now()).toBeGreaterThan(5_000); // 6 s after the second failure in a row
  // Another failed reading doesn't schedule a second one.
  expect(timer.update({ state: "failed", reason: "gone" })).toBe(at);
  expect(timer.update({ state: "live" })).toBeNull();
  expect(failures.current).toBe(0);
  // Recovered after a first failure (a 3 s rejoin) and failing elsewhere: only the one still due fires.
  const recovered = new RejoinTimer({ current: 0 }, () => void fired++);
  recovered.update({ state: "failed", reason: "gone" });
  recovered.update({ state: "live" });
  const failing = new RejoinTimer({ current: 0 }, () => void (fired += 10));
  failing.update({ state: "failed", reason: "gone" });
  await Bun.sleep(3100);
  expect(fired).toBe(10);
}, 10_000);
