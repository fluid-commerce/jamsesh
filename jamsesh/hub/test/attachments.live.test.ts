// Live check of the gateway path (needs AI_GATEWAY_API_KEY, skipped without it): the same message
// shape directPass sends, with a picture of "42" and a one-page PDF, to the router model.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createGateway } from "@ai-sdk/gateway";
import { generateText } from "ai";
import { Hub } from "../src/hub";

process.env.JAMSESH_SILENT = "1";
const key = process.env.AI_GATEWAY_API_KEY;
const dir = mkdtempSync(join(tmpdir(), "jam-att-live-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
afterAll(() => {
  hub.devproxy.stop();
  hub.stop();
  rmSync(dir, { recursive: true, force: true });
});

// "42" as a 3x5 pixel font, drawn 40 px per pixel in black on white.
const GLYPH: Record<string, string[]> = {
  "4": ["101", "101", "111", "001", "001"],
  "2": ["111", "001", "111", "100", "111"],
};
function pngOf42(): Uint8Array {
  const S = 40, pad = 2, cols = pad * 2 + 7, rows = pad * 2 + 5;
  const w = cols * S, h = rows * S;
  const raw = Buffer.alloc(h * (w + 1), 255);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  "42".split("").forEach((ch, gi) =>
    GLYPH[ch].forEach((row, gy) =>
      [...row].forEach((bit, gx) => {
        if (bit !== "1") return;
        for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) raw[((pad + gy) * S + py) * (w + 1) + 1 + ((pad + gi * 4 + gx) * S + px)] = 0;
      }),
    ),
  );
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(t));
    return Buffer.concat([len, t, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8-bit, grayscale
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

/** A one-page PDF with a sentence in Helvetica. */
function pdfWith(sentence: string): Uint8Array {
  const stream = `BT /F1 24 Tf 72 700 Td (${sentence}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const at: number[] = [];
  objs.forEach((o, i) => {
    at.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

async function ask(name: string, bytes: Uint8Array, question: string) {
  const rec = hub.attachments.save(bytes, name, "Chey");
  const ev = { authorName: "Chey", data: { attachments: [hub.attachments.ref(rec.id)] } } as any;
  const input = (hub.brain as any).withAttachments(ev, question);
  const gw = createGateway({ apiKey: key! });
  const { text } = await generateText({ model: gw("anthropic/claude-sonnet-5.5"), abortSignal: AbortSignal.timeout(90_000), ...input });
  return text;
}

test.skipIf(!key)("the router model reads a PNG sent as an image part", async () => {
  expect(await ask("42.png", pngOf42(), "What number is in the attached picture? Answer with just the number.")).toContain("42");
}, 100_000);

test.skipIf(!key)("the router model reads a PDF sent as a file part", async () => {
  const text = await ask("note.pdf", pdfWith("The harbor light is green"), "What does the attached PDF say? Quote it.");
  expect(text.toLowerCase()).toContain("harbor light is green");
}, 100_000);
