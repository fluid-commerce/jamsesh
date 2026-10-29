// Measures how well a room of four voices on three laptops is labelled and de-duplicated, and prints
// the numbers. It uses only what the pipeline offered before 5.3 as well (so the same file measures
// the "before"), and asserts nothing about them beyond a sanity floor: voices.test.ts holds the rules.
import { expect, test } from "bun:test";
import { CAN_SIM, CAST, ENROL_TEXT, enrol, HOST, makeRoom, play, pct, rng, score, script, type Spoken, say, type Key } from "./voices.sim";

const SEEDS = [11, 12, 13];
const fmt = (s: ReturnType<typeof score>) => `Someone ${pct(s.someone, s.lines)}  right ${pct(s.right, s.lines)}  wrong ${pct(s.wrong, s.lines)}  duplicates ${s.dupes}  lost ${s.lost}`;
const sum = (xs: ReturnType<typeof score>[]) => xs.reduce((a, b) => ({ lines: a.lines + b.lines, right: a.right + b.right, wrong: a.wrong + b.wrong, someone: a.someone + b.someone, lost: a.lost + b.lost, dupes: a.dupes + b.dupes }));

async function run(opts: { enrolled?: boolean; fixes?: number; skewed?: boolean; leaves?: { key: Key; after: number } }) {
  const out: ReturnType<typeof score>[] = [];
  for (const seed of SEEDS) {
    const lines = script(seed, 8, undefined, opts.leaves);
    const room = makeRoom();
    if (opts.enrolled) for (const c of CAST) enrol(room, c.key);
    const r = rng(seed * 3);
    let fixed = 0;
    let from = 0;
    for (const [i, l] of lines.entries()) {
      await play(room, l, r, opts.skewed ? { skew: { "lap-b": 1500, "lap-c": -1300 }, textNoise: true } : {});
      if (opts.fixes && fixed < opts.fixes) {
        const u = room.session.store.all("utterances").find((x) => x.t0 < l.t1 + 1500 && x.t1 > l.t0 - 1500);
        if (u && u.personId !== room.people[l.speaker].id) (room.pipeline.assign(u.id, room.people[l.speaker].id, HOST), fixed++, (from = i + 1));
      }
    }
    // Judge everything after the last correction; the whole run when there were none.
    const judged = opts.fixes ? lines.slice(from) : opts.leaves ? lines.slice(opts.leaves.after) : lines;
    out.push(score(room, judged));
  }
  return sum(out);
}

test.skipIf(!CAN_SIM)("report", async () => {
  const rows: [string, Awaited<ReturnType<typeof run>>][] = [
    ["cold start, 3 runs of 32 lines     ", await run({})],
    ["after the join voice read          ", await run({ enrolled: true })],
    ["cold start, 3 corrections then rest", await run({ fixes: 3 })],
    ["laptops' clocks 1.5 s off          ", await run({ skewed: true })],
  ];
  for (const [name, s] of rows) console.log("REPORT", name, fmt(s));
  expect(rows[1][1].someone).toBeLessThanOrEqual(rows[0][1].someone);
}, 600000);
