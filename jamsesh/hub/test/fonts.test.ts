// Fonts for everyone (6.5): open fonts a repository names are fetched for every canvas, a font only one
// person has is borrowed once they confirm, and nothing is kept past the session. No real network: a stub
// stands in for Fontsource and its CDN.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forbiddenCommand } from "../src/canvas/canvas";
import { cardText, decodeBase64, FontService, fontCandidates, fontFamilies, lendMessage, MAX_FACE, MAX_FACES, normalizeFamily, readUpTo } from "../src/fonts";
import { bus } from "../src/bus";
import { Hub } from "../src/hub";
import { FONT_BODY_MAX, startHttp } from "../src/http";
import type { Agent } from "../src/types";

process.env.JAMSESH_SILENT = "1";

/** The smallest thing that reads as a TrueType font with these family names (structure only: no real outlines). */
export function makeFont(family: string | string[], opts: { pad?: number; mac?: boolean; noGlyphs?: boolean } = {}): Uint8Array<ArrayBuffer> {
  const names = Array.isArray(family) ? family : [family];
  const strings = names.map((n) => (opts.mac ? Buffer.from(n, "latin1") : Buffer.from(n, "utf16le").swap16()));
  const nameTable = Buffer.alloc(6 + 12 * names.length + strings.reduce((n, s) => n + s.length, 0));
  nameTable.writeUInt16BE(0, 0);
  nameTable.writeUInt16BE(names.length, 2);
  nameTable.writeUInt16BE(6 + 12 * names.length, 4);
  let at = 0;
  strings.forEach((s, i) => {
    const r = 6 + 12 * i;
    nameTable.writeUInt16BE(opts.mac ? 1 : 3, r);
    nameTable.writeUInt16BE(opts.mac ? 0 : 1, r + 2);
    nameTable.writeUInt16BE(opts.mac ? 0 : 0x409, r + 4);
    nameTable.writeUInt16BE(1, r + 6);
    nameTable.writeUInt16BE(s.length, r + 8);
    nameTable.writeUInt16BE(at, r + 10);
    s.copy(nameTable, 6 + 12 * names.length + at);
    at += s.length;
  });
  const tables: [string, Buffer][] = [["cmap", Buffer.alloc(4)], ["head", Buffer.alloc(54)], [opts.noGlyphs ? "post" : "glyf", Buffer.alloc(8 + (opts.pad ?? 0))], ["name", nameTable]];
  const head = Buffer.alloc(12 + 16 * tables.length);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt16BE(tables.length, 4);
  let off = head.length;
  tables.forEach(([tag, data], i) => {
    head.write(tag, 12 + 16 * i, "latin1");
    head.writeUInt32BE(off, 12 + 16 * i + 8);
    head.writeUInt32BE(data.length, 12 + 16 * i + 12);
    off += data.length;
  });
  return new Uint8Array(Buffer.concat([head, ...tables.map(([, d]) => d)]));
}
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

// ---------- reading a font file ----------

test("a font file's family names are read in any language, and a non-font is refused", () => {
  expect(fontFamilies(makeFont("Space Grotesk"))).toEqual(["Space Grotesk"]);
  expect(fontFamilies(makeFont(["Helvetica Neue", "Helvetica Neue Light"]))).toEqual(["Helvetica Neue", "Helvetica Neue Light"]);
  expect(fontFamilies(makeFont("Hiragino", { mac: true }))).toEqual(["Hiragino"]);
  expect(fontFamilies(new Uint8Array([1, 2, 3]))).toBeNull();
  expect(fontFamilies(new Uint8Array(0))).toBeNull();
  expect(fontFamilies(makeFont("No Outlines", { noGlyphs: true }))).toBeNull();
  // Lies about its own size: a table that runs past the end.
  const cut = makeFont("Cut Off");
  expect(fontFamilies(cut.subarray(0, cut.length - 6))).toBeNull();
  // A page of HTML, a PNG, a zip.
  for (const junk of ["<html></html>", "\x89PNG\r\n\x1a\n", "PK\x03\x04"]) expect(fontFamilies(new TextEncoder().encode(junk.padEnd(200, "x")))).toBeNull();
});

test("base64 is read strictly and within the cap", () => {
  expect(decodeBase64(b64(new Uint8Array([1, 2, 3, 4])), 10)).toEqual(new Uint8Array([1, 2, 3, 4]));
  expect(decodeBase64("not base64!!", 100)).toBeNull();
  expect(decodeBase64("AAA", 100)).toBeNull();
  expect(decodeBase64("", 100)).toBeNull();
  expect(decodeBase64(b64(new Uint8Array(50)), 10)).toBeNull();
  expect(decodeBase64(12 as any, 10)).toBeNull();
});

// ---------- which fonts a repository names ----------

test("font names are found in how a card talks about its design system", () => {
  const found = (t: string) => fontCandidates(t);
  expect(found("Tokens in src/theme.ts. font-family: \"Inter\", system-ui, sans-serif; accent #5b3df5")).toContain("Inter");
  expect(found("fontFamily: 'Space Grotesk' for headings")).toContain("Space Grotesk");
  expect(found("Typography: Fraunces for display, Inter for body")).toEqual(expect.arrayContaining(["Fraunces", "Inter"]));
  expect(found("Uses `DM Sans` as its typeface")).toContain("DM Sans");
  expect(found("Fonts: Lora and Source Sans 3")).toEqual(expect.arrayContaining(["Lora", "Source Sans 3"]));
  expect(found("Inter (body), Playfair Display (headings)")).toEqual(expect.arrayContaining(["Inter", "Playfair Display"]));
  // Generic families aren't names; prose without a cue names nothing.
  expect(found("font-family: sans-serif")).toEqual([]);
  expect(found("The checkout flow uses Stripe and Redux")).toEqual([]);
  expect(cardText({ card: undefined })).toBe("");
});

// ---------- a stand-in for Fontsource ----------

const OFL = "OFL-1.1";
let stub: ReturnType<typeof Bun.serve>;
let hits: string[] = [];
let api = "";
let cdn = "";
let google: { googleCss: string; googleHost: string } = { googleCss: "", googleHost: "" };
const catalogue = [
  { id: "inter", family: "Inter", license: OFL, type: "google", styles: ["normal", "italic"], weights: [400, 700], defSubset: "latin" },
  { id: "roboto-slab", family: "Roboto Slab", license: "Apache-2.0", type: "google", styles: ["normal"], weights: [400, 700], defSubset: "latin" },
  { id: "ubuntu", family: "Ubuntu", license: "UFL-1.0", type: "google", styles: ["normal"], weights: [400], defSubset: "latin" },
  { id: "lookalike", family: "Lookalike", license: OFL, type: "google", styles: ["normal"], weights: [400], defSubset: "latin" },
  { id: "broken", family: "Broken Sans", license: OFL, type: "google", styles: ["normal"], weights: [400], defSubset: "latin" },
  { id: "huge", family: "Huge Display", license: OFL, type: "google", styles: ["normal"], weights: [400], defSubset: "latin" },
  { id: "elsewhere", family: "Elsewhere", license: OFL, type: "google", styles: ["normal"], weights: [400], defSubset: "latin" },
];
beforeAll(() => {
  stub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      hits.push(path);
      if (path === "/v1/fonts") return Response.json(catalogue);
      const meta = path.match(/^\/v1\/fonts\/([\w-]+)$/);
      if (meta) {
        const e = catalogue.find((c) => c.id === meta[1]);
        if (!e) return new Response("no", { status: 404 });
        const face = (w: string, s: string) => ({ url: { ttf: e.id === "elsewhere" ? "http://evil.example/x.ttf" : `${cdn}${e.id}-${w}-${s}.ttf` } });
        return Response.json({ id: e.id, defSubset: "latin", variants: { "400": { normal: { latin: face("400", "normal") }, italic: { latin: face("400", "italic") } }, "700": { normal: { latin: face("700", "normal") } } } });
      }
      const bytes = (id: string, family: string) => {
        if (id === "ubuntu") return new Response("no", { status: 404 });
        if (id === "broken") return new Response("<html>not a font</html>");
        if (id === "lookalike") return new Response(makeFont("Somebody Else"));
        if (id === "huge") return new Response(makeFont("Huge Display", { pad: MAX_FACE + 10 }));
        return new Response(makeFont(family));
      };
      const file = path.match(/^\/(?:cdn|gstatic)\/([\w-]+)-(\d+)(?:-\w+)?\.ttf$/);
      if (file) {
        const e = catalogue.find((c) => c.id === file[1]);
        return e ? bytes(e.id, e.family) : new Response("no", { status: 404 });
      }
      // Google Fonts' stylesheet: Inter is unknown to it (so Fontsource has to supply it), Elsewhere points off its host.
      if (path === "/g/css2") {
        const family = (new URL(req.url).searchParams.get("family") ?? "").split(":")[0];
        const e = catalogue.find((c) => c.family === family);
        if (!e || e.id === "inter") return new Response("no", { status: 400 });
        const src = (w: number) => `@font-face { font-family: '${e.family}'; font-weight: ${w}; src: url(${e.id === "elsewhere" ? "http://evil.example/x.ttf" : `http://127.0.0.1:${stub.port}/gstatic/${e.id}-${w}.ttf`}) format('truetype'); }`;
        return new Response([400, 700].map(src).join("\n"));
      }
      return new Response("no", { status: 404 });
    },
  });
  api = `http://127.0.0.1:${stub.port}/v1`;
  cdn = `http://127.0.0.1:${stub.port}/cdn/`;
  google = { googleCss: `http://127.0.0.1:${stub.port}/g/css2`, googleHost: `http://127.0.0.1:${stub.port}/gstatic/` };
});
afterAll(() => stub.stop(true));

const agentWith = (designSystem: string, status: Agent["status"] = "working"): Agent => ({ id: "a1", status, card: { stack: "React", designSystem, components: "", branch: "main", recentChanges: "", notes: "", updatedAt: 1 } }) as Agent;
const service = (agents: Agent[] = [], opts: { offline?: boolean } = {}) => new FontService(() => agents, (id) => ({ p1: "Dana", p2: "Lee" })[id], { api, cdn, ...google, offline: opts.offline ?? false });

// ---------- open fonts ----------

test("a repo card's open fonts are fetched once, with their licence, and nothing else is", async () => {
  hits = [];
  const fonts = service([agentWith("font-family: \"Inter\", sans-serif; headings in Roboto Slab; Ubuntu for code; typeface Stripe Sans")]);
  const faces: string[] = [];
  fonts.onFace = (family) => faces.push(family);
  const got = await fonts.scan();
  expect(got.sort()).toEqual(["Inter", "Roboto Slab"]);
  const s = fonts.state();
  s.available.sort((a, b) => a.family.localeCompare(b.family));
  expect(s.available.map((f) => [f.family, f.kind, f.license])).toEqual([["Inter", "open", OFL], ["Roboto Slab", "open", "Apache-2.0"]]);
  // Google Fonts first; Fontsource for what Google doesn't answer for.
  expect(s.available.map((f) => [f.source, f.faces])).toEqual([["Google Fonts via Fontsource", 3], ["Google Fonts", 2]]);
  expect(faces.length).toBe(5);
  // The Ubuntu Font Licence isn't one of the two taken without asking: never fetched.
  expect(hits.some((h) => h.includes("ubuntu"))).toBe(false);
  // The same card again costs nothing.
  hits = [];
  await fonts.scan();
  expect(hits).toEqual([]);
  // The state carries names and counts, never the bytes.
  expect(JSON.stringify(s)).not.toContain("data");
  expect(fonts.face("inter", 0)?.length).toBeGreaterThan(50);
  expect(fonts.face("inter", 9)).toBeNull();
  expect(fonts.face("nothing", 0)).toBeNull();
});

test("an offline agent's card is not read, and an offline hub never goes out to the network", async () => {
  hits = [];
  expect(await service([agentWith("font-family: \"Inter\"", "offline")]).scan()).toEqual([]);
  expect(await service([agentWith("font-family: \"Inter\"")], { offline: true }).scan()).toEqual([]);
  expect(hits).toEqual([]);
});

test("a download that isn't the family it says is dropped: not a font, someone else's font, over the size cap, off the CDN", async () => {
  const fonts = service();
  for (const family of ["Broken Sans", "Lookalike", "Huge Display", "Elsewhere", "Ubuntu", "Not In The Catalogue"]) {
    await fonts.want("p1", [family]);
    expect(fonts.has(family)).toBe(false);
  }
  // None of them is open, so each is asked for from the room instead.
  expect(fonts.state().wanted.map((w) => w.family).sort()).toEqual(["Broken Sans", "Elsewhere", "Huge Display", "Lookalike", "Not In The Catalogue", "Ubuntu"]);
});

test("the catalogue being unreachable asks the room rather than failing, and is tried again later", async () => {
  const down = new FontService(() => [], () => undefined, { api: "http://127.0.0.1:9/v1", cdn, googleCss: "http://127.0.0.1:9/g", googleHost: "http://127.0.0.1:9/", offline: false });
  await down.want("p1", ["Inter"]);
  expect(down.state().wanted.map((w) => w.family)).toEqual(["Inter"]);
  expect(down.state().available).toEqual([]);
});

test("a canvas asking for an open font that no card named gets it too", async () => {
  const fonts = service();
  await fonts.want("p1", ["inter"]);
  expect(fonts.state().available.map((f) => f.family)).toEqual(["Inter"]);
  expect(fonts.state().wanted).toEqual([]);
});

// ---------- borrowing a font one person has ----------

test("a font nobody can fetch is asked for, lent after a confirmation, and served to everyone", async () => {
  const fonts = service();
  let loaded = 0;
  fonts.onFace = () => loaded++;
  await fonts.want("p2", ["Helvetica Neue"]);
  await fonts.want("p1", ["helvetica  neue"]);
  const w = fonts.state().wanted;
  expect(w.length).toBe(1);
  expect(w[0].askedBy.sort()).toEqual(["p1", "p2"]);
  const r = fonts.lend("p1", "Helvetica Neue", [b64(makeFont(["Helvetica Neue", "Helvetica Neue Light"]))]);
  expect(r).toEqual({ ok: true });
  const s = fonts.state();
  expect(s.wanted).toEqual([]);
  expect(s.available[0]).toMatchObject({ family: "Helvetica Neue", kind: "borrowed", lender: "Dana", lenderId: "p1", license: null, faces: 1 });
  expect(loaded).toBe(1);
  expect(fonts.has("HELVETICA NEUE")).toBe(true);
  // A second person who also had it doesn't replace it.
  expect(fonts.lend("p2", "Helvetica Neue", [b64(makeFont("Helvetica Neue"))])).toEqual({ ok: true, already: true });
  expect(fonts.state().available[0].lender).toBe("Dana");
});

test("declining is remembered and leaves the font unavailable", async () => {
  const fonts = service();
  await fonts.want("p2", ["Gotham"]);
  expect(fonts.decline("p1", "Gotham")).toBe(true);
  expect(fonts.decline("p1", "Gotham")).toBe(true);
  expect(fonts.state().wanted[0].declinedBy).toEqual(["p1"]);
  expect(fonts.state().available).toEqual([]);
  // Declining a font nobody asked for is not an error, and records nothing.
  expect(fonts.decline("p1", "Papyrus")).toBe(false);
});

test("a lend that is not allowed changes nothing: nobody asked, wrong family, damaged, not a font, too big, too many", async () => {
  const fonts = service();
  const lend = (family: unknown, files: unknown) => fonts.lend("p1", family, files);
  // Nobody is waiting for it: a person can't push a font into the session.
  expect(lend("Gotham", [b64(makeFont("Gotham"))])).toMatchObject({ ok: false, status: 409 });
  await fonts.want("p2", ["Gotham"]);
  expect(lend("Gotham", [b64(makeFont("Avenir"))])).toMatchObject({ ok: false, status: 422, error: expect.stringContaining("not Gotham") });
  expect(lend("Gotham", [b64(new TextEncoder().encode("<html>"))])).toMatchObject({ ok: false, status: 422 });
  expect(lend("Gotham", ["!!!!"])).toMatchObject({ ok: false, status: 413 });
  expect(lend("Gotham", [b64(makeFont("Gotham", { pad: MAX_FACE + 1 }))])).toMatchObject({ ok: false, status: 413 });
  expect(lend("Gotham", [])).toMatchObject({ ok: false, status: 400 });
  expect(lend("Gotham", "nope")).toMatchObject({ ok: false, status: 400 });
  expect(lend("Gotham", Array(MAX_FACES + 1).fill(b64(makeFont("Gotham"))))).toMatchObject({ ok: false, status: 400 });
  expect(lend({ a: 1 }, [b64(makeFont("Gotham"))])).toMatchObject({ ok: false, status: 400 });
  // One bad file among good ones spoils the lot.
  expect(lend("Gotham", [b64(makeFont("Gotham")), b64(new Uint8Array([1, 2, 3, 4]))])).toMatchObject({ ok: false });
  expect(fonts.state().available).toEqual([]);
  expect(fonts.state().wanted.map((w) => w.family)).toEqual(["Gotham"]);
});

test("a person withdraws what they lent; only they can; leaving the room takes it too", async () => {
  const fonts = service();
  await fonts.want("p2", ["Gotham", "Avenir"]);
  fonts.lend("p1", "Gotham", [b64(makeFont("Gotham"))]);
  fonts.lend("p1", "Avenir", [b64(makeFont("Avenir"))]);
  const held = fonts.face("gotham", 0)!;
  expect(fonts.withdraw("p2", "Gotham")).toBe(false);
  expect(fonts.has("Gotham")).toBe(true);
  expect(fonts.withdraw("p1", "Gotham")).toBe(true);
  expect(fonts.has("Gotham")).toBe(false);
  // The bytes are overwritten, not just forgotten.
  expect(held.every((b) => b === 0)).toBe(true);
  fonts.dropLender("p1");
  expect(fonts.state().available).toEqual([]);
});

test("the session ending drops every font, wipes the bytes, and refuses a late lend or fetch", async () => {
  const fonts = service();
  await fonts.want("p2", ["Gotham"]);
  fonts.lend("p1", "Gotham", [b64(makeFont("Gotham"))]);
  const open = service();
  await open.want("p1", ["Inter"]);
  const bytes = fonts.face("gotham", 0)!;
  fonts.clear();
  open.clear();
  expect(fonts.state()).toEqual({ available: [], wanted: [] });
  expect(open.state()).toEqual({ available: [], wanted: [] });
  expect(bytes.every((b) => b === 0)).toBe(true);
  await fonts.want("p2", ["Gotham"]);
  expect(fonts.state().wanted).toEqual([]);
  expect(fonts.lend("p1", "Gotham", [b64(makeFont("Gotham"))])).toMatchObject({ ok: false, status: 410 });
  expect(await open.scan()).toEqual([]);
  expect(await open.resolveOpen("Roboto Slab")).toBe(false);
});

test("the session ending in the middle of a fetch leaves nothing behind", async () => {
  const slow = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/v1/fonts") return Response.json(catalogue);
      await Bun.sleep(400);
      return new Response("late", { status: 500 });
    },
  });
  const fonts = new FontService(() => [], () => undefined, { api: `http://127.0.0.1:${slow.port}/v1`, cdn, ...google, offline: false });
  const pending = fonts.resolveOpen("Inter");
  await Bun.sleep(50);
  fonts.clear();
  expect(await pending).toBe(false);
  expect(fonts.state().available).toEqual([]);
  slow.stop(true);
});

test("family names are compared without case, spacing or width tricks", () => {
  expect(normalizeFamily("  Helvetica   Neue ")).toBe("helvetica neue");
  expect(normalizeFamily("ＨＥＬＶＥＴＩＣＡ")).toBe("helvetica");
});

// ---------- over HTTP: who may ask, lend, and fetch ----------

const dir = mkdtempSync(join(tmpdir(), "jam-fonts-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
const server = startHttp(hub, 0);
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  server.stop(true);
  hub.stop();
  bus.resolver = null;
  rmSync(dir, { recursive: true, force: true });
});
const dana = hub.session.upsertPerson({ name: "Dana" });
const lee = hub.session.upsertPerson({ name: "Lee" });
const remote = { "x-forwarded-for": "9.9.9.9", "content-type": "application/json" };
const danasMac = hub.auth.issue({ kind: "browser", label: "Dana's Mac", ip: "10.0.0.6", personId: dana.id });
const leesLaptop = hub.auth.issue({ kind: "browser", label: "Lee's laptop", ip: "10.0.0.7", personId: lee.id });
const nobody = hub.auth.issue({ kind: "browser", label: "A laptop", ip: "10.0.0.8" });
const agent = hub.auth.issue({ kind: "agent", label: "Agents on Mac", ip: "10.0.0.5", ownerDeviceId: "host", personId: dana.id });
const as = (t: { token: string }) => ({ ...remote, authorization: `Bearer ${t.token}` });
const post = (path: string, who: { token: string }, body: unknown) => fetch(`${base}/api/fonts/${path}`, { method: "POST", headers: as(who), body: JSON.stringify(body) });
/** A lend as the Mac app's lend_font makes it after its dialog: a ticket, then the files signed with the window's credential (the hub keeps its hash). */
const lend = async (who: { token: string; device: { tokenHash: string } }, body: { family: string; files: string[]; personId?: string }) => {
  const t = await post("lend-ticket", who, { family: body.family });
  if (!t.ok) return t;
  const { ticket } = (await t.json()) as { ticket: string };
  return post("lend", who, { ...body, ticket, sig: createHmac("sha256", who.device.tokenHash).update(lendMessage(ticket, body.files)).digest("hex") });
};

test("over HTTP: Lee's canvas asks, Dana confirms and lends, Lee's canvas fetches it without it being cached", async () => {
  expect((await post("want", leesLaptop, { families: ["Helvetica Neue"] })).status).toBe(200);
  const state = await fetch(`${base}/api/state`, { headers: as(leesLaptop) }).then((r) => r.json() as Promise<any>);
  expect(state.fonts.wanted[0]).toMatchObject({ family: "Helvetica Neue", askedBy: [lee.id] });
  const lent = await lend(danasMac, { family: "Helvetica Neue", files: [b64(makeFont("Helvetica Neue"))] });
  expect(lent.status).toBe(200);
  const after = await fetch(`${base}/api/state`, { headers: as(leesLaptop) }).then((r) => r.json() as Promise<any>);
  expect(after.fonts.available[0]).toMatchObject({ family: "Helvetica Neue", kind: "borrowed", lender: "Dana", faces: 1 });
  const file = await fetch(`${base}/api/fonts/${after.fonts.available[0].key.replace(/ /g, "%20")}/0`, { headers: as(leesLaptop) });
  expect(file.status).toBe(200);
  expect(file.headers.get("cache-control")).toBe("no-store");
  expect(fontFamilies(new Uint8Array(await file.arrayBuffer()))).toEqual(["Helvetica Neue"]);
  // On the host, only its own windows get the file: not another process reaching loopback, nor an agent there.
  const at = `${base}/api/fonts/${after.fonts.available[0].key.replace(/ /g, "%20")}/0`;
  expect((await fetch(at)).status).toBe(403);
  expect((await fetch(at, { headers: { authorization: `Bearer ${agent.token}` } })).status).toBe(403);
  const window = await fetch(at, { headers: { cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` } });
  expect(window.status).toBe(200);
});

test("over HTTP: an agent can't ask, lend, decline, withdraw or download, with or without a person on its credential", async () => {
  await post("want", leesLaptop, { families: ["Gotham"] });
  for (const [path, body] of [["want", { families: ["Gotham"] }], ["lend", { family: "Gotham", files: [b64(makeFont("Gotham"))] }], ["decline", { family: "Gotham" }], ["withdraw", { family: "Helvetica Neue" }]] as const) {
    expect([path, (await post(path, agent, body)).status]).toEqual([path, 403]);
  }
  expect((await fetch(`${base}/api/fonts/helvetica%20neue/0`, { headers: as(agent) })).status).toBe(403);
  expect(hub.fonts.has("Gotham")).toBe(false);
  expect(hub.fonts.state().wanted.map((w) => w.family)).toContain("Gotham");
  // And no one can reach them through ?token= either.
  expect((await fetch(`${base}/api/fonts/lend?token=${agent.token}`, { method: "POST", headers: remote, body: JSON.stringify({ family: "Gotham", files: [] }) })).status).toBe(403);
});

test("over HTTP: a window with no person can ask but not lend; unpaired devices get nothing; withdrawing is the lender's alone", async () => {
  expect((await post("lend", nobody, { family: "Gotham", files: [b64(makeFont("Gotham"))] })).status).toBe(403);
  expect((await post("decline", nobody, { family: "Gotham" })).status).toBe(403);
  expect((await fetch(`${base}/api/fonts/want`, { method: "POST", headers: remote, body: "{}" })).status).toBe(401);
  expect((await fetch(`${base}/api/fonts/helvetica%20neue/0`, { headers: remote })).status).toBe(401);
  // Lee didn't lend Helvetica Neue.
  expect((await post("withdraw", leesLaptop, { family: "Helvetica Neue" })).status).toBe(404);
  // Declining by name through the real route is recorded against the person on the credential.
  expect((await post("decline", leesLaptop, { family: "Gotham" })).status).toBe(200);
  expect(hub.fonts.state().wanted.find((w) => w.family === "Gotham")?.declinedBy).toEqual([lee.id]);
  // A person can't lend as someone else by naming them.
  const bad = await lend(leesLaptop, { family: "Gotham", personId: dana.id, files: [b64(makeFont("Gotham"))] });
  expect(bad.status).toBe(200);
  expect(hub.fonts.state().available.find((f) => f.family === "Gotham")?.lenderId).toBe(lee.id);
});

test("over HTTP: lent bytes come only from the Mac app's dialog: no ticket, a forged or reused signature, another family's or another window's ticket are refused", async () => {
  await post("want", leesLaptop, { families: ["Futura"] });
  const files = [b64(makeFont("Futura"))];
  const ticket = async (who = danasMac, family = "Futura") => ((await (await post("lend-ticket", who, { family })).json()) as { ticket: string }).ticket;
  const sign = (t: string, key = danasMac.device.tokenHash, f = files) => createHmac("sha256", key).update(lendMessage(t, f)).digest("hex");
  // A page posting bytes itself, as lending worked before: no ticket, no signature.
  expect((await post("lend", danasMac, { family: "Futura", files })).status).toBe(403);
  // A ticket but no signature, or one made with the wrong key (the page doesn't have the window's credential).
  expect((await post("lend", danasMac, { family: "Futura", files, ticket: await ticket() })).status).toBe(403);
  expect((await post("lend", danasMac, { family: "Futura", files, ticket: await ticket(), sig: "ab".repeat(32) })).status).toBe(403);
  const t1 = await ticket();
  expect((await post("lend", danasMac, { family: "Futura", files, ticket: t1, sig: sign(t1, "not the key") })).status).toBe(403);
  // That ticket is spent even though the attempt failed.
  expect((await post("lend", danasMac, { family: "Futura", files, ticket: t1, sig: sign(t1) })).status).toBe(403);
  // Signed for other files than the ones sent; a ticket for another family; Lee's ticket and key used from Dana's window.
  const t2 = await ticket();
  expect((await post("lend", danasMac, { family: "Futura", files, ticket: t2, sig: sign(t2, danasMac.device.tokenHash, [b64(makeFont("Other"))]) })).status).toBe(403);
  const t3 = await ticket(danasMac, "Gill Sans");
  expect((await post("lend", danasMac, { family: "Futura", files, ticket: t3, sig: sign(t3) })).status).toBe(403);
  const t4 = await ticket(leesLaptop);
  expect((await post("lend", danasMac, { family: "Futura", files, ticket: t4, sig: sign(t4, leesLaptop.device.tokenHash) })).status).toBe(403);
  // A signature with bytes that aren't hex at all is a refusal, not a crash.
  const t5 = await ticket();
  expect((await post("lend", danasMac, { family: "Futura", files, ticket: t5, sig: "é".repeat(64) })).status).toBe(403);
  expect(hub.fonts.has("Futura")).toBe(false);
  // The real thing.
  const t6 = await ticket();
  expect((await post("lend", danasMac, { family: "Futura", files, ticket: t6, sig: sign(t6) })).status).toBe(200);
  expect(hub.fonts.has("Futura")).toBe(true);
});

test("over HTTP: the host's own window lends with the window key the Mac app shares with the hub", async () => {
  hub.session.store.setSetting("hostPersonId", dana.id);
  const win = () => ({ "content-type": "application/json", cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` });
  await post("want", leesLaptop, { families: ["Optima"] });
  const files = [b64(makeFont("Optima"))];
  const { ticket } = (await (await fetch(`${base}/api/fonts/lend-ticket`, { method: "POST", headers: win(), body: JSON.stringify({ family: "Optima" }) })).json()) as { ticket: string };
  // Signed with the credential's hash instead (as through a relay): not this window's key.
  const wrong = await fetch(`${base}/api/fonts/lend`, { method: "POST", headers: win(), body: JSON.stringify({ family: "Optima", files, ticket, sig: createHmac("sha256", danasMac.device.tokenHash).update(lendMessage(ticket, files)).digest("hex") }) });
  expect(wrong.status).toBe(403);
  const { ticket: t2 } = (await (await fetch(`${base}/api/fonts/lend-ticket`, { method: "POST", headers: win(), body: JSON.stringify({ family: "Optima" }) })).json()) as { ticket: string };
  const ok = await fetch(`${base}/api/fonts/lend`, { method: "POST", headers: win(), body: JSON.stringify({ family: "Optima", files, ticket: t2, sig: hub.auth.windows.sign(lendMessage(t2, files)) }) });
  expect(ok.status).toBe(200);
  // Another process on the host can't even ask for a ticket.
  expect((await fetch(`${base}/api/fonts/lend-ticket`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ family: "Optima" }) })).status).toBe(403);
});

test("a lend ticket is good once, for two minutes, for its window, person and family", () => {
  const fonts = service();
  const t = fonts.lendTicket("dev_a", "p1", "Gotham", 1000)!;
  expect(fonts.redeemTicket(t, "dev_a", "p1", "GOTHAM ", 1000 + 60_000)).toBe(true);
  expect(fonts.redeemTicket(t, "dev_a", "p1", "Gotham", 1000)).toBe(false);
  const late = fonts.lendTicket("dev_a", "p1", "Gotham", 1000)!;
  expect(fonts.redeemTicket(late, "dev_a", "p1", "Gotham", 1000 + 2 * 60_000 + 1)).toBe(false);
  for (const [caller, person, family] of [["dev_b", "p1", "Gotham"], ["dev_a", "p2", "Gotham"], ["dev_a", "p1", "Avenir"]]) {
    const x = fonts.lendTicket("dev_a", "p1", "Gotham", 1000)!;
    expect(fonts.redeemTicket(x, caller, person, family, 1000)).toBe(false);
  }
  expect(fonts.lendTicket("dev_a", "p1", "", 1000)).toBeNull();
  fonts.clear();
  expect(fonts.lendTicket("dev_a", "p1", "Gotham", 1000)).toBeNull();
});

/** HMAC-SHA256 of that lend message under "k" x 64; app/src-tauri/src/fonts.rs checks the same value. */
const LEND_VECTOR = "75c43a30bfcc15cb3e275553332244c7d3f3c48c2604862406d752454d23057a";

test("the lend signature matches the Mac app's (fonts.rs lend_signature): same ticket, files and key, same hex", () => {
  const msg = lendMessage("00112233445566778899aabbccddeeff", ["AAEC", "AwQF"]);
  expect(createHmac("sha256", "k".repeat(64)).update(msg).digest("hex")).toBe(LEND_VECTOR);
});

test("over HTTP: a damaged lend, a lend nobody asked for and a repeated lend are answered plainly", async () => {
  await post("want", leesLaptop, { families: ["Avenir"] });
  const dmg = await lend(danasMac, { family: "Avenir", files: [b64(new Uint8Array([9, 9, 9, 9]))] });
  expect(dmg.status).toBe(422);
  expect(((await dmg.json()) as any).error).toContain("font file");
  expect((await lend(danasMac, { family: "Papyrus", files: [b64(makeFont("Papyrus"))] })).status).toBe(409);
  const ok = await lend(danasMac, { family: "Avenir", files: [b64(makeFont("Avenir"))] });
  expect(ok.status).toBe(200);
  // The same request again (a retry after a lost answer) is fine and changes nothing.
  const again = await lend(danasMac, { family: "Avenir", files: [b64(makeFont("Avenir"))] });
  expect(((await again.json()) as any).already).toBe(true);
  expect(hub.fonts.state().available.filter((f) => f.family === "Avenir").length).toBe(1);
});

test("over HTTP: the person leaving takes their fonts; the session ending ends the loan and refuses new ones", async () => {
  expect(hub.fonts.has("Avenir")).toBe(true);
  const rm = await fetch(`${base}/api/people/${dana.id}`, { method: "DELETE", headers: { ...remote, "x-forwarded-for": "9.9.9.9", authorization: `Bearer ${leesLaptop.token}` } });
  expect(rm.status).toBe(200);
  expect(hub.fonts.has("Avenir")).toBe(false);
  await post("want", leesLaptop, { families: ["Frutiger"] });
  hub.stop();
  expect(hub.fonts.state()).toEqual({ available: [], wanted: [] });
  const late = await lend(leesLaptop, { family: "Frutiger", files: [b64(makeFont("Frutiger"))] });
  expect(late.status).toBe(410);
  expect(hub.fonts.has("Gotham")).toBe(false);
});

test("an agent can't push a font into the canvas through its tools either", () => {
  expect(forbiddenCommand("run_command", { command: "text.loadFont", params: { path: "/Users/x/Gotham.otf" } })).toBe("text.loadFont");
  expect(forbiddenCommand("batch", { commands: [{ command: "node.create" }, { command: "text.loadFont", params: { data: "AAAA" } }] })).toBe("text.loadFont");
  expect(forbiddenCommand("run_command", { command: "text.missingFonts" })).toBeNull();
  expect(forbiddenCommand("run_command", { command: "text.set" })).toBeNull();
});

test("over HTTP: a lend body over the cap is refused before it is parsed, with or without a length header", async () => {
  await post("want", leesLaptop, { families: ["Gotham Cap"] }).catch(() => {});
  const huge = "A".repeat(FONT_BODY_MAX + 1024);
  const body = JSON.stringify({ family: "Gotham Cap", files: [huge] });
  const sized = await fetch(`${base}/api/fonts/lend`, { method: "POST", headers: as(danasMac), body });
  expect(sized.status).toBe(413);
  const chunked = await fetch(`${base}/api/fonts/lend`, { method: "POST", headers: as(danasMac), body: new ReadableStream({ start(c) { const bytes = new TextEncoder().encode(body); for (let i = 0; i < bytes.length; i += 1 << 20) c.enqueue(bytes.subarray(i, i + (1 << 20))); c.close(); } }), duplex: "half" } as any);
  expect([413, 431]).toContain(chunked.status); // Bun may answer a refused chunked upload itself
});

test("a reply is read only up to its cap: a large Content-Length is refused unread, an endless body is cut off", async () => {
  // Says it is large: not one byte is pulled.
  let pulled = 0;
  const endless = () =>
    new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 64 * 1024;
        c.enqueue(new Uint8Array(64 * 1024));
      },
    });
  expect(await readUpTo(new Response(endless(), { headers: { "content-length": String(MAX_FACE + 1) } }), MAX_FACE)).toBeNull();
  expect(pulled).toBeLessThanOrEqual(64 * 1024); // at most the stream's own first read-ahead
  // No length, and it never ends: reading stops just past the cap.
  pulled = 0;
  expect(await readUpTo(new Response(endless()), 1024 * 1024)).toBeNull();
  expect(pulled).toBeLessThan(1024 * 1024 + 4 * 64 * 1024);
  // Within the cap, the bytes come through whole; a cap already used up reads nothing.
  expect(await readUpTo(new Response(new Uint8Array([1, 2, 3])), 3)).toEqual(new Uint8Array([1, 2, 3]));
  expect(await readUpTo(new Response(new Uint8Array([1])), 0)).toBeNull();
});

test("an open font whose server sends a never-ending file is dropped, not held in memory", async () => {
  let sent = 0;
  const flood: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req): Response {
      const path = new URL(req.url).pathname;
      if (path === "/v1/fonts") return Response.json([{ id: "flood", family: "Flood Sans", license: OFL, type: "other", styles: ["normal"], weights: [400], defSubset: "latin" }]);
      if (path === "/v1/fonts/flood") return Response.json({ id: "flood", defSubset: "latin", variants: { "400": { normal: { latin: { url: { ttf: `http://127.0.0.1:${flood.port}/cdn/flood.ttf` } } } } } });
      // Paced, so what was sent is what the hub asked for.
      const body = new ReadableStream(
        {
          pull: async (c) => {
            await Bun.sleep(1);
            if (sent >= 64 * 1024 * 1024) return c.close();
            c.enqueue(new Uint8Array(1 << 20));
            sent += 1 << 20;
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body);
    },
  });
  try {
    const fonts = new FontService(() => [], () => undefined, { api: `http://127.0.0.1:${flood.port}/v1`, cdn: `http://127.0.0.1:${flood.port}/cdn/`, googleCss: "", googleHost: "", offline: false });
    expect(await fonts.resolveOpen("Flood Sans")).toBe(false);
    expect(fonts.has("Flood Sans")).toBe(false);
    // The hub stopped reading just past the face cap, well before the 64 MB the server would have sent.
    expect(sent).toBeLessThan(MAX_FACE + 8 * (1 << 20));
  } finally {
    flood.stop(true);
  }
});
