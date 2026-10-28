import { expect, test } from "bun:test";
import { buildVerdict } from "../src/brain/brain";
import type { JamEvent } from "../src/types";

const said = (text: string, authorType: JamEvent["authorType"] = "person") =>
  ({ id: 1, kind: "speech", authorType, authorId: "p1", authorName: "Maya", text, ts: Date.now(), relevance: "work", data: {} }) as unknown as JamEvent;

test("a clear approve or deny decides the one waiting build", () => {
  expect(buildVerdict([said("approve")], 1)).toMatchObject({ approve: true, by: "Maya" });
  expect(buildVerdict([said("yeah go ahead")], 1)?.approve).toBe(true);
  expect(buildVerdict([said("Jamsesh, build it")], 1)?.approve).toBe(true);
  expect(buildVerdict([said("deny that")], 1)?.approve).toBe(false);
  expect(buildVerdict([said("not now, we're mid-review")], 1)?.approve).toBe(false);
});

test("agents can't approve, and unclear lines go to the brain instead", () => {
  expect(buildVerdict([said("approve", "agent")], 1)).toBeNull();
  expect(buildVerdict([said("approve", "brain")], 1)).toBeNull();
  expect(buildVerdict([said("approve")], 2)).toBeNull();
  expect(buildVerdict([said("approve")], 0)).toBeNull();
  expect(buildVerdict([said("go ahead, no wait, don't build it")], 1)).toBeNull();
  expect(buildVerdict([said("I think we should approve the budget for next quarter before the offsite, honestly")], 1)).toBeNull();
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
