import { expect, test } from "bun:test";
import { buildVerdict } from "../src/brain/brain";
import type { JamEvent } from "../src/types";

const said = (text: string, authorType: JamEvent["authorType"] = "person", kind = "speech", ts = Date.now()) =>
  ({ id: 1, kind, authorType, authorId: "p1", authorName: "Maya", text, ts, relevance: "work", data: {} }) as unknown as JamEvent;
const justAsked = [{ createdAt: Date.now() - 5_000 }];
const longAgo = [{ createdAt: Date.now() - 5 * 60_000 }];

test("approve and deny count any time; a casual yes or no only right after the announcement", () => {
  expect(buildVerdict([said("approve")], longAgo)).toMatchObject({ approve: true, by: "Maya" });
  expect(buildVerdict([said("deny that")], longAgo)?.approve).toBe(false);
  expect(buildVerdict([said("yeah go ahead")], justAsked)?.approve).toBe(true);
  expect(buildVerdict([said("not now")], justAsked)?.approve).toBe(false);
  // More than the answer leaves it waiting (it expires on its own): the safe side.
  expect(buildVerdict([said("not now, we're mid-review")], justAsked)).toBeNull();
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

test("negations, questions, and other sentences with the word don't approve anything (from Astra's review)", () => {
  for (const t of ["don't approve", "No, approve nothing", "Should we approve?", "I approve the navigation", "approve, and then put it next to the simulator", "do not approve that", "go ahead?"])
    expect([t, buildVerdict([said(t)], justAsked)]).toEqual([t, null]);
  expect(buildVerdict([said("JamSesh, approve.")], longAgo)?.approve).toBe(true);
  expect(buildVerdict([said("Okay, approve it")], longAgo)?.approve).toBe(true);
  expect(buildVerdict([said("Don't build it")], justAsked)?.approve).toBe(false);
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

// A recorded or "Ask" line goes to brain.direct(); the human verdict must decide there too, with no gateway.
test("direct (recorded) approvals decide waiting requests with the gateway down", async () => {
  const { config } = await import("../src/config");
  const { makeRoom } = await import("./bench");
  const prev = config.offline;
  config.offline = true;
  const room = makeRoom();
  try {
    const { hub } = room;
    const brain = hub.brain as any;
    const person = room.people.chey;
    const line = (text: string, saidAt?: number) =>
      hub.session.store.addEvent({ kind: "speech", authorType: "person", authorId: person.id, authorName: person.name, text, relevance: "work", data: { direct: true, recorded: true, ...(saidAt ? { saidAt } : {}) } });
    hub.session.updateSettings({ hostControl: true });

    // One shell request: a recorded "approve" runs it.
    const sh = hub.host.requestShell("true", "JamSesh");
    if (typeof sh === "string") throw new Error(sh);
    await brain.direct(line("approve"));
    expect(hub.host.pendingRequests()).toHaveLength(0);

    // Words that ended before the request was announced don't count.
    const early = hub.host.requestShell("true", "JamSesh");
    if (typeof early === "string") throw new Error(early);
    await brain.direct(line("approve", early.createdAt - 5_000));
    expect(hub.host.pendingRequests()).toHaveLength(1);

    // A deny from the recording decides it too.
    await brain.direct(line("deny", early.createdAt + 1_000));
    expect(hub.host.pendingRequests()).toHaveLength(0);

    // Two waiting: a bare "approve" decides neither; naming one decides only that one.
    const a = hub.host.request({ agentId: "a1", agentName: "Sam's Claude", ownerName: "Sam", repo: "https://github.com/octocat/Hello-World.git", branch: "master", command: "true" });
    const b = hub.host.request({ agentId: "a2", agentName: "Dana's Codex", ownerName: "Dana", repo: "https://github.com/octocat/Spoon-Knife.git", branch: "main", command: "true" });
    if (typeof a === "string" || typeof b === "string") throw new Error("request refused");
    await brain.direct(line("approve"));
    expect(hub.host.pendingRequests()).toHaveLength(2);
    await brain.direct(line("deny Sam's build"));
    expect(hub.host.pendingRequests().map((r: any) => r.id)).toEqual([b.id]);
    await new Promise((r) => setTimeout(r, 800)); // the approved `true` finishes and logs before the room's data dir goes
  } finally {
    room.stop();
    config.offline = prev;
  }
}, 30_000);
