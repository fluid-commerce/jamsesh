// When the brain talks out loud (live; needs the gateway key).
//   cd jamsesh/hub && bun test test/brain.speech.test.ts --timeout 120000
import { describe, expect, test } from "bun:test";
import { config } from "../src/config";
import { makeRoom, type Room } from "./bench";

const live = !!config.envGatewayKey && !config.offline;
const t = (live ? test : test.skip) as typeof test;

function room() {
  const r = makeRoom();
  r.hub.session.updateSettings({ voiceReplies: true });
  return r;
}
const spoken = (r: Room) => r.hub.session.store.recentEvents({ kinds: ["brain"], limit: 20 }).filter((e) => e.data.spoken);
const replies = (r: Room) => r.hub.session.store.recentEvents({ kinds: ["brain"], limit: 20 });
/** A spoken request: what the audio pipeline produces for a line that says the brain's name. */
function voice(r: Room, who: "chey" | "felipe", text: string) {
  const s = r.hub.session;
  const ev = s.store.addEvent({ kind: "speech", authorType: "person", authorId: r.people[who].id, authorName: r.people[who].name, text });
  r.hub.brain.hear(ev);
}
async function settleDirect(r: Room) {
  await new Promise((res) => setTimeout(res, 800));
  await r.settle();
  for (let i = 0; i < 60 && r.hub.session.brainStatus.status === "thinking"; i++) await new Promise((res) => setTimeout(res, 500));
}

describe("speaking out loud", () => {
  t("a spoken question gets a short spoken answer", async () => {
    const r = room();
    voice(r, "chey", "JamSesh, which agent is working on the mobile app right now?");
    await settleDirect(r);
    expect(spoken(r).length).toBe(1);
    expect(spoken(r)[0].text.split(/[.!?]\s/).length).toBeLessThanOrEqual(2);
    r.stop();
  }, 120_000);

  t("a typed question is answered in text, not out loud", async () => {
    const r = room();
    r.hub.typed(r.people.chey.id, "Which agent is working on the mobile app?", true);
    await settleDirect(r);
    expect(replies(r).length).toBeGreaterThan(0);
    expect(spoken(r).length).toBe(0);
    r.stop();
  }, 120_000);

  t("a spoken command with a visible result stays silent", async () => {
    const r = room();
    voice(r, "felipe", "JamSesh, bring up the nav options on the big screen.");
    await settleDirect(r);
    expect(["compare", "spotlight", "layout"]).toContain(r.stage().mode);
    expect(spoken(r).length).toBe(0);
    r.stop();
  }, 120_000);

  t("work routed from overheard talk is silent", async () => {
    const r = room();
    r.say("felipe", "Let's get the mobile agent to mock up two onboarding variants with illustrations.");
    await settleDirect(r);
    // Overheard, so it waits on the Tasks board rather than going out. The pass starts after the settle above returns.
    for (let i = 0; i < 80 && !r.hub.session.board.open().length; i++) await new Promise((res) => setTimeout(res, 500));
    expect(r.hub.session.board.open().length).toBeGreaterThan(0);
    expect(r.directives()).toHaveLength(0);
    expect(spoken(r).length).toBe(0);
    r.stop();
  }, 120_000);

  t("something it can't do, asked by voice, is said out loud", async () => {
    const r = room();
    voice(r, "chey", "JamSesh, put the Android tablet build of the app up on the screen.");
    await settleDirect(r);
    expect(spoken(r).length).toBe(1);
    r.stop();
  }, 120_000);

  t("a room that asked for quiet gets silent actions and spoken answers only", async () => {
    const r = room();
    r.hub.session.updateSettings({ brainNotes: ["Don't talk out loud unless someone asks you a question directly."] });
    voice(r, "felipe", "JamSesh, show me what all the agents are doing.");
    await settleDirect(r);
    expect(spoken(r).length).toBe(0);
    r.stop();
  }, 120_000);
});
