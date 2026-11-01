// Run in its own process (the host id is set once per page): the host becomes known while the plain database is still opening.
import "fake-indexeddb/auto";

(globalThis as any).location = { origin: "http://127.0.0.1:4790", pathname: "/client", search: "" };
(globalThis as any).navigator ??= {};

const legacy = await new Promise<IDBDatabase>((res) => {
  const req = indexedDB.open("jamsesh-offline", 1);
  req.onupgradeneeded = () => {
    for (const s of ["outbox", "audio"]) req.result.createObjectStore(s, { keyPath: "seq", autoIncrement: true });
  };
  req.onsuccess = () => res(req.result);
});
await new Promise<void>((res) => {
  const r = legacy.transaction("outbox", "readwrite").objectStore("outbox").add({ idem: "keep-me", method: "PATCH", path: "/x", createdAt: Date.now(), serverFails: 0, hostId: "" });
  r.onsuccess = () => res();
});
legacy.close();

const { idbTable } = await import("../../src/shared/offline");
const { setHostKey } = await import("../../src/shared/identity");
const pending = idbTable<any>("outbox").all(); // starts opening the plain database (no host known yet)
setHostKey("hostX", true); // ...and the host becomes known before that open finishes
const rows = await pending;
console.log(JSON.stringify({ kept: rows.some((r: any) => r.idem === "keep-me") }));
process.exit(0);
