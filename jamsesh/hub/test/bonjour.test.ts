// What the hub puts in its Bonjour record about the project.
import { expect, test } from "bun:test";
import { leftoverAdverts, txtName } from "../src/bonjour";

test("only advertisers a gone hub left for this service and port are leftovers", () => {
  const ps = [
    "30572     1 /usr/bin/dns-sd -R Deer’s Mac mini (3) _jamsesh._tcp local 4747 session=Jam session",
    "31317     1 /usr/bin/dns-sd -R Deer’s Mac mini (3) _jamsesh._tcp local 4747 session=Jam session https=https://x.duckdns.org",
    // The running hub's: its parent is the hub's watcher, so it stays.
    "23465 23464 /usr/bin/dns-sd -R Deer’s Mac mini (3) _jamsesh._tcp local 4747 session=Jam session project=Passport Refine",
    // Another port, another service, another program: not ours.
    "40001     1 /usr/bin/dns-sd -R Deer’s Mac mini _jamsesh._tcp local 4801 session=Other",
    "40002     1 /usr/bin/dns-sd -R Printer _ipp._tcp local 4747",
    "40003     1 /usr/bin/dns-sd -B _jamsesh._tcp local",
    "  517     1 /System/Library/Frameworks/CoreServices.framework/mds",
    "",
  ].join("\n");
  expect(leftoverAdverts(ps, "_jamsesh._tcp", 4747)).toEqual([30572, 31317]);
  // A port that's a prefix of another isn't confused with it.
  expect(leftoverAdverts("50 1 /usr/bin/dns-sd -R M _jamsesh._tcp local 47470 session=x", "_jamsesh._tcp", 4747)).toEqual([]);
  expect(leftoverAdverts("", "_jamsesh._tcp", 4747)).toEqual([]);
});

test("the project name is one short tidy line, or nothing", () => {
  expect(txtName("Passport Refine")).toBe("Passport Refine");
  expect(txtName("  two\nlines\t here ")).toBe("two lines here");
  expect(txtName("x".repeat(100))?.length).toBe(40);
  expect(txtName("   ")).toBeUndefined();
  expect(txtName(null)).toBeUndefined();
});
