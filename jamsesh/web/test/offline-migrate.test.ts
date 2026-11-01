// Work saved before the host was known (the unscoped database) is picked up once the host's own database opens.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";

(globalThis as any).location ??= { origin: "http://127.0.0.1:4790", pathname: "/client", search: "" };

const put = (db: IDBDatabase, store: string, row: object) =>
  new Promise<void>((res, rej) => {
    const r = db.transaction(store, "readwrite").objectStore(store).add(row);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });

test("a queued edit and a speech segment saved before the host was known appear in the host's database after confirmation", async () => {
  // The earlier page load, host unknown: its rows are in the plain database.
  const legacy = await new Promise<IDBDatabase>((res) => {
    const req = indexedDB.open("jamsesh-offline", 1);
    req.onupgradeneeded = () => {
      for (const s of ["outbox", "audio"]) req.result.createObjectStore(s, { keyPath: "seq", autoIncrement: true });
    };
    req.onsuccess = () => res(req.result);
  });
  await put(legacy, "outbox", { idem: "i1", method: "PATCH", path: "/tasks/a", body: { n: 1 }, createdAt: Date.now(), serverFails: 0, hostId: "" });
  await put(legacy, "outbox", { idem: "i2", method: "PATCH", path: "/tasks/b", body: { n: 2 }, createdAt: Date.now(), serverFails: 0, hostId: "someone-else" });
  await put(legacy, "audio", { deviceId: "d", t0: 1, t1: 2, level: 1, noise: 0, wav: new ArrayBuffer(44) });
  legacy.close();
  // This load knows the host.
  const { setHostKey } = await import("../src/shared/identity");
  setHostKey("host-1", true);
  const { idbTable } = await import("../src/shared/offline");
  const outbox = await idbTable<any>("outbox").all();
  const audio = await idbTable<any>("audio").all();
  expect(outbox.map((r) => r.idem)).toEqual(["i1"]); // the one stamped for another host stays where it was
  expect(audio.length).toBe(1);
  // And the plain database no longer holds what moved.
  const again = await new Promise<IDBDatabase>((res) => {
    const req = indexedDB.open("jamsesh-offline", 1);
    req.onsuccess = () => res(req.result);
  });
  const left = await new Promise<any[]>((res) => {
    const r = again.transaction("outbox").objectStore("outbox").getAll();
    r.onsuccess = () => res(r.result);
  });
  expect(left.map((r) => r.idem)).toEqual(["i2"]);
});
