// The room brain with the real model (needs the gateway key): overheard work waits as cards, what's asked of
// JamSesh goes out, and "send that one" works out loud.
//   cd jamsesh/hub && bun test test/triage-board.live.test.ts --timeout 120000
import { expect, test } from "bun:test";
import { config } from "../src/config";
import { makeRoom, sleep, type Room } from "./bench";

const live = !!config.envGatewayKey && !config.offline;
const t = (live ? test : test.skip) as typeof test;
const T = 150_000;

const until = async (fn: () => boolean, ms = 90_000) => {
  for (let i = 0; i < ms / 500 && !fn(); i++) await sleep(500);
};
const voice = (r: Room, who: "chey" | "felipe", text: string) => {
  const ev = r.hub.session.store.addEvent({ kind: "speech", authorType: "person", authorId: r.people[who].id, authorName: r.people[who].name, text });
  r.hub.brain.hear(ev);
};

t("overheard work waits on the board, the same work asked of JamSesh goes out, and 'send that one' sends the card", async () => {
  const r = makeRoom();
  const s = r.hub.session;
  s.updateSettings({ voiceReplies: false });
  // Overheard: a request to nobody in particular.
  r.say("felipe", "Let's get the mobile agent to mock up two onboarding variants with illustrations.");
  await until(() => s.board.open().some((c) => c.type === "task"));
  expect(s.board.open().filter((c) => c.type === "task").length).toBeGreaterThan(0);
  expect(r.directives()).toHaveLength(0);
  const card = s.board.open().find((c) => c.type === "task")!;
  expect(card.sources.length).toBeGreaterThan(0);

  // On purpose: typed to JamSesh, straight out.
  r.hub.typed(r.people.chey.id, "JamSesh, have the desktop agent try a collapsible sidebar", true);
  await until(() => s.directives().length > 0);
  expect(s.directives().length).toBeGreaterThan(0);
  expect(s.directives().every((d) => d.id !== card.id)).toBe(true);

  // Spoken triage: "send that one" sends the waiting card.
  const before = s.directives().length;
  voice(r, "chey", "JamSesh, send that one.");
  await until(() => s.board.get(card.id)!.status !== "open");
  expect(s.board.get(card.id)!.status).toBe("sent");
  expect(s.directives().length).toBe(before + 1);
  r.stop();
}, T);

t("an overheard decision waits; 'JamSesh, remember…' is saved on the spot", async () => {
  const r = makeRoom();
  const s = r.hub.session;
  r.say("felipe", "Okay we're going with the compact search in the settings header, final answer.");
  await until(() => s.board.open().some((c) => c.type === "context"));
  expect(s.board.open().some((c) => c.type === "context")).toBe(true);
  expect(s.facts().filter((f) => f.status === "active")).toHaveLength(0);
  r.hub.typed(r.people.chey.id, "JamSesh, remember that the brand color is #E85A3A and must never change.", true);
  await until(() => s.facts().some((f) => f.status === "active"));
  expect(s.facts().some((f) => f.status === "active" && /E85A3A/i.test(f.text))).toBe(true);
  r.stop();
}, T);
