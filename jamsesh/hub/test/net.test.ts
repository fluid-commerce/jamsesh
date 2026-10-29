import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dnsHasTxt, needsRenewal, parseDohTxt, safeError, waitForTxt } from "../src/net/acme";
import { clearTxt, parseDomain, parseUpdateResponse, publicIp, setTxt, updateIp } from "../src/net/duckdns";
import { Network } from "../src/net";
import { classifyFetchError, externalCheck, localCheck, parseCheckHostResult } from "../src/net/reach";
import { decodeNatPmp, detectCgnat, isCgnatIp, manualMessage, natPmpMapRequest, parseIgdDescription } from "../src/net/router";

const resp = (text: string, status = 200) => new Response(text, { status });

describe("duckdns", () => {
  test("domain parsing", () => {
    for (const i of ["jam", "JAM.duckdns.org", "https://jam.duckdns.org/", "https://jam.duckdns.org:443/healthz"]) expect(parseDomain(i)).toEqual({ sub: "jam", fqdn: "jam.duckdns.org" });
    for (const i of ["", "a b", "-x", "x-", "a.b.duckdns.org", "ex ample"]) expect(parseDomain(i)).toBeNull();
  });
  test("update response parsing", () => {
    expect(parseUpdateResponse("OK\n1.2.3.4\n\nUPDATED")).toEqual({ ok: true, ip: "1.2.3.4", ipv6: undefined, changed: true });
    expect(parseUpdateResponse("OK\n1.2.3.4\n2001:db8::1\nNOCHANGE")).toMatchObject({ ok: true, ipv6: "2001:db8::1", changed: false });
    expect(parseUpdateResponse("KO").ok).toBe(false);
  });
  test("requests carry the right params and errors never leak the token", async () => {
    const urls: string[] = [];
    const f = async (u: string) => (urls.push(u), resp("OK\n9.9.9.9\n\nUPDATED"));
    const d = parseDomain("jam")!;
    expect((await updateIp(d, "tok-123", f)).ip).toBe("9.9.9.9");
    await setTxt(d, "tok-123", "abc", f);
    await clearTxt(d, "tok-123", f);
    expect(urls[0]).toContain("domains=jam");
    expect(urls[0]).toContain("verbose=true");
    expect(urls[1]).toContain("txt=abc");
    expect(urls[2]).toContain("clear=true");
    const bad = await updateIp(d, "tok-123", async (u) => { throw new Error(`failed ${u}`); });
    expect(bad.error).not.toContain("tok-123");
  });
  test("public ip falls back to ipify", async () => {
    expect(await publicIp(async () => resp("5.6.7.8\n"))).toBe("5.6.7.8");
    expect(await publicIp(async () => resp("<html>"))).toBeUndefined();
    expect(await publicIp(async () => resp("x"), "1.1.1.1")).toBe("1.1.1.1");
  });
});

describe("acme helpers", () => {
  test("renewal at 30 days", () => {
    const now = Date.now();
    const day = 86_400_000;
    expect(needsRenewal(undefined, now)).toBe(true);
    expect(needsRenewal(now + 29 * day, now)).toBe(true);
    expect(needsRenewal(now + 31 * day, now)).toBe(false);
  });
  test("DoH TXT parsing and polling", async () => {
    const answer = { Answer: [{ type: 16, data: '"abc123"' }, { type: 1, data: "1.1.1.1" }] };
    expect(parseDohTxt(answer)).toEqual(["abc123"]);
    expect(await dnsHasTxt("jam.duckdns.org", "abc123", async () => Response.json(answer))).toBe(true);
    expect(await dnsHasTxt("jam.duckdns.org", "nope", async () => Response.json(answer))).toBe(false);
    let n = 0;
    const f = async () => Response.json(++n < 3 ? {} : answer);
    expect(await waitForTxt("jam.duckdns.org", "abc123", { f, everyMs: 1, timeoutMs: 2000 })).toBe(true);
    expect(await waitForTxt("jam.duckdns.org", "zzz", { f: async () => Response.json({}), everyMs: 1, timeoutMs: 20 })).toBe(false);
  });
  test("errors are scrubbed", () => {
    const e = new Error("bad tok-123 -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
    const s = safeError(e, "tok-123");
    expect(s).not.toContain("tok-123");
    expect(s).not.toContain("abc");
  });
});

describe("router", () => {
  test("nat-pmp encode", () => {
    const b = natPmpMapRequest(4443, 443, 3600);
    expect([...b]).toEqual([0, 2, 0, 0, 0x11, 0x5b, 0x01, 0xbb, 0, 0, 0x0e, 0x10]);
  });
  test("nat-pmp decode", () => {
    const addr = Buffer.from([0, 128, 0, 0, 0, 0, 0, 5, 203, 0, 113, 7]);
    expect(decodeNatPmp(addr)).toEqual({ kind: "address", result: 0, externalIp: "203.0.113.7" });
    const map = Buffer.alloc(16);
    map.writeUInt8(130, 1);
    map.writeUInt16BE(4443, 8);
    map.writeUInt16BE(443, 10);
    map.writeUInt32BE(3600, 12);
    expect(decodeNatPmp(map)).toEqual({ kind: "map", result: 0, internalPort: 4443, externalPort: 443, lifetimeSec: 3600 });
    map.writeUInt16BE(2, 2);
    expect(decodeNatPmp(map)).toMatchObject({ result: 2 });
    expect(decodeNatPmp(Buffer.from([1, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(decodeNatPmp(Buffer.from([0, 128]))).toBeNull();
  });
  test("cgnat detection", () => {
    expect(isCgnatIp("100.64.0.1")).toBe(true);
    expect(isCgnatIp("100.127.255.254")).toBe(true);
    expect(isCgnatIp("100.128.0.1")).toBe(false);
    expect(detectCgnat("8.8.8.8", "100.72.1.1")).toBe(true);
    expect(detectCgnat("8.8.8.8", "10.1.2.3")).toBe(true);
    expect(detectCgnat("8.8.8.8", "8.8.4.4")).toBe(true);
    expect(detectCgnat("8.8.8.8", "8.8.8.8")).toBe(false);
    expect(detectCgnat("8.8.8.8", undefined)).toBe(false);
    expect(detectCgnat("8.8.8.8", "0.0.0.0")).toBe(false);
  });
  test("igd description and manual message", () => {
    const xml = `<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/ip</controlURL></service></serviceList></device></root>`;
    expect(parseIgdDescription(xml, "http://192.168.1.1:5000/desc.xml")?.control).toBe("http://192.168.1.1:5000/ctl/ip");
    expect(manualMessage(443, "192.168.1.20", 4443)).toBe("Your router doesn't allow automatic port forwarding. In your router's settings, forward TCP port 443 to 192.168.1.20 port 4443.");
  });
});

describe("reach", () => {
  test("local check", async () => {
    expect((await localCheck("jam.duckdns.org", async () => resp("ok"))).ok).toBe(true);
    expect((await localCheck("jam.duckdns.org", async () => resp("<html>"))).ok).toBe(false);
    const t = await localCheck("jam.duckdns.org", async () => { throw new Error("The operation timed out"); });
    expect(t).toMatchObject({ ok: false, hairpinSuspect: true });
    expect(classifyFetchError({ code: "ENOTFOUND" }).hairpinSuspect).toBe(false);
  });
  test("check-host parsing", () => {
    expect(parseCheckHostResult({ a: null, b: [[1, 0.2, "OK", "200", "1.2.3.4"]] })).toBeNull();
    expect(parseCheckHostResult({ a: [[1, 0.2, "OK", "200", "1.2.3.4"]], b: [[0, 3, "Connection timed out"]] })).toEqual({ ok: 1, total: 2 });
  });
  test("external check flow", async () => {
    const f = async (u: string) => (u.includes("check-http") ? Response.json({ request_id: "x" }) : Response.json({ n1: [[1, 0.1, "OK", "200", "1.1.1.1"]] }));
    expect((await externalCheck("jam.duckdns.org", f as any, { everyMs: 1 }))?.ok).toBe(true);
    expect(await externalCheck("jam.duckdns.org", (async () => { throw new Error("x"); }) as any)).toBeNull();
  });
});

describe("Network config", () => {
  test("persists privately and never exposes the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "net-"));
    const f = async (u: string) => (u.includes("duckdns.org/update") ? resp("OK\n9.9.9.9\n\nUPDATED") : resp("ok"));
    const n = new Network(dir, f as any);
    const tok = "11111111-2222-3333-4444-555555555555";
    // Bad inputs are refused with plain-language errors and nothing is saved.
    const bad = await n.routes(new Request("http://x/api/net/config", { method: "POST", body: JSON.stringify({ domain: "a b", token: tok }) }), new URL("http://x/api/net/config"));
    expect(bad!.status).toBe(400);
    expect(await n.routes(new Request("http://x/other"), new URL("http://x/other"))).toBeNull();
    expect(n.status().configured).toBe(false);

    // Persistence: a fresh instance reads what an earlier one wrote.
    await Bun.write(join(dir, "net.json"), JSON.stringify({ domain: "jam.duckdns.org", token: tok, externalPort: 443, internalPort: 4443, enabled: false, staging: true }), {});
    const n2 = new Network(dir, f as any);
    const s = n2.status();
    expect(s.domain).toBe("jam.duckdns.org");
    expect(s.publicUrl).toBe("https://jam.duckdns.org");
    expect(s.cert.state).toBe("none");
    expect(JSON.stringify(s)).not.toContain(tok);
    expect(n2.tlsOptions()).toBeNull();
    expect(JSON.stringify(n2.config())).not.toContain(tok);
  });
  test("saved file is 0600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "net-"));
    const f = async (u: string) => resp("OK\n9.9.9.9\n\nUPDATED");
    const n = new Network(dir, f as any);
    (n as any).saveConfig({ domain: "jam.duckdns.org", token: "t", externalPort: 443, internalPort: 4443, enabled: false, staging: false });
    expect(statSync(join(dir, "net.json")).mode & 0o777).toBe(0o600);
  });
  test("once the room is closing nothing is issued, saved or mapped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "net-"));
    const seen: string[] = [];
    const f = async (u: string) => (seen.push(u), resp("OK\n9.9.9.9\n\nUPDATED"));
    const n = new Network(dir, f as any);
    await Bun.write(join(dir, "net.json"), JSON.stringify({ domain: "jam.duckdns.org", token: "11111111-2222-3333-4444-555555555555", externalPort: 443, internalPort: 4443, enabled: true, staging: true }), {});
    const n2 = new Network(dir, f as any);
    let mapped = 0;
    (n2 as any).mapper = { map: async () => (mapped++, { method: "none" }), unmap: async () => {} };
    n2.close();
    await n2.start();
    await n2.ensureCert(true);
    await n2.openRouter();
    expect(seen).toEqual([]);
    expect(mapped).toBe(0);
    expect(n2.tlsOptions()).toBeNull();
    void n;
  });
  test("a mapping the router would not remove is remembered on disk and removed at the next start", async () => {
    const { PortMapper } = await import("../src/net/router");
    const dir = mkdtempSync(join(tmpdir(), "net-"));
    const file = join(dir, "router-map.json");
    class Flaky extends PortMapper {
      fail = true;
      removed: unknown[] = [];
      protected override async remove(c: any) {
        if (this.fail) throw new Error("router did not answer");
        this.removed.push(c);
      }
    }
    const a = new Flaky(file);
    (a as any).current = { method: "upnp", internalPort: 4443, externalPort: 443, lanIp: "192.168.1.5" };
    await a.unmap(); // fails
    expect(existsSync(file)).toBe(true);
    expect(a.owing?.externalPort).toBe(443);
    // A new run (a restart) loads it and settles it once the router answers.
    const b = new Flaky(file);
    expect(b.owing?.externalPort).toBe(443);
    expect(await b.settleOwed()).toBe(false); // still failing: stays on disk
    expect(existsSync(file)).toBe(true);
    b.fail = false;
    expect(await b.settleOwed()).toBe(true);
    expect(b.removed.length).toBe(1);
    expect(existsSync(file)).toBe(false);
  });
  test("ACME issuance and DuckDNS calls stop when the room closes: no account key, no TXT record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "net-"));
    const seen: string[] = [];
    const f = async (u: string) => (seen.push(u), resp("OK\n9.9.9.9\n\nUPDATED"));
    await Bun.write(join(dir, "net.json"), JSON.stringify({ domain: "jam.duckdns.org", token: "11111111-2222-3333-4444-555555555555", externalPort: 443, internalPort: 4443, enabled: true, staging: true }), {});
    const n = new Network(dir, f as any);
    n.close();
    await expect(n.ensureCert(true)).resolves.toBeUndefined();
    await expect((n as any).f("https://www.duckdns.org/update?txt=x")).rejects.toThrow();
    expect(seen).toEqual([]);
    expect(existsSync(join(dir, "tls", "account.key"))).toBe(false);
    const { issueOne, CertStore } = await import("../src/net/acme");
    const ac = new AbortController();
    ac.abort();
    await expect(issueOne("apex", { domain: { fqdn: "jam.duckdns.org", sub: "jam" } as any, token: "t", store: new CertStore(join(dir, "tls2")), f: f as any, signal: ac.signal })).rejects.toThrow();
    expect(existsSync(join(dir, "tls2", "account.key"))).toBe(false);
    expect(seen).toEqual([]);
  });
});

describe("port mapper state", () => {
  test("silence or an error from the router is not a removal: NAT-PMP must confirm", async () => {
    const { PortMapper } = await import("../src/net/router");
    const dir = mkdtempSync(join(tmpdir(), "net-"));
    const file = join(dir, "router-map.json");
    // A record of a UPnP mapping with no router to answer: removal fails, the record stays.
    writeFileSync(file, JSON.stringify({ method: "upnp", internalPort: 4443, externalPort: 443, lanIp: "10.0.0.2" }));
    class NoRouter extends PortMapper {
      protected override async remove(): Promise<void> {
        throw new Error("no router answered");
      }
    }
    const m = new NoRouter(file);
    expect(await m.settleOwed()).toBe(false);
    expect(existsSync(file)).toBe(true);
    // And no new mapping is made over it.
    const status = await m.map(443, 4443, "10.0.0.2");
    expect(status.method).toBe("none");
    expect(status.error).toContain("earlier port mapping");
    expect(JSON.parse(readFileSync(file, "utf8")).externalPort).toBe(443);
  });
  test("a damaged record is kept and blocks a new mapping instead of being forgotten", async () => {
    const { PortMapper } = await import("../src/net/router");
    const dir = mkdtempSync(join(tmpdir(), "net-"));
    const file = join(dir, "router-map.json");
    writeFileSync(file, "{ not json");
    const m = new PortMapper(file);
    expect(await m.settleOwed()).toBe(false);
    expect((await m.map(443, 4443, "10.0.0.2")).method).toBe("none");
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });
  test("concurrent cleanups share one attempt", async () => {
    const { PortMapper } = await import("../src/net/router");
    const dir = mkdtempSync(join(tmpdir(), "net-"));
    const file = join(dir, "router-map.json");
    writeFileSync(file, JSON.stringify({ method: "upnp", internalPort: 1, externalPort: 2, lanIp: "10.0.0.2" }));
    let calls = 0;
    class Slow extends PortMapper {
      protected override async remove(): Promise<void> {
        calls++;
        await Bun.sleep(30);
      }
    }
    const m = new Slow(file);
    const [a, b] = await Promise.all([m.settleOwed(), m.settleOwed()]);
    expect([a, b, calls]).toEqual([true, true, 1]);
    expect(existsSync(file)).toBe(false);
  });
});
