import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bus } from "../src/bus";
import { Brain } from "../src/brain/brain";
import { Session } from "../src/session";
import { Store } from "../src/store";
import type { BusMessage } from "../src/types";

const dir = mkdtempSync(join(tmpdir(), "jam-shares-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function room() {
  const s = new Session(new Store(mkdtempSync(join(dir, "s-"))));
  const felipe = s.upsertPerson({ name: "Felipe" });
  s.touchDevice("felipe-laptop", { label: "Felipe's laptop", personId: felipe.id, kind: "client" });
  return { s, felipe };
}

let sent: BusMessage[] = [];
const off = bus.on((m) => sent.push(m));
afterAll(() => void off());
beforeEach(() => (sent = []));

test("two requests to one person make one pending share, and one request prompt", () => {
  const { s, felipe } = room();
  const a = s.requestShare(felipe.id, "screen", "show the bug", "Room brain");
  const b = s.requestShare(felipe.id, "screen", "show the bug again", "Room brain");
  expect(b?.id).toBe(a!.id);
  expect(sent.filter((m) => m.type === "share-request")).toHaveLength(1);
  // A camera is a different thing and still gets asked.
  expect(s.requestShare(felipe.id, "camera", "", "Room brain")?.id).not.toBe(a!.id);
});

test("asking someone who is already sharing returns the live share", () => {
  const { s, felipe } = room();
  const req = s.requestShare(felipe.id, "screen", "", "Room brain")!;
  s.startShare("felipe-laptop", "screen", req.id);
  const again = s.requestShare(felipe.id, "screen", "", "Room brain")!;
  expect(again.id).toBe(req.id);
  expect(again.status).toBe("live");
  expect(sent.filter((m) => m.type === "share-request")).toHaveLength(1);
});

test("the brain's request_share tool says so when the person is already sharing", async () => {
  const { s, felipe } = room();
  const brain = new Brain(s, {} as any);
  clearInterval((brain as any).digestTimer);
  const tools = (brain as any).tools([], { effects: 0 });
  const first = await tools.request_share.execute({ person: "Felipe", kind: "screen", reason: "bug" });
  expect(first).toContain("Asked Felipe");
  const second = await tools.request_share.execute({ person: "Felipe", kind: "screen", reason: "bug" });
  expect(second).toContain("no second one was sent");
  expect(s.shares().filter((x) => x.personId === felipe.id)).toHaveLength(1);
  s.startShare("felipe-laptop", "screen", s.shares()[0].id);
  const third = await tools.request_share.execute({ person: "Felipe", kind: "screen", reason: "bug" });
  expect(third).toContain("already sharing");
  expect(s.shares().filter((x) => x.personId === felipe.id)).toHaveLength(1);
});

test("a new screen share from a device ends its earlier one, and answers waiting requests", () => {
  const { s, felipe } = room();
  const first = s.startShare("felipe-laptop", "screen");
  const waiting = s.requestShare(felipe.id, "camera", "", "x")!; // different kind: untouched
  const second = s.startShare("felipe-laptop", "screen");
  expect(s.store.get("shares", first.id)?.status).toBe("ended");
  expect(s.shares().filter((x) => x.kind === "screen" && x.status === "live").map((x) => x.id)).toEqual([second.id]);
  expect(s.store.get("shares", waiting.id)?.status).toBe("requested");
  expect(sent.some((m) => m.type === "share-ended" && m.shareId === first.id)).toBe(true);
  // A request still waiting when the person starts sharing on their own is answered by that share.
  const { s: s2, felipe: f2 } = room();
  const pending = s2.requestShare(f2.id, "screen", "", "x")!;
  const own = s2.startShare("felipe-laptop", "screen");
  expect(s2.store.get("shares", pending.id)?.status).toBe("ended");
  expect(own.status).toBe("live");
});

test("a new share fills the screen alone and the screen comes back when it ends", async () => {
  const { s } = room();
  const brain = new Brain(s, {} as any);
  clearInterval((brain as any).digestTimer);
  s.setStage({ mode: "layout", title: "Review", layout: { tiles: [{ kind: "artifact", artifactId: "a1" }, { kind: "artifact", artifactId: "a2" }] } }, "Room brain");
  const sh = s.startShare("felipe-laptop", "screen");
  await brain.placeShare(sh);
  expect(s.stage().layout?.tiles).toEqual([{ kind: "screen", shareId: sh.id, label: sh.label }]);
  s.endShare(sh.id);
  expect(s.stage().layout?.tiles.map((t) => t.kind)).toEqual(["artifact", "artifact"]);
  expect(s.stage().title).toBe("Review");
});

test("a share that no host screen shows stops after the grace period, and the sharer is told", async () => {
  const { s } = room();
  const sh = s.startShare("felipe-laptop", "screen");
  // Past the time the brain gets to place a new share.
  s.store.put("shares", { ...sh, startedAt: Date.now() - 120_000 });
  const keep = s.startShare("felipe-laptop", "camera");
  s.store.put("shares", { ...keep, startedAt: Date.now() - 120_000 });
  // Both were up; then the screen share was taken down.
  s.setStage({ mode: "layout", layout: { tiles: [{ kind: "screen", shareId: sh.id }, { kind: "screen", shareId: keep.id }] } }, "x");
  s.sweepShares();
  s.setStage({ mode: "layout", layout: { tiles: [{ kind: "screen", shareId: keep.id }] } }, "x");
  Session.SHARE_GRACE_MS = 30;
  try {
    s.setStage({ mode: "layout", layout: { tiles: [{ kind: "screen", shareId: keep.id }] } }, "x"); // reschedule with the short grace
    expect(s.store.get("shares", sh.id)?.status).toBe("live"); // not cut at once
    await Bun.sleep(120);
  } finally {
    Session.SHARE_GRACE_MS = 5_000;
  }
  expect(s.store.get("shares", sh.id)?.status).toBe("ended");
  expect(s.store.get("shares", keep.id)?.status).toBe("live");
  const note = sent.find((m) => m.type === "share-ended" && m.shareId === sh.id);
  expect(note && note.type === "share-ended" && note.text).toContain("left the big screen");
});

test("a share on an extra screen is not cut, and a brand-new share gets time to be placed", async () => {
  const { s } = room();
  const sh = s.startShare("felipe-laptop", "screen");
  s.setStage({ mode: "layout", layout: { tiles: [{ kind: "screen", shareId: sh.id }] } }, "x", "screen-2");
  s.sweepShares();
  expect(s.store.get("shares", sh.id)?.status).toBe("live");
  const fresh = s.startShare("felipe-laptop", "camera");
  s.sweepShares();
  expect(s.store.get("shares", fresh.id)?.status).toBe("live");
});

test("a share that never went up says so when it stops", async () => {
  const { s } = room();
  const sh = s.startShare("felipe-laptop", "screen");
  s.store.put("shares", { ...sh, startedAt: Date.now() - 120_000 });
  s.sweepShares();
  expect(s.store.get("shares", sh.id)?.status).toBe("ended");
  const note = sent.find((m) => m.type === "share-ended" && m.shareId === sh.id);
  expect(note && note.type === "share-ended" && note.text).toContain("wasn't put on the big screen");
});
