// A Mac tile's button never stays down, and a press's requests land in order.
import { expect, test } from "bun:test";
import { inOrder, replayTileEvent, type Body, type Press } from "../src/shared/tileinput";

const KEYS = { Enter: "return" };

test("a press's requests run in order even when the first is the slowest", async () => {
  const landed: string[] = [];
  const send = inOrder(async (b) => {
    await Bun.sleep(b.t === "down" ? 30 : 1);
    landed.push(String(b.t));
  });
  send({ t: "down" });
  send({ t: "move" });
  send({ t: "up" });
  await Bun.sleep(80);
  expect(landed).toEqual(["down", "move", "up"]);
});

test("a failed request doesn't stop the ones behind it, and a backlog of moves drops moves but never an up", async () => {
  const landed: string[] = [];
  let first = true;
  const send = inOrder(async (b) => {
    await Bun.sleep(5);
    if (first && ((first = false), true)) throw new Error("boom");
    landed.push(String(b.t));
  });
  send({ t: "down" });
  for (let i = 0; i < 20; i++) send({ t: "move" });
  send({ t: "up" });
  await Bun.sleep(150);
  expect(landed.at(-1)).toBe("up");
  expect(landed.filter((t) => t === "move").length).toBeLessThan(20);
});

function drive(mac: boolean) {
  const sent: [Body, string | undefined][] = [];
  const st = new Map<string, Press>();
  const ev = (e: Parameters<typeof replayTileEvent>[1], t = 1000) => replayTileEvent(st, e, "p1", mac, (b, as) => sent.push([b, as]), KEYS, () => {}, t);
  return { sent, st, ev };
}

test("a driver whose pointer leaves the tile mid-drag releases the Mac button where it last was; the up that follows is ignored", () => {
  const { sent, st, ev } = drive(true);
  ev({ k: "down", lx: 0.2, ly: 0.2 });
  ev({ k: "move", lx: 0.5, ly: 0.6 }, 1100);
  ev({ k: "leave" });
  expect(sent.map(([b]) => b)).toEqual([{ t: "down", x: 0.2, y: 0.2 }, { t: "move", x: 0.5, y: 0.6 }, { t: "up", x: 0.5, y: 0.6 }]);
  expect(st.size).toBe(0);
  ev({ k: "up", lx: 0.9, ly: 0.9 });
  expect(sent.length).toBe(3);
});

test("leaving with nothing pressed, or on a simulator, sends nothing; a press then up is a tap or a swipe", () => {
  const mac = drive(true);
  mac.ev({ k: "leave" });
  expect(mac.sent).toEqual([]);
  const sim = drive(false);
  sim.ev({ k: "down", lx: 0.2, ly: 0.2 });
  sim.ev({ k: "leave" });
  expect(sim.sent).toEqual([]);
  sim.ev({ k: "down", lx: 0.2, ly: 0.2 });
  sim.ev({ k: "up", lx: 0.2, ly: 0.2 });
  expect(sim.sent.map(([b]) => b.t)).toEqual(["tap"]);
  sim.ev({ k: "down", lx: 0.2, ly: 0.2 });
  sim.ev({ k: "move", lx: 0.6, ly: 0.2 });
  sim.ev({ k: "up", lx: 0.6, ly: 0.2 });
  expect(sim.sent.map(([b]) => b.t)).toEqual(["tap", "swipe"]);
});

test("two drivers' presses are kept apart and every request carries its driver", () => {
  const sent: [Body, string | undefined][] = [];
  const st = new Map<string, Press>();
  const go = (who: string, e: Parameters<typeof replayTileEvent>[1]) => replayTileEvent(st, e, who, true, (b, as) => sent.push([b, as]), KEYS, () => {});
  go("a", { k: "down", lx: 0.1, ly: 0.1 });
  go("b", { k: "down", lx: 0.8, ly: 0.8 });
  go("a", { k: "leave" });
  expect(sent.at(-1)).toEqual([{ t: "up", x: 0.1, y: 0.1 }, "a"]);
  expect(st.has("b")).toBe(true);
});
