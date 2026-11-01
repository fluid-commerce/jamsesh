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
  const { idbTable, resetDbHandle } = await import("../src/shared/offline");
  resetDbHandle(); // another test file may have opened the plain database first in this process
  const outbox = await idbTable<any>("outbox").all();
  const audio = await idbTable<any>("audio").all();
  expect(outbox.map((r) => r.idem)).toContain("i1");
  expect(outbox.map((r) => r.idem)).not.toContain("i2"); // the one stamped for another host stays where it was
  expect(audio.filter((r) => r.t0 === 1).length).toBe(1);
  // And the plain database no longer holds what moved.
  const again = await new Promise<IDBDatabase>((res) => {
    const req = indexedDB.open("jamsesh-offline", 1);
    req.onsuccess = () => res(req.result);
  });
  const left = await new Promise<any[]>((res) => {
    const r = again.transaction("outbox").objectStore("outbox").getAll();
    r.onsuccess = () => res(r.result);
  });
  expect(left.map((r) => r.idem)).toContain("i2");
  expect(left.map((r) => r.idem)).not.toContain("i1");
});

test("a migration that fails after copying leaves the old rows in place, and the retry doesn't copy them twice", async () => {
  const { idbTable, resetDbHandle } = await import("../src/shared/offline");
  const legacy = await new Promise<IDBDatabase>((res) => {
    const req = indexedDB.open("jamsesh-offline", 1);
    req.onupgradeneeded = () => {
      for (const s of ["outbox", "audio"]) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: "seq", autoIncrement: true });
    };
    req.onsuccess = () => res(req.result);
  });
  await put(legacy, "outbox", { idem: "i9", method: "PATCH", path: "/tasks/z", body: {}, createdAt: Date.now(), serverFails: 0, hostId: "" });
  // The removal from the old database fails once (as a quota or abort would): the copy has been made, the original stays.
  const realTx = legacy.transaction.bind(legacy);
  legacy.close();
  resetDbHandle();
  const open = indexedDB.open.bind(indexedDB);
  let failDrop = true;
  (indexedDB as any).open = (name: string, v?: number) => {
    const req: any = open(name, v);
    if (name !== "jamsesh-offline") return req;
    req.addEventListener("success", () => {
      const db = req.result;
      const tx = db.transaction.bind(db);
      db.transaction = (stores: any, mode?: any) => {
        const t = tx(stores, mode);
        if (mode === "readwrite" && failDrop) {
          failDrop = false;
          setTimeout(() => {
            try {
              t.abort();
            } catch {} // already finished
          }, 0);
        }
        return t;
      };
    });
    return req;
  };
  try {
    const first = await idbTable<any>("outbox").all();
    expect(first.filter((r) => r.idem === "i9").length).toBe(1); // copied, and visible even though the removal failed
  } finally {
    (indexedDB as any).open = open;
  }
  resetDbHandle();
  const again = await idbTable<any>("outbox").all();
  expect(again.filter((r) => r.idem === "i9").length).toBe(1); // not copied a second time
  void realTx;
});

test("a write is reported saved only when its transaction commits: an abort right after the request succeeded falls back to memory", async () => {
  const { idbTable, resetDbHandle } = await import("../src/shared/offline");
  resetDbHandle();
  const open = indexedDB.open.bind(indexedDB);
  (indexedDB as any).open = (name: string, v?: number) => {
    const req: any = open(name, v);
    req.addEventListener("success", () => {
      const db = req.result;
      const tx = db.transaction.bind(db);
      db.transaction = (stores: any, mode?: any) => {
        const t = tx(stores, mode);
        if (mode === "readwrite") {
          const os = t.objectStore;
          t.objectStore = (n: string) => {
            const store = os.call(t, n);
            const add = store.add.bind(store);
            store.add = (v: any) => {
              const r = add(v);
              r.addEventListener("success", () => t.abort()); // the request succeeded, then the transaction is lost
              return r;
            };
            return store;
          };
        }
        return t;
      };
    });
    return req;
  };
  try {
    const seq = await idbTable<any>("audio").add({ deviceId: "x", t0: 9, t1: 10 });
    expect(seq).toBeGreaterThan(1e9); // held in memory only, and said so by its key
  } finally {
    (indexedDB as any).open = open;
    resetDbHandle();
  }
  const rows = await idbTable<any>("audio").all();
  expect(rows.some((r) => r.t0 === 9)).toBe(false); // nothing half-written reached the database
});

test("speech captured for another host is not moved into this host's database", async () => {
  const { idbTable, resetDbHandle } = await import("../src/shared/offline");
  const legacy = await new Promise<IDBDatabase>((res) => {
    const req = indexedDB.open("jamsesh-offline", 1);
    req.onupgradeneeded = () => {
      for (const s of ["outbox", "audio"]) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: "seq", autoIncrement: true });
    };
    req.onsuccess = () => res(req.result);
  });
  await put(legacy, "audio", { deviceId: "d", t0: 77, t1: 78, level: 1, noise: 0, wav: new ArrayBuffer(44), hostId: "host-other" });
  await put(legacy, "audio", { deviceId: "d", t0: 79, t1: 80, level: 1, noise: 0, wav: new ArrayBuffer(44), hostId: "host-1" });
  legacy.close();
  resetDbHandle();
  const rows = await idbTable<any>("audio").all();
  expect(rows.some((r) => r.t0 === 77)).toBe(false);
  expect(rows.some((r) => r.t0 === 79)).toBe(true);
});
