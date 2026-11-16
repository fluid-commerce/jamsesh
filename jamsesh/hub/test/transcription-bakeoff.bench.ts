// The transcription bake-off (5.1, rerun for Parakeet v3): a benchmark, not a test (never run in CI).
// It speaks a synthetic proxy set with `say -o` (writes files, plays nothing), then sends every clip
// through the path a room line takes: Transcriber.transcribe with the room's vocabulary (hotwords
// for Parakeet, the prompt for whisper), the brain's hint, the clip's SNR and the room's names, then
// the correction pass. Each engine runs alone in the pool, on the same clips.
//
//   bun test/transcription-bakeoff.bench.ts --parakeet <folder with the v3 GGUF> \
//     --library <libtranscribe.dylib from app/build-transcribe.sh> \
//     --whisper-server <whisper-server> --whisper-model <ggml-large-v3-turbo-q5_0.bin> [--out <dir>]
//
// Prints word error rate (WER), listed-term recall and false insertions per engine and group, and
// writes every transcript to <out>/transcripts.json.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const need = (k: string) => arg(k) ?? (console.error(`missing ${k}`), process.exit(2));
const work = mkdtempSync(join(tmpdir(), "jam-bakeoff-"));
const out = arg("--out") ?? work;
Object.assign(process.env, {
  JAMSESH_HOME: join(work, "home"),
  JAMSESH_DATA: join(work, "home", "data"),
  JAMSESH_SILENT: "1",
  JAMSESH_OFFLINE: "1",
  JAMSESH_PARAKEET_DIR: need("--parakeet"),
  JAMSESH_TRANSCRIBE_LIBRARY: need("--library"),
  JAMSESH_WHISPER_SERVER: need("--whisper-server"),
  JAMSESH_WHISPER_MODEL: need("--whisper-model"),
});
const { Hub } = await import("../src/hub");
const { decodeWav, encodeWav, speechLevelDb } = await import("../src/audio/wav");

// ---- the room ----

const PEOPLE = ["Chey", "Britt", "Felipe", "Jonathan"];
const VOCABULARY = ["Chey: Shay, Shea, Shae", "Britt: Brit, Britton", "Passport", "FigCraft", "Fluid", "Mist", "bento", "parity", "left-hand nav"];
/** The listed terms scored for recall and false insertions (the brain's name, JamSesh, included). */
const TERMS = ["Chey", "Britt", "Felipe", "Jonathan", "JamSesh", "Passport", "FigCraft", "Fluid", "Mist", "bento", "parity", "left-hand nav"];

// ---- the proxy set ----

const EN = ["Samantha", "Daniel", "Karen", "Moira", "Rishi", "Tara", "Tessa", "Aman", "Eddy (English (US))", "Flo (English (US))", "Reed (English (US))", "Sandy (English (US))", "Shelley (English (US))", "Rocko (English (US))"];
/** Room lines: what was said (the reference). "Chey" is spoken "Shay", as people say it. */
const LINES = [
  "Chey, can you put the left-hand nav up on the big screen?",
  "Britt wants the bento grid on the Passport page by Friday.",
  "JamSesh, ask Felipe whether FigCraft exports the new icons.",
  "Jonathan, the parity report for Fluid is still missing two rows.",
  "Let's move the Mist settings into the left-hand nav.",
  "Felipe and Britt are pairing on the Passport checkout today.",
  "Chey said the bento layout looks better on mobile.",
  "JamSesh, summarize what Jonathan decided about parity.",
  "Can FigCraft open the Fluid theme file without breaking it?",
  "Britt, send the Mist build to Chey before lunch.",
  "The left-hand nav in Passport needs a search field.",
  "Jonathan wants FigCraft and Fluid to share one color palette.",
  "Felipe, check whether the bento cards keep parity with the web app.",
  "JamSesh, put the Mist roadmap next to the Passport roadmap.",
  "Chey and Jonathan will review the FigCraft release notes.",
  "We should ship the Fluid parity fixes before the bento redesign.",
  "Britt asked JamSesh to collapse the left-hand nav by default.",
  "Felipe, the Passport login is slower than it was last week.",
  "Mist needs the same onboarding as Fluid, Chey thinks.",
  "Jonathan, open FigCraft and show the bento components.",
  "Let's take five minutes and then look at the numbers again.",
  "The meeting moved to three o'clock because the room was booked.",
];
/** Lines with none of the room's words, but words that look or sound like them. */
const LOOKALIKES = [
  "Brett said the bread in Britain is better than ours.",
  "The shade on the patio was nice, so we stayed outside.",
  "Put the fig jam in the craft box on the second shelf.",
  "I missed the train this morning and had to walk.",
  "Your password expires on Friday, so please change it.",
  "That parody was funny, and the parade was loud.",
  "He is fluent in Spanish and bent the rules a little.",
  "John and Nathan went to a jam session downtown.",
  "Philippe and Phil left early to catch the bus.",
];
/** Repeated words, some of them the room's. */
const REPEATS = [
  "Yes, yes, yes. We said yes to the plan, the whole plan.",
  "No no no, not that one, the other one.",
  "Go, go, go, we are late, late again.",
  "Britt, Britt, can you hear me?",
  "Okay okay, the nav, the nav is fine now.",
];
/** Other languages Parakeet v3 knows, with some of the room's words. */
const FOREIGN: [lang: string, voice: string, text: string][] = [
  ["de", "Anna", "Britt, kannst du die neue Version von FigCraft heute noch testen?"],
  ["de", "Anna", "Wir treffen uns morgen um zehn Uhr im großen Raum."],
  ["fr", "Thomas", "Felipe, peux-tu envoyer le rapport à Jonathan avant midi?"],
  ["fr", "Thomas", "La réunion est reportée à jeudi prochain."],
  ["es", "Mónica", "Britt quiere revisar el diseño de Passport esta tarde."],
  ["it", "Alice", "Jonathan, puoi aprire FigCraft sullo schermo grande?"],
  ["nl", "Xander", "Felipe, wil je de planning voor volgende week delen?"],
  ["pt", "Joana", "A equipa vai rever o relatório amanhã de manhã."],
  ["pl", "Zosia", "Britt, czy możesz wysłać plik do Jonathana?"],
  ["sv", "Alva", "Vi ses på mötet efter lunch i morgon."],
];

interface Clip {
  id: string;
  group: string;
  lang: string;
  ref: string;
  wav: Uint8Array;
  seconds: number;
}

// Seeded noise, so every run makes the same clips.
let seed = 20261113;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / Math.max(1, x.length));

function speak(text: string, voice: string, file: string): Float32Array {
  const said = Bun.spawnSync(["/usr/bin/say", "-v", voice, "-o", file, "--data-format=LEI16@16000", text.replace(/\bChey\b/g, "Shay")]);
  if (said.exitCode !== 0) throw new Error(`say -v ${voice}: ${said.stderr.toString()}`);
  return decodeWav(new Uint8Array(require("node:fs").readFileSync(file))).samples;
}
function pink(n: number) {
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = rand();
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    out[i] = b0 + b1 + b2 + w * 0.1848;
  }
  return out;
}
/** `x` plus `y` at `db` below `x`'s level (y repeated or cut to x's length). */
function mix(x: Float32Array, y: Float32Array, db: number) {
  const k = (rms(x) / Math.max(1e-9, rms(y))) * 10 ** (-db / 20);
  return x.map((v, i) => v + k * (y[i % y.length] ?? 0));
}
function echo(x: Float32Array) {
  const taps: [number, number][] = [[0.03, 0.5], [0.07, 0.35], [0.13, 0.25], [0.21, 0.15]];
  const out = new Float32Array(x.length + Math.round(0.25 * 16000));
  for (let i = 0; i < x.length; i++) {
    out[i] += x[i];
    for (const [s, g] of taps) out[i + Math.round(s * 16000)] += g * x[i];
  }
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  return peak > 0.99 ? out.map((v) => (v / peak) * 0.99) : out;
}
const pad = (x: Float32Array) => {
  const out = new Float32Array(x.length + 8000);
  out.set(x, 4000);
  return out;
};

function makeClips(): Clip[] {
  const clips: Clip[] = [];
  const dir = join(work, "say");
  mkdirSync(dir, { recursive: true });
  let n = 0;
  const add = (group: string, lang: string, ref: string, samples: Float32Array) => {
    const s = pad(samples).map((v) => Math.max(-1, Math.min(1, v)));
    clips.push({ id: `${group}-${++n}`, group, lang, ref, wav: encodeWav({ sampleRate: 16000, samples: s }), seconds: s.length / 16000 });
  };
  const voice = (i: number) => EN[i % EN.length];
  const say = (text: string, v: string) => speak(text, v, join(dir, `${n + 1}.wav`));
  // 22 clean, 10 with pink noise (10 dB under the voice), 9 with a second voice 18 dB down, 9 with room echo.
  LINES.forEach((l, i) => add("clean", "en", l, say(l, voice(i))));
  for (let i = 0; i < 10; i++) {
    const v = say(LINES[(i * 3) % LINES.length], voice(i + 5));
    add("noise", "en", LINES[(i * 3) % LINES.length], mix(v, pink(v.length), 10));
  }
  for (let i = 0; i < 9; i++) {
    const line = LINES[(i * 5 + 1) % LINES.length];
    const v = say(line, voice(i + 2));
    const other = say(LINES[20 + (i % 2)], voice(i + 9));
    add("second voice", "en", line, mix(v, other, 18));
  }
  for (let i = 0; i < 9; i++) {
    const line = LINES[(i * 7 + 2) % LINES.length];
    add("echo", "en", line, echo(say(line, voice(i + 7))));
  }
  LOOKALIKES.forEach((l, i) => add("look-alikes", "en", l, say(l, voice(i + 3))));
  REPEATS.forEach((l, i) => add("repeated words", "en", l, say(l, voice(i + 6))));
  for (const [lang, v, text] of FOREIGN) add("other languages", lang, text, say(text, v));
  // Nothing said: silence and steady noise.
  add("no speech", "en", "", new Float32Array(16000 * 3));
  add("no speech", "en", "", pink(16000 * 3).map((v) => v * 0.02));
  add("no speech", "en", "", pink(16000 * 3).map((v) => v * 0.1));
  return clips;
}

// ---- scoring ----

const norm = (s: string) => s.toLowerCase().replace(/[-‐]/g, " ").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/'(?!\p{L})|(?<!\p{L})'/gu, " ").split(/\s+/).filter(Boolean);
function editDistance(a: string[], b: string[]) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function count(words: string[], term: string[]) {
  let c = 0;
  for (let i = 0; i + term.length <= words.length; i++) if (term.every((t, k) => words[i + k] === t || words[i + k] === `${t}'s`)) c++;
  return c;
}
function score(ref: string, hyp: string) {
  const r = norm(ref);
  const h = norm(hyp);
  let terms = 0, found = 0, inserted = 0;
  for (const t of TERMS) {
    const tw = norm(t);
    const want = count(r, tw);
    const got = count(h, tw);
    terms += want;
    found += Math.min(want, got);
    inserted += Math.max(0, got - want);
  }
  return { errors: editDistance(r, h), words: r.length, terms, found, inserted };
}

// ---- run ----

const clips = makeClips();
console.error(`${clips.length} clips, ${clips.reduce((a, c) => a + c.seconds, 0).toFixed(0)} s`);
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(work, "hub") });
for (const p of PEOPLE) hub.session.upsertPerson({ name: p });
hub.session.updateSettings({ vocabulary: VOCABULARY, fastEngine: true, transcription: "local" });
const engines = (hub.transcriber as any).engines as Map<string, unknown>;
const port = (() => {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const p = s.port;
  s.stop(true);
  return p;
})();
const [fast, local] = await Promise.all([hub.transcriber.syncFastEngine(), Promise.resolve(hub.transcriber.startLocal(port))]);
for (let i = 0; i < 120 && !engines.has("local"); i++) await Bun.sleep(500);
if (!fast || !engines.has("parakeet")) throw new Error(`Parakeet didn't start: ${hub.transcriber.parakeet.status().detail}`);
if (!local && !engines.has("local")) throw new Error(`whisper didn't start: ${hub.transcriber.whisper.status().detail}`);
const all = new Map(engines);
const hint = "JamSesh.";
const names = PEOPLE;

type Row = { engine: string; group: string; errors: number; words: number; terms: number; found: number; inserted: number; ms: number[] };
const rows = new Map<string, Row>();
const transcripts: unknown[] = [];
for (const [engine, id] of [["Parakeet v3 (GPU, vocabulary)", "parakeet"], ["whisper large-v3-turbo (prompt)", "local"]] as const) {
  engines.clear();
  engines.set(id, all.get(id));
  for (const c of clips) {
    hub.session.updateSettings({ language: c.lang });
    const level = speechLevelDb(decodeWav(c.wav));
    const t = performance.now();
    const r = await hub.transcriber.transcribe(c.wav, c.seconds, hint, level.levelDb - level.noiseDb, names);
    const ms = performance.now() - t;
    if (r.engine === "none") throw new Error(`${engine} gave nothing for ${c.id}`);
    const s = score(c.ref, r.text);
    transcripts.push({ engine, clip: c.id, group: c.group, lang: c.lang, ref: c.ref, heard: r.text, ...s });
    for (const g of [c.group, "all"]) {
      const k = `${engine}\u0000${g}`;
      const row = rows.get(k) ?? { engine, group: g, errors: 0, words: 0, terms: 0, found: 0, inserted: 0, ms: [] };
      row.errors += s.errors;
      row.words += s.words;
      row.terms += s.terms;
      row.found += s.found;
      row.inserted += s.inserted;
      row.ms.push(ms);
      rows.set(k, row);
    }
  }
}
engines.clear();
for (const [k, v] of all) engines.set(k, v);
hub.stop();

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "transcripts.json"), JSON.stringify(transcripts, null, 1));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
console.log("| Engine | Group | Clips | WER | Term recall | False insertions | Median |");
console.log("|---|---|---|---|---|---|---|");
for (const r of rows.values()) {
  const wer = r.words ? `${((100 * r.errors) / r.words).toFixed(1)}%` : `${r.errors} words`;
  const recall = r.terms ? `${r.found}/${r.terms} (${Math.round((100 * r.found) / r.terms)}%)` : "-";
  console.log(`| ${r.engine} | ${r.group} | ${r.ms.length} | ${wer} | ${recall} | ${r.inserted} | ${Math.round(median(r.ms))} ms |`);
}
const pick = (e: string) => rows.get(`${e}\u0000all`)!;
const v3 = pick("Parakeet v3 (GPU, vocabulary)");
const w = pick("whisper large-v3-turbo (prompt)");
const werOf = (r: Row) => (100 * r.errors) / r.words;
const keep = werOf(v3) <= werOf(w) + 1 && v3.found / v3.terms >= w.found / w.terms && v3.inserted <= w.inserted;
console.log(`\nDecision rule (WER within 1 point, recall at least whisper's, no more false insertions): ${keep ? "Parakeet v3 stays the default" : "whisper is the default"}`);
if (!arg("--out")) rmSync(work, { recursive: true, force: true });
process.exit(0);
