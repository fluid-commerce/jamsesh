// The curator turns the event stream into durable knowledge (live, needs the gateway key).
//   cd jamsesh/hub && bun test test/brain.curate.test.ts --timeout 120000
import { expect, test } from "bun:test";
import { config } from "../src/config";
import { makeRoom } from "./bench";

const live = !!config.envGatewayKey && !config.offline;
const t = (live ? test : test.skip) as typeof test;

t("decisions, requirements and questions are curated; banter isn't; answers resolve; changes supersede", async () => {
  const r = makeRoom();
  const s = r.hub.session;
  const say = (who: "chey" | "jonathan" | "felipe" | "britain", text: string, relevance: any = "work") =>
    s.store.addEvent({ kind: "speech", authorType: "person", authorId: r.people[who].id, authorName: r.people[who].name, text, relevance });
  s.claim(r.agents.mobile.id, "Mobile settings");
  const batch1 = [
    say("jonathan", "lol did you see the game last night", "banter"),
    say("felipe", "Let's go with option A for the settings header, the big greeting, on both apps."),
    say("chey", "The greeting has to use the person's first name, never their email."),
    say("britain", "Do we have a dark version of the accent color? Nobody's defined it yet."),
    s.postUpdate(r.agents.mobile.id, "progress", "Mobile settings runs at http://192.168.1.20:5100; tokens live in theme/tokens.ts.", { workstream: "Mobile settings" }),
  ];
  await r.hub.brain.curate(batch1);
  // What curation proposes waits on the Tasks board; the room accepts it here.
  const accept = () => {
    for (const c of s.board.open()) c.conflictsWith ? s.board.replace(c.id, "Chey") : s.board.add(c.id, "Chey");
  };
  expect(s.facts().filter((f) => f.status === "active")).toHaveLength(0);
  accept();
  let facts = s.facts().filter((f) => f.status === "active");
  const has = (kind: string, re: RegExp) => facts.some((f) => f.kind === kind && re.test(f.text));
  console.log(facts.map((f) => `${f.kind}: ${f.text}`).join("\n"));
  expect(has("decision", /option a|greeting/i)).toBe(true);
  expect(has("requirement", /first name/i) || has("constraint", /first name/i)).toBe(true);
  expect(has("question", /dark/i)).toBe(true);
  expect(facts.some((f) => /game/i.test(f.text))).toBe(false);

  const batch2 = [
    say("britain", "Okay, dark accent is #E85A3A, I just added it to the tokens."),
    say("felipe", "Actually, change of plan: settings header goes with option B, the compact search, on desktop only."),
  ];
  await r.hub.brain.curate(batch2);
  accept();
  const all = s.facts();
  facts = all.filter((f) => f.status === "active");
  console.log("--- after\n" + all.map((f) => `${f.status} ${f.kind}: ${f.text}`).join("\n"));
  expect(all.some((f) => f.kind === "question" && /dark/i.test(f.text) && f.status === "resolved")).toBe(true);
  expect(facts.some((f) => /option b|compact/i.test(f.text))).toBe(true);
  // Nothing active may still say option A applies to desktop.
  expect(facts.some((f) => f.kind === "decision" && /option a/i.test(f.text) && /(both|desktop|all)/i.test(f.text) && !/mobile/i.test(f.text))).toBe(false);
  r.stop();
}, 120_000);
