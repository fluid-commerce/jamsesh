// Typing through idb: US keyboard text as HID usage codes, shift around capitals and symbols.
import { expect, test } from "bun:test";
import { hidKey, hidSteps, KEY_SHIFT } from "../src/idb";

test("letters, digits and space map to HID usage codes", () => {
  expect(hidKey("a")).toEqual({ code: 4, shift: false });
  expect(hidKey("z")).toEqual({ code: 29, shift: false });
  expect(hidKey("A")).toEqual({ code: 4, shift: true });
  expect(hidKey("1")).toEqual({ code: 30, shift: false });
  expect(hidKey("0")).toEqual({ code: 39, shift: false });
  expect(hidKey(" ")).toEqual({ code: 44, shift: false });
  expect(hidKey("\n")).toEqual({ code: 40, shift: false });
  expect(hidKey("\t")).toEqual({ code: 43, shift: false });
});

test("symbols use shift where a US keyboard does", () => {
  expect(hidKey("!")).toEqual({ code: 30, shift: true });
  expect(hidKey(")")).toEqual({ code: 39, shift: true });
  expect(hidKey("@")).toEqual({ code: 31, shift: true });
  for (const [plain, shifted, code] of [["-", "_", 45], ["=", "+", 46], ["[", "{", 47], ["]", "}", 48], ["\\", "|", 49], [";", ":", 51], ["'", '"', 52], ["`", "~", 53], [",", "<", 54], [".", ">", 55], ["/", "?", 56]] as const) {
    expect(hidKey(plain)).toEqual({ code, shift: false });
    expect(hidKey(shifted)).toEqual({ code, shift: true });
  }
});

test("every printable ASCII character maps, and nothing else does", () => {
  for (let c = 32; c < 127; c++) expect(hidKey(String.fromCharCode(c))).not.toBeNull();
  for (const bad of ["é", "日", "😀", "", "ab", "\u0000", "\r"]) expect(hidKey(bad)).toBeNull();
});

test("a string becomes down/up steps with shift pressed around capitals, and is refused whole if any character can't be typed", () => {
  expect(hidSteps("hI")).toEqual([
    { code: 11, down: true },
    { code: 11, down: false },
    { code: KEY_SHIFT, down: true },
    { code: 12, down: true },
    { code: 12, down: false },
    { code: KEY_SHIFT, down: false },
  ]);
  expect(hidSteps("ok é")).toBeNull();
  expect(hidSteps("")).toEqual([]);
});

// ---------- a call's outcome: only an answer that says it worked is success ----------

import { createServer, type Http2Server, type ServerHttp2Stream } from "node:http2";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Companion } from "../src/idb";

/** A stand-in companion on a Unix socket that answers each call the way `answer` says. */
async function fakeCompanion(answer: (stream: ServerHttp2Stream) => void) {
  const dir = mkdtempSync(join(tmpdir(), "jam-idb-"));
  const sock = join(dir, "c.sock");
  const server: Http2Server = createServer();
  server.on("stream", (stream) => {
    stream.on("data", () => {});
    stream.on("end", () => answer(stream as ServerHttp2Stream));
  });
  await new Promise<void>((r) => server.listen(sock, r));
  const c = new Companion("fake", sock);
  return {
    c,
    close: () => {
      c.stop();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a tap is done only when the companion answers and says it worked", async () => {
  const ok = await fakeCompanion((s) => {
    s.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
    s.on("wantTrailers", () => s.sendTrailers({ "grpc-status": "0" }));
    s.end();
  });
  try {
    await expect(ok.c.tap(10, 10)).resolves.toBeUndefined();
  } finally {
    ok.close();
  }
});

test("a companion that dies mid-call, ends without a status, answers with an error, or refuses, is a failed tap", async () => {
  const cases: [string, (s: ServerHttp2Stream) => void, RegExp][] = [
    ["cut off before any answer", (s) => s.close(2), /stopped before saying whether it worked|stream|closed|cancel/i],
    ["headers, then nothing", (s) => (s.respond({ ":status": 200, "content-type": "application/grpc" }), s.end()), /stopped before saying whether it worked/],
    ["a gRPC error", (s) => (s.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "13", "grpc-message": "boom" }, { endStream: true })), /boom/],
    ["not a gRPC answer", (s) => (s.respond({ ":status": 503, "grpc-status": "0" }, { endStream: true })), /stopped before saying whether it worked/],
  ];
  for (const [name, answer, why] of cases) {
    const f = await fakeCompanion(answer);
    try {
      const err = await f.c.tap(10, 10).then(
        () => null,
        (e: Error) => e.message,
      );
      expect([name, err ?? "succeeded"]).toEqual([name, expect.stringMatching(why)]);
    } finally {
      f.close();
    }
  }
});
