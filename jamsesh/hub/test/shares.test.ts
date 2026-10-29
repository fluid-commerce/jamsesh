import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bus } from "../src/bus";
import { Brain } from "../src/brain/brain";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
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

const display = { width: 1920, height: 1080, dpr: 1, screenX: 1920, screenY: 0, at: Date.now() };
const withGrace = async (ms: number, fn: () => Promise<void>) => {
  Session.SHARE_GRACE_MS = ms;
  try {
    await fn();
  } finally {
    Session.SHARE_GRACE_MS = 5_000;
  }
};

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
  s.placeShare(sh);
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
  s.reportScreen("screen-2", display);
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

test("a share shown and then taken down gets the 5-second grace, not the placement window", async () => {
  const { s } = room();
  const sh = s.startShare("felipe-laptop", "screen"); // brand new: its placement window is still open
  s.setStage({ mode: "layout", layout: { tiles: [{ kind: "screen", shareId: sh.id }] } }, "x");
  // Taken down at once, with no sweep in between: the brief appearance still counts.
  Session.SHARE_GRACE_MS = 30;
  try {
    s.setStage({ mode: "board" }, "x");
    expect(s.store.get("shares", sh.id)?.status).toBe("live");
    await Bun.sleep(120);
  } finally {
    Session.SHARE_GRACE_MS = 5_000;
  }
  expect(s.store.get("shares", sh.id)?.status).toBe("ended");
  const note = sent.find((m) => m.type === "share-ended" && m.shareId === sh.id);
  expect(note && note.type === "share-ended" && note.text).toContain("left the big screen");
});

test("one person sharing from a second device ends the first, and tells that device", () => {
  const { s, felipe } = room();
  s.touchDevice("felipe-phone", { label: "Felipe's phone", personId: felipe.id, kind: "client" });
  const first = s.startShare("felipe-laptop", "screen");
  const second = s.startShare("felipe-phone", "screen");
  expect(s.store.get("shares", first.id)?.status).toBe("ended");
  expect(s.shares().filter((x) => x.status === "live").map((x) => x.id)).toEqual([second.id]);
  expect(sent.some((m) => m.type === "share-ended" && m.shareId === first.id && m.deviceId === "felipe-laptop")).toBe(true);
  // Their camera is a different thing and stays.
  const cam = s.startShare("felipe-laptop", "camera");
  s.startShare("felipe-phone", "screen", second.id);
  expect(s.store.get("shares", cam.id)?.status).toBe("live");
});

test("a share id from someone else's device starts a new share instead of taking theirs", () => {
  const { s, felipe } = room();
  const rae = s.upsertPerson({ name: "Rae" });
  s.touchDevice("rae-laptop", { label: "Rae's laptop", personId: rae.id, kind: "client" });
  const theirs = s.startShare("felipe-laptop", "screen");
  const mine = s.startShare("rae-laptop", "screen", theirs.id);
  expect(mine.id).not.toBe(theirs.id);
  expect(s.store.get("shares", theirs.id)).toMatchObject({ status: "live", deviceId: "felipe-laptop" });
  // Nor a request made to another person.
  const asked = s.requestShare(felipe.id, "camera", "", "x")!;
  expect(s.startShare("rae-laptop", "camera", asked.id).id).not.toBe(asked.id);
  expect(s.store.get("shares", asked.id)?.status).toBe("requested");
});

test("a share shown only on a display that closes, or stops reporting, stops after the grace", async () => {
  const { s } = room();
  await withGrace(30, async () => {
    const closed = s.startShare("felipe-laptop", "screen");
    s.reportScreen("screen-2", { ...display, at: Date.now() });
    s.setStage({ mode: "layout", layout: { tiles: [{ kind: "screen", shareId: closed.id }] } }, "x", "screen-2");
    s.removeScreen("screen-2");
    expect(s.store.get("shares", closed.id)?.status).toBe("live");
    await Bun.sleep(120);
    expect(s.store.get("shares", closed.id)?.status).toBe("ended");
    // A display that went quiet (its last report is past the 3-minute cutoff) is gone too.
    const quiet = s.startShare("felipe-laptop", "camera");
    s.reportScreen("screen-3", { ...display, at: Date.now() - 4 * 60_000 });
    s.setStage({ mode: "layout", layout: { tiles: [{ kind: "screen", shareId: quiet.id }] } }, "x", "screen-3");
    s.sweepShares(); // never shown on a display that is there: still within its placement window
    expect(s.store.get("shares", quiet.id)?.status).toBe("live");
    s.store.put("shares", { ...s.store.get("shares", quiet.id)!, startedAt: Date.now() - 120_000 });
    s.sweepShares();
    expect(s.store.get("shares", quiet.id)?.status).toBe("ended");
  });
});

test("stage changes every few seconds can't postpone an off-screen share's end", async () => {
  const { s } = room();
  await withGrace(80, async () => {
    const sh = s.startShare("felipe-laptop", "screen");
    s.setStage({ mode: "layout", layout: { tiles: [{ kind: "screen", shareId: sh.id }] } }, "x");
    s.setStage({ mode: "board" }, "x");
    // Keep changing the stage faster than the grace, past the deadline.
    for (let i = 0; i < 6; i++) {
      await Bun.sleep(30);
      s.setStage({ mode: i % 2 ? "board" : "join" }, "x");
    }
    expect(s.store.get("shares", sh.id)?.status).toBe("ended");
  });
});

test("with the brain off a new share still goes up, full screen, at once", async () => {
  const { s } = room();
  s.updateSettings({ brainEnabled: false });
  const sh = s.startShare("felipe-laptop", "screen");
  s.placeShare(sh);
  expect(s.stage().layout?.tiles).toEqual([{ kind: "screen", shareId: sh.id, label: sh.label }]);
  s.sweepShares();
  expect(s.store.get("shares", sh.id)?.status).toBe("live");
  // A pinned screen stays put; the room is told instead.
  const { s: s2 } = room();
  s2.setStage({ mode: "board", pinned: true }, "Felipe");
  s2.placeShare(s2.startShare("felipe-laptop", "screen"));
  expect(s2.stage().mode).toBe("board");
  expect(sent.some((m) => m.type === "toast" && /pinned/.test((m as any).detail))).toBe(true);
});

test("an extra display gets back what it showed when its share ends", () => {
  const { s } = room();
  s.reportScreen("screen-2", { ...display, at: Date.now() });
  s.setStage({ mode: "compare", title: "Nav", items: ["a1", "a2"] }, "x", "screen-2");
  const sh = s.startShare("felipe-laptop", "screen");
  s.setStage({ mode: "layout", layout: { tiles: [{ kind: "screen", shareId: sh.id }] } }, "x", "screen-2");
  s.endShare(sh.id);
  expect(s.stage("screen-2")).toMatchObject({ mode: "compare", title: "Nav", items: ["a1", "a2"] });
});

describe("share calls act only for the window that made them", () => {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: mkdtempSync(join(dir, "h-")) });
  const server = startHttp(hub, 0);
  const base = `http://127.0.0.1:${server.port}`;
  afterAll(() => {
    server.stop(true);
    hub.devproxy.stop();
    hub.stop();
  });
  const s = hub.session;
  const felipe = s.upsertPerson({ name: "Felipe" });
  const rae = s.upsertPerson({ name: "Rae" });
  const felipeLaptop = hub.auth.issue({ kind: "browser", label: "Felipe's laptop", ip: "10.0.0.2", personId: felipe.id });
  const felipePhone = hub.auth.issue({ kind: "browser", label: "Felipe's phone", ip: "10.0.0.3", personId: felipe.id });
  const raeLaptop = hub.auth.issue({ kind: "browser", label: "Rae's laptop", ip: "10.0.0.4", personId: rae.id });
  const agent = hub.auth.issue({ kind: "agent", label: "Agents", ip: "10.0.0.5", personId: rae.id, ownerDeviceId: raeLaptop.device.id });
  const call = (token: string | null, method: string, path: string, body?: unknown) =>
    fetch(`${base}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { "x-forwarded-for": "9.9.9.9", authorization: `Bearer ${token}` } : { cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const register = async (token: string, deviceId: string, personId: string) => expect((await call(token, "POST", "/devices", { deviceId, personId, label: deviceId })).status).toBe(200);

  test("a foreign window can't start, end or decline someone else's share, or take over their device", async () => {
    await register(felipeLaptop.token, "dev-felipe", felipe.id);
    await register(raeLaptop.token, "dev-rae", rae.id);
    // Rae re-registers Felipe's device id as hers: refused, and it stays his (and her window stays hers).
    expect((await call(raeLaptop.token, "POST", "/devices", { deviceId: "dev-felipe", personId: rae.id, label: "mine" })).status).toBe(403);
    expect(s.store.get("devices", "dev-felipe")).toMatchObject({ pairedId: felipeLaptop.device.id, personId: felipe.id });
    // The host's window may say whose it is; that doesn't hand it over.
    expect((await call(null, "POST", "/devices", { deviceId: "dev-felipe", personId: felipe.id, label: "Felipe's laptop" })).status).toBe(200);
    expect(s.store.get("devices", "dev-felipe")?.pairedId).toBe(felipeLaptop.device.id);
    expect(s.store.setting("hostPersonId", "")).toBe("");
    expect((await call(raeLaptop.token, "POST", "/shares", { deviceId: "dev-felipe", kind: "screen" })).status).toBe(403);
    const started = await call(felipeLaptop.token, "POST", "/shares", { deviceId: "dev-felipe", kind: "screen", shareId: "sh-local" });
    expect(started.status).toBe(200);
    const sh = await started.json();
    expect((await call(raeLaptop.token, "DELETE", `/shares/${sh.id}`)).status).toBe(403);
    expect((await call(raeLaptop.token, "POST", `/shares/${sh.id}/decline`, {})).status).toBe(403);
    expect((await call(agent.token, "DELETE", `/shares/${sh.id}`)).status).toBe(403);
    // Rae naming Felipe's share id from her own device starts her own share.
    const hers = await (await call(raeLaptop.token, "POST", "/shares", { deviceId: "dev-rae", kind: "screen", shareId: sh.id })).json();
    expect(hers.id).not.toBe(sh.id);
    expect(s.store.get("shares", sh.id)).toMatchObject({ status: "live", deviceId: "dev-felipe" });
    // His own window ends it; repeating the call is harmless.
    expect((await call(felipeLaptop.token, "DELETE", `/shares/${sh.id}`)).status).toBe(200);
    expect((await call(felipeLaptop.token, "DELETE", `/shares/${sh.id}`)).status).toBe(200);
    expect(s.store.get("shares", sh.id)?.status).toBe("ended");
    // The host's own window ends anyone's.
    expect((await call(null, "DELETE", `/shares/${hers.id}`)).status).toBe(200);
    expect(s.store.get("shares", hers.id)?.status).toBe("ended");
  });

  test("a request is declined by the person asked, from any of their windows, and only while it waits", async () => {
    await register(felipePhone.token, "dev-felipe-phone", felipe.id);
    const asked = s.requestShare(felipe.id, "camera", "", "Host")!;
    expect((await call(raeLaptop.token, "POST", `/shares/${asked.id}/decline`, {})).status).toBe(403);
    // Felipe's laptop answers it; the phone's stale prompt then says no, which mustn't end the live share.
    expect((await call(felipeLaptop.token, "POST", "/shares", { deviceId: "dev-felipe", kind: "camera", shareId: asked.id })).status).toBe(200);
    expect(s.store.get("shares", asked.id)?.status).toBe("live");
    expect((await call(felipePhone.token, "POST", `/shares/${asked.id}/decline`, {})).status).toBe(403);
    expect(s.store.get("shares", asked.id)?.status).toBe("live");
    // A fresh request: his phone may decline it.
    s.endShare(asked.id);
    const again = s.requestShare(felipe.id, "camera", "", "Host")!;
    expect((await call(felipePhone.token, "POST", `/shares/${again.id}/decline`, {})).status).toBe(200);
    expect(s.store.get("shares", again.id)?.status).toBe("declined");
  });

  test("a share id is never reused for the other kind of capture", async () => {
    const screen = await (await call(felipeLaptop.token, "POST", "/shares", { deviceId: "dev-felipe", kind: "screen" })).json();
    const cam = await (await call(felipeLaptop.token, "POST", "/shares", { deviceId: "dev-felipe", kind: "camera", shareId: screen.id })).json();
    expect(cam.id).not.toBe(screen.id);
    expect(cam.kind).toBe("camera");
    expect(s.store.get("shares", screen.id)).toMatchObject({ kind: "screen", status: "live" });
    // The same kind and device re-registers its own share (after a reconnect).
    const again = await (await call(felipeLaptop.token, "POST", "/shares", { deviceId: "dev-felipe", kind: "screen", shareId: screen.id })).json();
    expect(again.id).toBe(screen.id);
  });

  test("the same person sharing from their second window replaces the first, over HTTP", async () => {
    const one = await (await call(felipeLaptop.token, "POST", "/shares", { deviceId: "dev-felipe", kind: "screen" })).json();
    const two = await (await call(felipePhone.token, "POST", "/shares", { deviceId: "dev-felipe-phone", kind: "screen" })).json();
    expect(s.store.get("shares", one.id)?.status).toBe("ended");
    expect(s.store.get("shares", two.id)?.status).toBe("live");
    expect(sent.some((m) => m.type === "share-ended" && m.shareId === one.id && m.deviceId === "dev-felipe")).toBe(true);
  });
});
