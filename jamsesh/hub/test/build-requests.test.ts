import { expect, test } from "bun:test";
import { buildVerdict } from "../src/brain/brain";
import type { JamEvent } from "../src/types";

const said = (text: string, authorType: JamEvent["authorType"] = "person", kind = "speech", ts = Date.now()) =>
  ({ id: 1, kind, authorType, authorId: "p1", authorName: "Maya", text, ts, relevance: "work", data: {} }) as unknown as JamEvent;
const justAsked = [{ createdAt: Date.now() - 5_000 }];
const longAgo = [{ createdAt: Date.now() - 5 * 60_000 }];

test("approve and deny count any time; a casual yes or no only right after the announcement", () => {
  expect(buildVerdict([said("approve")], longAgo)).toMatchObject({ approve: true, by: "Maya" });
  expect(buildVerdict([said("deny that one")], longAgo)?.approve).toBe(false);
  expect(buildVerdict([said("yeah go ahead")], justAsked)?.approve).toBe(true);
  expect(buildVerdict([said("not now, we're mid-review")], justAsked)?.approve).toBe(false);
  // Minutes later, "go ahead" is about something else...
  expect(buildVerdict([said("ok go ahead and mock that up")], longAgo)).toBeNull();
  // ...unless it's said to the brain.
  expect(buildVerdict([said("JamSesh, build it")], longAgo)?.approve).toBe(true);
});

test("prompts to agents, agents, and unclear lines never approve", () => {
  expect(buildVerdict([said("go ahead", "person", "prompt")], justAsked)).toBeNull();
  expect(buildVerdict([said("approve", "person", "prompt")], justAsked)).toBeNull();
  expect(buildVerdict([said("approve", "agent")], justAsked)).toBeNull();
  expect(buildVerdict([said("approve", "brain")], justAsked)).toBeNull();
  expect(buildVerdict([said("approve")], [...justAsked, ...justAsked])).toBeNull();
  expect(buildVerdict([said("approve")], [])).toBeNull();
  expect(buildVerdict([said("go ahead, no wait, don't build it")], justAsked)).toBeNull();
  expect(buildVerdict([said("I think we should approve the budget for next quarter before the offsite, honestly")], justAsked)).toBeNull();
});

test("a short answer is handled whole; a longer line still goes to the brain", () => {
  expect(buildVerdict([said("approve")], justAsked)?.only).toBe(true);
  expect(buildVerdict([said("approve, and then put it next to the simulator")], justAsked)?.only).toBe(false);
});

test("words only count for requests that were already waiting when someone spoke", async () => {
  const { HostControl } = await import("../src/hostctl");
  const host = new HostControl({ store: { addEvent: () => ({}) } } as any);
  const before = Date.now() - 1000;
  const r = host.request({ agentId: "a1", agentName: "Sam's Claude", ownerName: "Sam", repo: "https://github.com/octocat/Hello-World.git", branch: "master", command: "true" });
  if (typeof r === "string") throw new Error(r);
  expect(host.decide(r.id, false, "Maya", before)).toContain("still waiting");
  expect(host.pendingRequests()).toHaveLength(1);
  expect(host.decide(r.id, false, "Maya")).toContain("Denied");
  expect(host.pendingRequests()).toHaveLength(0);
});

test("the brain's name counts when someone addresses it, not when they mention it", async () => {
  const { addressesBrain } = await import("../src/brain/brain");
  for (const yes of ["JamSesh, bring up the nav options", "hey jam sesh what's the code", "ok jamsesh put it up", "can you show both versions, JamSesh?", "Pixel, show the mobile one", "jamsesh"])
    expect([yes, addressesBrain(yes, yes.startsWith("Pixel") ? "Pixel" : "JamSesh")]).toEqual([yes, true]);
  for (const no of ["update the jamsesh skill with the new tools", "open the JamSesh app on your laptop", "I think jamsesh is going to be useful for the offsite next week honestly", "we jammed on the session yesterday"])
    expect([no, addressesBrain(no, "JamSesh")]).toEqual([no, false]);
});

test("the name as speech-to-text writes it, and the name on its own", async () => {
  const { addressesBrain, onlyTheName } = await import("../src/brain/brain");
  expect(addressesBrain("Jam Session, put the nav options up", "JamSesh")).toBe(true);
  expect(addressesBrain("hey jamsession what's the code", "JamSesh")).toBe(true);
  expect(onlyTheName("Hey JamSesh?", "JamSesh")).toBe(true);
  expect(onlyTheName("Jam session.", "JamSesh")).toBe(true);
  expect(onlyTheName("JamSesh, bring up the nav", "JamSesh")).toBe(false);
  expect(onlyTheName("hey Pixel", "Pixel")).toBe(true);
});
