// The PDF helper (native/jamsesh-pdftext.swift), built once for tests, and real synthetic PDFs to read with it. Mac only.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = join(import.meta.dir, "..", "native", "jamsesh-pdftext.swift");
export const pdfToolAvailable = process.platform === "darwin" && !!Bun.which("swiftc") && !!Bun.which("cupsfilter");

/** Builds the helper (once per source version) and points the hub at it. */
export function usePdfTool(): string | null {
  if (!pdfToolAvailable) return null;
  const dir = join(tmpdir(), "jamsesh-test-bin");
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, `jamsesh-pdftext-${createHash("sha1").update(readFileSync(src)).digest("hex").slice(0, 10)}`);
  if (!existsSync(bin)) {
    const r = Bun.spawnSync(["swiftc", "-O", "-swift-version", "5", src, "-o", bin], { stdout: "ignore", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`swiftc: ${r.stderr.toString().slice(0, 300)}`);
  }
  process.env.JAMSESH_PDFTEXT = bin;
  return bin;
}

/** A real one-page PDF with this text, made by macOS's own print filter. */
export function makePdf(text: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "jam-pdf-"));
  const txt = join(dir, "in.txt");
  writeFileSync(txt, `${text}\n`);
  const r = Bun.spawnSync(["cupsfilter", txt], { stdout: "pipe", stderr: "ignore" });
  if (!r.stdout.length) throw new Error("cupsfilter made nothing");
  return new Uint8Array(r.stdout);
}
