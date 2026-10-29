// A person's canvas joins inside its iframe; the page reads how that's going and rejoins when it
// fails, instead of leaving a blank document up. It also loads fonts from the person's own Mac.
import { expect, test } from "bun:test";
import { joinLabel, joinStateOf, loadLocalFonts, rejoinDelay } from "../src/shared/canvasJoin";

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
  expect(joinLabel({ state: "failed", reason: "The canvas server didn't answer." })).toContain("didn't answer");
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
  const tried = new Set<string>();
  expect(await loadLocalFonts(fc, invoke, tried)).toEqual(["Söhne"]);
  expect(loaded).toEqual(["Helvetica Neue"]);
  // Polling again doesn't ask the Mac for what it didn't have.
  expect(await loadLocalFonts(fc, invoke, tried)).toEqual(["Söhne"]);
  expect(asked).toEqual([["Helvetica Neue", "Söhne"]]);
});

test("in a browser there's no Mac to ask: the missing families are only listed", async () => {
  const { fc, loaded } = fakeCanvas(["Helvetica Neue"]);
  expect(await loadLocalFonts(fc, null, new Set())).toEqual(["Helvetica Neue"]);
  expect(loaded).toEqual([]);
});
