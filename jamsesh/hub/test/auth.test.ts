import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, CODE_ALPHABET, CODE_PERIOD_MS, codeFor } from "../src/auth";
import { Store } from "../src/store";

const auth = () => new Auth(new Store(mkdtempSync(join(tmpdir(), "jam-auth-"))));

test("codes are 4 characters from the unambiguous alphabet and change every period", () => {
  const a = auth();
  const t = 1_800_000_000_000;
  const c1 = a.current(t).code;
  expect(c1).toMatch(new RegExp(`^[${CODE_ALPHABET}]{4}$`));
  expect(a.current(t + CODE_PERIOD_MS).code).not.toBe(c1);
});

test("the previous code still works (someone was mid-typing), the one before doesn't", () => {
  const a = auth();
  const t = 1_800_000_000_000;
  const now = a.current(t).code;
  expect(a.verifyCode(now, t + CODE_PERIOD_MS)).toBe(true);
  expect(a.verifyCode(now, t + 2 * CODE_PERIOD_MS)).toBe(false);
  expect(a.verifyCode(now.toLowerCase().split("").join(" "), t)).toBe(true);
});

test("pairing gives a token that works until it's revoked", () => {
  const a = auth();
  const r = a.pair({ code: a.current().code, kind: "browser", label: "Mac · Chrome", ip: "10.0.0.5" });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(a.check(r.token)?.id).toBe(r.device.id);
  expect(a.check("jst_wrong")).toBeNull();
  a.revoke(r.device.id);
  expect(a.check(r.token)).toBeNull();
});

test("wrong codes lock an address out, without locking out others", () => {
  const a = auth();
  for (let i = 0; i < 8; i++) a.pair({ code: "ZZZZ", kind: "agent", label: "x", ip: "10.0.0.9" });
  const right = a.current().code;
  expect(a.pair({ code: right, kind: "agent", label: "x", ip: "10.0.0.9" }).ok).toBe(false);
  expect(a.pair({ code: right, kind: "agent", label: "y", ip: "10.0.0.10" }).ok).toBe(true);
});

test("tokens survive a restart; only their hashes are stored", () => {
  const dir = mkdtempSync(join(tmpdir(), "jam-auth-"));
  const a = new Auth(new Store(dir));
  const r = a.pair({ code: a.current().code, kind: "agent", label: "Chey's Claude", ip: "1.2.3.4" });
  if (!r.ok) throw new Error("pair failed");
  const b = new Auth(new Store(dir));
  expect(b.check(r.token)?.label).toBe("Chey's Claude");
  expect(JSON.stringify(new Store(dir).setting("pairedDevices", []))).not.toContain(r.token);
});

test("codes differ between hosts", () => {
  expect(codeFor("a".repeat(64), 1)).not.toBe(codeFor("b".repeat(64), 1));
});
