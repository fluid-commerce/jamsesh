// 5.2: the host's transcriber (Parakeet), the room's vocabulary, the correction pass after any
// engine, and the fallbacks when the local engine is missing or failing.
import "./hear.env";
import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import { config } from "../src/config";
import { Parakeet, PARAKEET, findModel } from "../src/audio/parakeet";
import { buildVocabulary, cleanVocabulary, correctTranscript, hotwords, MAX_VOCAB, promptWith } from "../src/audio/vocabulary";
import { encodeWav } from "../src/audio/wav";

const ROOM = buildVocabulary({
  people: ["Chey", "Britt", "Felipe", "Jonathan", "Grace", "Mark"],
  agents: ["Felipe's Codex"],
  brain: ["JamSesh", "Computah"],
  custom: ["Chey: Shay, Shea", "Britt: Britton"],
  terms: ["Passport", "FigCraft", "Fluid", "Mist", "bento", "parity", "left-hand nav", "workstream", "payments"],
  workstreams: ["Storefront polish"],
});
const fix = (t: string) => correctTranscript(t, ROOM).text;

// ---- the correction pass ----

test("what the room said an engine writes instead is fixed, possessives too", () => {
  expect(fix("Shay, can you put the left hand nav up?")).toBe("Chey, can you put the left hand nav up?");
  expect(fix("send it to Shea's agent")).toBe("send it to Chey's agent");
  expect(fix("Britton wants the bento grid")).toBe("Britt wants the bento grid");
});

test("split, recased and near-miss names and coined words are fixed", () => {
  expect(fix("open jam sesh on the host")).toBe("open JamSesh on the host");
  expect(fix("jamsesh keeps listening")).toBe("JamSesh keeps listening");
  expect(fix("Jam Sish, what's next?")).toBe("JamSesh, what's next?");
  expect(fix("Fit craft can export it")).toBe("FigCraft can export it");
  expect(fix("Can Fitcraft render the canvas?")).toBe("Can FigCraft render the canvas?");
  expect(fix("Felippe said so")).toBe("Felipe said so");
  expect(correctTranscript("Jonathon is here", ROOM).fixes).toEqual([{ from: "Jonathon", to: "Jonathan" }]);
});

test("false positives: ordinary words stay as they were said", () => {
  const same = [
    "She said share the screen, not the whole desktop.",
    "Can you share that?",
    "Let's party once the parity list is done.",
    "Put it next to the old password screen.",
    "I missed the mist this morning.",
    "What grade did it get?",
    "Mark the line as done.",
    "Brett joined late.",
    "Jam says hello.",
    "The fluids are mixed.",
    "Fig, craft beer, and cheese.",
    "The checkout workstream is blocked.",
    "Rename the workstream to storefront polish.",
    "Payments are failing.",
    "",
  ];
  for (const t of same) expect(fix(t)).toBe(t);
});

test("a word that is itself in the vocabulary is never rewritten into another", () => {
  const both = buildVocabulary({ people: ["Jonathan", "Jonathon"] });
  expect(correctTranscript("Jonathon and Jonathan", both).text).toBe("Jonathon and Jonathan");
  // Two names equally close: ambiguous, so neither.
  const twins = buildVocabulary({ people: ["Marlena", "Marlene"] });
  expect(correctTranscript("Marlenx said", twins).text).toBe("Marlenx said");
});

test("the vocabulary merges sources, caps its size, and takes only clean strings", () => {
  const v = buildVocabulary({ people: ["chey", "Chey", "", "x"], custom: ["Chey: Shay, , Shay", 42 as any, "Mist: missed"], terms: Array.from({ length: 400 }, (_, i) => `Term${i}`) });
  expect(v.length).toBe(MAX_VOCAB);
  const chey = v.find((e) => e.term.toLowerCase() === "chey")!;
  expect(chey.heard).toEqual(["Shay"]);
  expect(chey.proper).toBe(true);
  // An ordinary word in the list is only fixed from what the room listed, never fuzzily.
  // An everyday word the room listed as heard-as is rewritten only where it reads as the name.
  expect(correctTranscript("I missed it", v).text).toBe("I missed it");
  expect(correctTranscript("Missed the bus again.", v).text).toBe("Missed the bus again.");
  expect(correctTranscript("Missed, can you put the nav up?", v).text).toBe("Mist, can you put the nav up?");
  expect(correctTranscript("Thanks, missed.", v).text).toBe("Thanks, Mist.");
  expect(correctTranscript("Ask Missed about it", v).text).toBe("Ask Mist about it");
  // A heard-as the room wrote with a capital ("Shay") is fixed wherever the engine writes it that way, not in lowercase.
  const named = buildVocabulary({ people: ["Chey"], custom: ["Chey: Shay"] });
  expect(correctTranscript("Shay is sharing", named).text).toBe("Chey is sharing");
  expect(correctTranscript("the shay by the door", named).text).toBe("the shay by the door");
  expect(cleanVocabulary(["  Chey:  Shay ", "chey: shay", 7, "", "x".repeat(500)])).toEqual(["Chey: Shay", "x".repeat(160)]);
  expect(cleanVocabulary("FigCraft\nJamSesh")).toEqual(["FigCraft", "JamSesh"]);
  expect(cleanVocabulary({ evil: true })).toEqual([]);
});

test("hotwords and the whisper prompt can't be steered by what's in a name", () => {
  const v = buildVocabulary({ people: ["Ann/ice:9.0", "Bob"] });
  const h = hotwords(v);
  expect(h.split("/")).toEqual(["Ann ice 9.0", "ann ice 9.0", "Bob", "bob"]);
  const long = buildVocabulary({ terms: Array.from({ length: 200 }, (_, i) => `Word${i}`) });
  expect(promptWith("JamSesh.", long).length).toBeLessThanOrEqual(502);
  expect(promptWith("JamSesh.", buildVocabulary({ brain: ["JamSesh"] }))).toBe("JamSesh.");
});

// ---- the engine pool ----

const dir = join(tmpdir(), `jam-hear-${Date.now()}`);
const hubs: Hub[] = [];
const servers: { stop(force?: boolean): void }[] = [];
afterAll(() => {
  for (const h of hubs) h.stop();
  for (const s of servers) s.stop(true);
  rmSync(dir, { recursive: true, force: true });
  rmSync(config.home, { recursive: true, force: true });
});

function room() {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())) });
  hubs.push(hub);
  hub.session.upsertPerson({ name: "Chey" });
  hub.session.upsertPerson({ name: "Britt" });
  hub.session.updateSettings({ vocabulary: ["Chey: Shay", "Passport", "FigCraft"] });
  return hub;
}

/** A fake engine that records what it was sent and answers with `reply` (or fails). */
function fakeEngine(reply: string | (() => Response)) {
  const seen: Record<string, string>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const form = await req.formData();
      seen.push(Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string")) as Record<string, string>);
      return typeof reply === "string" ? Response.json({ text: reply }) : reply();
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

const engines = (hub: Hub) => (hub.transcriber as any).engines as Map<string, any>;
const addParakeet = (hub: Hub, url: string) => engines(hub).set("parakeet", { id: "parakeet", label: "host Parakeet", kind: "parakeet", url, inflight: 0, failures: 0, lastOk: Date.now() });
const clip = encodeWav({ sampleRate: 16000, samples: new Float32Array(16000 * 2) });

test("Parakeet goes first with the room's hotwords; the text is corrected", async () => {
  const hub = room();
  const p = fakeEngine("Shay, put the passport menu up");
  const w = fakeEngine("whisper heard it");
  addParakeet(hub, p.url);
  hub.transcriber.addWorker("laptop", "Britt's whisper", w.url);
  const r = await hub.transcriber.transcribe(clip, 2, "JamSesh.");
  expect(r).toEqual({ text: "Chey, put the passport menu up", engine: "host Parakeet" });
  expect(w.seen.length).toBe(0);
  const hot = p.seen[0].hotwords.split("/");
  for (const word of ["Chey", "Britt", "JamSesh", "Passport", "FigCraft"]) expect(hot).toContain(word);
  expect(p.seen[0].prompt).toBeUndefined();
});

test("whisper gets the vocabulary as its prompt; Parakeet is skipped for other languages", async () => {
  const hub = room();
  const p = fakeEngine("never");
  const w = fakeEngine("Fitcraft is open");
  addParakeet(hub, p.url);
  hub.transcriber.addWorker("laptop", "Britt's whisper", w.url);
  hub.session.updateSettings({ language: "auto" });
  const r = await hub.transcriber.transcribe(clip, 2, "JamSesh.");
  expect(r).toEqual({ text: "FigCraft is open", engine: "Britt's whisper" });
  expect(p.seen.length).toBe(0);
  expect(w.seen[0].prompt).toStartWith("JamSesh. ");
  expect(w.seen[0].prompt).toContain("Chey");
  expect(w.seen[0].language).toBe("auto");
});

test("a failing Parakeet falls through to whisper, and stops being asked after three failures", async () => {
  const hub = room();
  const p = fakeEngine(() => new Response("boom", { status: 500 }));
  const w = fakeEngine("Shay is sharing");
  addParakeet(hub, p.url);
  hub.transcriber.addWorker("laptop", "whisper", w.url);
  for (let i = 0; i < 4; i++) expect((await hub.transcriber.transcribe(clip, 2)).text).toBe("Chey is sharing");
  expect(p.seen.length).toBe(3);
  expect(hub.transcriber.engineList().find((e) => e.id === "parakeet")?.healthy).toBe(false);
});

/** The gateway exists only when the hub isn't offline (tests are); these tests stub the call itself. */
async function online(run: () => Promise<void>) {
  config.offline = false;
  try {
    await run();
  } finally {
    config.offline = true;
  }
}

test("with no local engine, the cloud transcribes with the same words and the same correction", () => online(async () => {
  const hub = room();
  hub.session.updateSettings({ gatewayKey: "test-key" });
  const calls: string[] = [];
  (hub.transcriber as any).cloud = async (_wav: Uint8Array, prompt: string) => (calls.push(prompt), "Shay opened jam sesh");
  const r = await hub.transcriber.transcribe(clip, 2, "JamSesh.");
  expect(r).toEqual({ text: "Chey opened JamSesh", engine: "gateway" });
  expect(calls[0]).toContain("Chey");
  expect(calls[0]).toContain("Passport");
  // A dead Parakeet engine is skipped on the way to the cloud.
  addParakeet(hub, "http://127.0.0.1:9");
  expect((await hub.transcriber.transcribe(clip, 2)).engine).toBe("gateway");
}));

test("local only, with nothing running: silence and a reason, never the cloud", () => online(async () => {
  const hub = room();
  hub.session.updateSettings({ transcription: "local", gatewayKey: "test-key" });
  let cloud = 0;
  (hub.transcriber as any).cloud = async () => (cloud++, "nope");
  expect(await hub.transcriber.transcribe(clip, 2)).toEqual({ text: "", engine: "none" });
  expect(cloud).toBe(0);
  expect(hub.transcriber.problem()).toContain("no speech model is running on this host");
}));

test("a line made only of the room's words is the engine's invention on noise", async () => {
  const hub = room();
  addParakeet(hub, fakeEngine("Passport, passport, FigCraft.").url);
  expect((await hub.transcriber.transcribe(clip, 3, "", 5)).text).toBe("");
});

test("people's words reach the vocabulary through Settings; agents can't change it", async () => {
  const hub = room();
  const server = startHttp(hub, 0);
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const window = { cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}`, "content-type": "application/json" };
  const set = await fetch(`${base}/api/settings`, { method: "POST", headers: window, body: JSON.stringify({ vocabulary: ["Felipe: Philippe", "Mist", 3] }) });
  expect(set.status).toBe(200);
  expect(((await set.json()) as any).vocabulary).toEqual(["Felipe: Philippe", "Mist"]);
  const agent = hub.auth.issue({ kind: "agent", label: "Agents on Mac", ip: "10.0.0.5", ownerDeviceId: "dev_mac0" });
  const denied = await fetch(`${base}/api/settings`, { method: "POST", headers: { "x-forwarded-for": "9.9.9.9", "content-type": "application/json", authorization: `Bearer ${agent.token}` }, body: JSON.stringify({ vocabulary: ["Chey: everyone"] }) });
  expect(denied.status).toBe(403);
  const engines = (await (await fetch(`${base}/api/engines`, { headers: window })).json()) as any;
  expect(engines.vocabulary).toEqual(expect.arrayContaining(["Chey", "Britt", "JamSesh", "Felipe", "Mist"]));
  expect(engines.speechModel).toMatchObject({ engine: PARAKEET.label, installed: false, sizeMb: 482 });
  expect(JSON.stringify(engines.speechModel)).not.toContain(config.home);
});

// ---- the faster engine is opt-in ----

/** Fetch that answers the model download itself and passes everything else through. */
function interceptDownload(answer: () => Response) {
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = ((url: any, init?: any) => (String(url) === PARAKEET.url ? (asked.push(String(url)), Promise.resolve(answer())) : real(url, init))) as typeof fetch;
  return { asked, restore: () => (globalThis.fetch = real) };
}

test("by default whisper is the engine: nothing is downloaded and the faster engine says it's off", () => online(async () => {
  const hub = room();
  const net = interceptDownload(() => new Response("never", { status: 500 }));
  try {
    expect(hub.session.settings().fastEngine).toBe(false);
    expect(await hub.transcriber.syncFastEngine()).toBe(false);
    expect(net.asked).toEqual([]);
    expect(hub.transcriber.parakeet.status()).toMatchObject({ state: "off", progress: null });
  } finally {
    net.restore();
  }
}));

test("turning it on in Settings starts the download (host only); turning it off stops it and drops the engine", () => online(async () => {
  const hub = room();
  const server = startHttp(hub, 0);
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const window = { cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}`, "content-type": "application/json" };
  const net = interceptDownload(() => new Response("gone", { status: 404 }));
  try {
    const laptop = hub.auth.issue({ kind: "browser", label: "Laptop", ip: "10.0.0.7", personId: hub.session.personByName("Britt")!.id });
    const remote = await fetch(`${base}/api/settings`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.7", authorization: `Bearer ${laptop.token}` }, body: JSON.stringify({ fastEngine: true }) });
    expect(remote.status).toBe(403);
    expect(hub.session.settings().fastEngine).toBe(false);
    const on = await fetch(`${base}/api/settings`, { method: "POST", headers: window, body: JSON.stringify({ fastEngine: true }) });
    expect(on.status).toBe(200);
    for (let i = 0; i < 50 && hub.transcriber.parakeet.status().state !== "failed"; i++) await Bun.sleep(20);
    expect(net.asked).toEqual([PARAKEET.url]);
    expect(hub.transcriber.parakeet.status().detail).toBe("Couldn't download the speech model: HTTP 404.");
    // A junk value is off, not on.
    hub.session.updateSettings({ fastEngine: "yes" as any });
    expect(hub.session.settings().fastEngine).toBe(false);
    // Off again: a running engine leaves the pool and whisper takes the lines.
    hub.session.updateSettings({ fastEngine: true });
    addParakeet(hub, fakeEngine("never").url);
    const w = fakeEngine("Shay is here");
    hub.transcriber.addWorker("laptop", "whisper", w.url);
    await fetch(`${base}/api/settings`, { method: "POST", headers: window, body: JSON.stringify({ fastEngine: false }) });
    await Bun.sleep(20);
    expect(engines(hub).has("parakeet")).toBe(false);
    expect(hub.transcriber.parakeet.status().state).toBe("off");
    expect((await hub.transcriber.transcribe(clip, 2)).text).toBe("Chey is here");
  } finally {
    net.restore();
  }
}));

test("whisper's own invention on noise is dropped too when it's made only of the room's words", async () => {
  const hub = room();
  hub.transcriber.addWorker("laptop", "whisper", fakeEngine("Chey, FigCraft, Passport.").url);
  expect((await hub.transcriber.transcribe(clip, 3, "JamSesh.", 5)).text).toBe("");
});

// ---- the model and its process ----

test("no model and no download: the status says so, nothing starts", async () => {
  const p = new Parakeet();
  expect(await p.start(false)).toBeNull();
  expect(p.status()).toMatchObject({ state: "missing", installed: false });
  process.env.JAMSESH_PARAKEET = "0";
  expect(await new Parakeet().start(true)).toBeNull();
  delete process.env.JAMSESH_PARAKEET;
});

test("a download that doesn't match the pinned checksum is refused and leaves nothing behind", async () => {
  const real = globalThis.fetch;
  let asked = "";
  globalThis.fetch = (async (url: string) => ((asked = String(url)), new Response(new Uint8Array(1000)))) as unknown as typeof fetch;
  try {
    const p = new Parakeet();
    expect(await p.start(true)).toBeNull();
    expect(asked).toBe(PARAKEET.url);
    expect(p.status().state).toBe("failed");
    expect(p.status().detail).toContain("checksum");
  } finally {
    globalThis.fetch = real;
  }
  const models = join(config.home, "models");
  expect(existsSync(models) ? readdirSync(models) : []).toEqual([]);
  expect(findModel()).toBeNull();
});

test("a download that matches its checksum is unpacked into the models folder, with nothing left over", async () => {
  const work = join(dir, "archive");
  const inner = join(work, `sherpa-onnx-nemo-${PARAKEET.name}`);
  Bun.spawnSync(["mkdir", "-p", inner]);
  for (const f of [...PARAKEET.files, "README.md"]) await Bun.write(join(inner, f), `fake ${f}`);
  const tar = join(dir, "model.tar.bz2");
  Bun.spawnSync(["tar", "-cjf", tar, "-C", work, `sherpa-onnx-nemo-${PARAKEET.name}`]);
  const bytes = new Uint8Array(await Bun.file(tar).arrayBuffer());
  const pinned = { sha256: PARAKEET.sha256, bytes: PARAKEET.bytes };
  Object.assign(PARAKEET, { sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), bytes: bytes.length });
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(bytes)) as unknown as typeof fetch;
  try {
    const p = new Parakeet();
    const got = await (p as any).download();
    expect(got).toBe(join(config.home, "models", PARAKEET.name));
    expect(findModel()).toBe(got);
    expect(p.status().progress).toBe(100);
    expect(readdirSync(join(config.home, "models"))).toEqual([PARAKEET.name]);
  } finally {
    globalThis.fetch = real;
    Object.assign(PARAKEET, pinned);
    rmSync(join(config.home, "models"), { recursive: true, force: true });
  }
});

test("an interrupted download fails with a reason", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("gone", { status: 404 })) as unknown as typeof fetch;
  try {
    const p = new Parakeet();
    expect(await p.start(true)).toBeNull();
    expect(p.status()).toMatchObject({ state: "failed", detail: "Couldn't download the speech model: HTTP 404." });
  } finally {
    globalThis.fetch = real;
  }
});

// The real model, when this machine has it (JAMSESH_PARAKEET_DIR): a clip spoken with `say -o`
// (writes a file, plays nothing) goes through the child process and the correction pass.
const MODEL = process.env.JAMSESH_TEST_PARAKEET_DIR;
const canSay = existsSync("/usr/bin/say");
test.skipIf(!MODEL || !canSay)("end to end: Parakeet hears the room's words, and its process goes when the hub does", async () => {
  process.env.JAMSESH_PARAKEET_DIR = MODEL;
  const hub = room();
  const aiff = join(dir, "clip.aiff");
  const wav = join(dir, "clip.wav");
  Bun.spawnSync(["/usr/bin/say", "-o", aiff, "-v", "Samantha", "Shay, put JamSesh and FigCraft on the big screen."]);
  Bun.spawnSync(["ffmpeg", "-loglevel", "quiet", "-y", "-i", aiff, "-ar", "16000", "-ac", "1", wav]);
  hub.session.updateSettings({ fastEngine: true });
  expect(await hub.transcriber.syncFastEngine()).toBe(true);
  expect(hub.transcriber.parakeet.status()).toMatchObject({ state: "ready", installed: true });
  const r = await hub.transcriber.transcribe(new Uint8Array(await Bun.file(wav).arrayBuffer()), 3.5, "JamSesh.");
  expect(r.engine).toBe("host Parakeet");
  expect(r.text).toContain("Chey");
  expect(r.text).toContain("JamSesh");
  expect(r.text).toContain("FigCraft");
  // The child refuses what isn't a WAV, and a clip longer than a minute.
  const url = engines(hub).get("parakeet").url;
  const bad = new FormData();
  bad.append("file", new Blob(["not audio"]), "x.wav");
  expect((await fetch(`${url}/inference`, { method: "POST", body: bad })).status).toBe(400);
  const long = new FormData();
  long.append("file", new Blob([encodeWav({ sampleRate: 8000, samples: new Float32Array(8000 * 61) }) as Uint8Array<ArrayBuffer>]), "x.wav");
  expect((await fetch(`${url}/inference`, { method: "POST", body: long })).status).toBe(413);
  // A crashed model process leaves the pool and says so.
  const proc = (hub.transcriber.parakeet as any).proc as ReturnType<typeof Bun.spawn>;
  proc.kill("SIGKILL");
  await proc.exited;
  await Bun.sleep(50);
  expect(engines(hub).has("parakeet")).toBe(false);
  expect(hub.transcriber.parakeet.status()).toMatchObject({ state: "failed" });
  expect(hub.transcriber.parakeet.status().detail).toContain("The speech model stopped");
  expect(await fetch(`${url}/inference`).catch(() => null)).toBeNull();
  // Started again, it stops with the hub.
  expect(await hub.transcriber.syncFastEngine()).toBe(true);
  const again = engines(hub).get("parakeet").url;
  hub.stop();
  await Bun.sleep(1000);
  expect(await fetch(`${again}/inference`).catch(() => null)).toBeNull();
  // Its stdin is the hub's pipe: closing it, which any death of the hub does, ends it too.
  const orphan = new Parakeet();
  expect(await orphan.start(false)).toStartWith("http://127.0.0.1:");
  const child = (orphan as any).proc as ReturnType<typeof Bun.spawn>;
  (child.stdin as import("bun").FileSink).end();
  expect(await Promise.race([child.exited, Bun.sleep(5000).then(() => "still running")])).toBe(0);
  delete process.env.JAMSESH_PARAKEET_DIR;
}, 60_000);

// ---- the host's whisper.cpp: bundled server, model downloaded once ----

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { findWhisperServer, findWhisperModel, LocalWhisper, WHISPER_MODEL } from "../src/audio/whisper";

const freePort = () => {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const p = s.port as number;
  s.stop(true);
  return p;
};

/** A stand-in whisper-server: a script that answers on --port like the real one. */
function fakeWhisperServer(where: string) {
  mkdirSync(where, { recursive: true });
  const file = join(where, "whisper-server");
  writeFileSync(
    file,
    `#!/usr/bin/env bun
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const model = process.argv[process.argv.indexOf("-m") + 1];
Bun.serve({ hostname: "127.0.0.1", port, fetch: (r) => new URL(r.url).pathname === "/inference" ? Response.json({ text: "Shay used " + model.split("/").pop() }) : new Response("whisper") });
`,
  );
  chmodSync(file, 0o755);
  return file;
}

function withEnv(vars: Record<string, string | undefined>) {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  return () => {
    for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  };
}

test("whisper-server is found in order: a chosen path, the app bundle, ~/.jamsesh/bin, then Homebrew", () => {
  const root = join(dir, "find-bin");
  const res = join(root, "res");
  const restore = withEnv({ JAMSESH_RESOURCES: res, JAMSESH_WHISPER_SERVER: undefined });
  try {
    const brew = ["/opt/homebrew/bin/whisper-server", "/usr/local/bin/whisper-server"].find((p) => existsSync(p)) ?? null;
    expect(findWhisperServer()).toBe(brew);
    const own = fakeWhisperServer(join(config.home, "bin"));
    expect(findWhisperServer()).toBe(own);
    const bundled = fakeWhisperServer(join(res, "bin"));
    expect(findWhisperServer()).toBe(bundled);
    process.env.JAMSESH_WHISPER_SERVER = own;
    expect(findWhisperServer()).toBe(own);
  } finally {
    restore();
    rmSync(join(config.home, "bin"), { recursive: true, force: true });
  }
});

test("the model is found in order: a chosen file, ~/.jamsesh/models, then ~/.cache/whisper-cpp", () => {
  const home = join(dir, "find-model-home");
  const restore = withEnv({ HOME: home, JAMSESH_WHISPER_MODEL: undefined });
  try {
    expect(findWhisperModel()).toBeNull();
    const cache = join(home, ".cache", "whisper-cpp");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "ggml-base.en.bin"), "x");
    expect(findWhisperModel()).toBe(join(cache, "ggml-base.en.bin"));
    writeFileSync(join(cache, "ggml-large-v3-turbo-q5_0.bin"), "x");
    expect(findWhisperModel()).toBe(join(cache, "ggml-large-v3-turbo-q5_0.bin"));
    mkdirSync(join(config.home, "models"), { recursive: true });
    const own = join(config.home, "models", WHISPER_MODEL.name);
    writeFileSync(own, "x");
    expect(findWhisperModel()).toBe(own);
    process.env.JAMSESH_WHISPER_MODEL = join(cache, "ggml-base.en.bin");
    expect(findWhisperModel()).toBe(join(cache, "ggml-base.en.bin"));
  } finally {
    restore();
    rmSync(join(config.home, "models"), { recursive: true, force: true });
  }
});

test("first host session: the gateway covers the room while the model downloads, then whisper takes over", () => online(async () => {
  const home = join(dir, "first-session-home");
  const port = freePort();
  const restore = withEnv({ HOME: home, JAMSESH_WHISPER_MODEL: undefined, JAMSESH_WHISPER_SERVER: fakeWhisperServer(join(dir, "first-bin")), JAMSESH_WHISPER_PORT: String(port) });
  const body = new TextEncoder().encode("a small stand-in for the model");
  const pinned = { sha256: WHISPER_MODEL.sha256, bytes: WHISPER_MODEL.bytes };
  Object.assign(WHISPER_MODEL, { sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"), bytes: body.length });
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: any, init?: any) => (String(url) === WHISPER_MODEL.url ? (asked.push(String(url)), await held, new Response(body)) : real(url, init))) as typeof fetch;
  const hub = room();
  hub.session.updateSettings({ gatewayKey: "test-key" });
  (hub.transcriber as any).cloud = async () => "Shay from the cloud";
  try {
    expect(await hub.transcriber.startLocal()).toBe(false);
    for (let i = 0; i < 50 && hub.transcriber.whisper.status().state !== "downloading"; i++) await Bun.sleep(20);
    expect(hub.transcriber.whisper.status()).toMatchObject({ state: "downloading", progress: 0 });
    expect(hub.transcriber.problem()).toBeNull();
    expect((await hub.transcriber.transcribe(clip, 2)).engine).toBe("gateway");
    release();
    for (let i = 0; i < 100 && !engines(hub).has("local"); i++) await Bun.sleep(50);
    expect(asked).toEqual([WHISPER_MODEL.url]);
    expect(hub.transcriber.whisper.status()).toMatchObject({ state: "ready", installed: true });
    expect(readdirSync(join(config.home, "models"))).toEqual([WHISPER_MODEL.name]);
    expect(await hub.transcriber.transcribe(clip, 2)).toEqual({ text: `Chey used ${WHISPER_MODEL.name}`, engine: "host whisper.cpp" });
  } finally {
    hub.stop();
    globalThis.fetch = real;
    Object.assign(WHISPER_MODEL, pinned);
    restore();
    rmSync(join(config.home, "models"), { recursive: true, force: true });
  }
  await Bun.sleep(200);
  expect(await fetch(`http://127.0.0.1:${port}/`).catch(() => null)).toBeNull();
}));

test("a model download that fails its checksum leaves nothing, and offline never downloads", () => online(async () => {
  const restore = withEnv({ HOME: join(dir, "bad-home"), JAMSESH_WHISPER_MODEL: undefined, JAMSESH_WHISPER_SERVER: fakeWhisperServer(join(dir, "bad-bin")) });
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: any, init?: any) => (String(url) === WHISPER_MODEL.url ? (asked.push(String(url)), new Response("tampered")) : real(url, init))) as typeof fetch;
  try {
    const w = new LocalWhisper();
    expect(await w.start(freePort(), true)).toBeNull();
    expect(w.status()).toMatchObject({ state: "failed", detail: "The speech model download didn't match its checksum.", installed: false });
    const models = join(config.home, "models");
    expect(existsSync(models) ? readdirSync(models) : []).toEqual([]);
    const offline = new LocalWhisper();
    expect(await offline.start(freePort(), false)).toBeNull();
    expect(offline.status().state).toBe("missing");
    expect(asked.length).toBe(1);
  } finally {
    globalThis.fetch = real;
    restore();
  }
}));

test("a whisper-server already answering on the port is used, and left running when the hub stops", async () => {
  const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ text: "already here" }) });
  servers.push(other);
  const w = new LocalWhisper();
  expect(await w.start(other.port as number, false)).toBe(`http://127.0.0.1:${other.port}`);
  w.stop();
  expect((await fetch(`http://127.0.0.1:${other.port}/`)).status).toBe(200);
});
