import { describe, expect, test } from "bun:test";
import { cameraProblem, parseJoin, scanGoes } from "../src/connect/joinHelp";

describe("reading the big screen's QR code", () => {
  test("takes the address and the code from the connect link", () => {
    expect(parseJoin("http://192.168.1.20:4747/connect?c=k7m2")).toEqual({ origin: "http://192.168.1.20:4747", code: "K7M2" });
    expect(parseJoin(" https://team.example.com/connect?c=ABCD2345 ")).toEqual({ origin: "https://team.example.com", code: "ABCD2345" });
    expect(parseJoin("http://10.0.0.5:4747/connect/")).toEqual({ origin: "http://10.0.0.5:4747", code: null });
  });

  test("rejects anything that isn't a join link", () => {
    for (const t of ["", "hello", "https://example.com/hello", "javascript:alert(1)", "ftp://10.0.0.5/connect?c=K7M2", "http://10.0.0.5:4747/client?c=K7M2"]) expect(parseJoin(t)).toBeNull();
  });

  test("a code of the wrong length or with stray characters is not passed on", () => {
    expect(parseJoin("http://10.0.0.5:4747/connect?c=AB3")?.code).toBeNull();
    expect(parseJoin("http://10.0.0.5:4747/connect?c=AB3K%26next%3D%2F%2Fevil")?.code).toBeNull();
    expect(parseJoin("http://10.0.0.5:4747/connect?c=a-b3k")?.code).toBe("AB3K");
  });
});

describe("camera trouble", () => {
  test("each way the camera fails gets its own plain sentence, and all of them offer typing", () => {
    const say = (name: string) => cameraProblem(new DOMException("x", name));
    const all = new Set(["NotAllowedError", "NotFoundError", "NotReadableError", "AbortError"].map(say));
    expect(all.size).toBe(4);
    for (const m of all) expect(m).toContain("instead");
    expect(say("NotAllowedError")).toContain("Allow");
  });
});

describe("where a scanned code leads", () => {
  const here = "http://192.168.1.20:4747";
  test("this room's code stays here; any other address asks first", () => {
    expect(scanGoes({ origin: here, code: "K7M2" }, here)).toBe("here");
    expect(scanGoes({ origin: "http://10.0.0.9:4747", code: "K7M2" }, here)).toBe("ask");
    expect(scanGoes({ origin: "https://evil.example", code: null }, here)).toBe("ask");
    // Same host, other port or scheme: another address.
    expect(scanGoes({ origin: "https://192.168.1.20:4747", code: null }, here)).toBe("ask");
  });
});
