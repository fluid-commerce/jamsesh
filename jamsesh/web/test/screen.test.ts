import { describe, expect, test } from "bun:test";
import { joinOptions, primaryAddress, type Code } from "../src/host/joinOptions";

const code = (addresses: Code["addresses"]): Code => ({ code: "AB23", expiresIn: 20000, period: 30000, addresses });
const lan = { label: "In the room", url: "http://192.168.1.20:4747" };
const https = { label: "Anywhere", url: "https://jam.duckdns.org" };

describe("join options", () => {
  test("room address leads, and an unconfirmed https address is held back", () => {
    const r = joinOptions(code([https, lan]), { reachable: "unknown" });
    expect(r.options.map((o) => o.key)).toEqual(["room"]);
    expect(r.options[0].url).toBe(lan.url);
    expect(r.unconfirmed?.url).toBe(https.url);
  });
  test("both addresses show as two options once https is confirmed reachable", () => {
    const r = joinOptions(code([https, lan]), { reachable: "yes" });
    expect(r.options.map((o) => [o.key, o.title])).toEqual([["room", "In the room"], ["remote", "Remote or phone mic"]]);
    expect(r.unconfirmed).toBeNull();
  });
  test("a hub-reported flag on the address wins over the net status", () => {
    expect(joinOptions(code([{ ...https, reachable: "no" }, lan]), { reachable: "yes" }).options).toHaveLength(1);
    expect(joinOptions(code([{ ...https, reachable: true }, lan]), null).options).toHaveLength(2);
  });
  test("https alone, when confirmed, is the only option; unconfirmed it is still better than nothing", () => {
    expect(joinOptions(code([https]), { reachable: "yes" }).options[0].url).toBe(https.url);
    expect(joinOptions(code([https]), null).options[0].url).toBe(https.url);
  });
  test("the first option is the one printed in text", () => {
    expect(primaryAddress(code([https, lan]), null).url).toBe(lan.url);
  });
});
