// The message box's attachment helpers: the pre-upload check, the upload call itself (the real
// fetch path, as the client makes it), and files from a paste or a drop.
import { afterEach, expect, test } from "bun:test";
import { checkFile, composerState, filesFrom, pastedName, uploadAttachment, type Pending } from "../src/shared/attach";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("checkFile turns away what the hub would, before anything uploads", () => {
  expect(checkFile({ name: "a.png", type: "image/png", size: 100 })).toBeNull();
  expect(checkFile({ name: "notes.md", type: "", size: 100 })).toBeNull();
  expect(checkFile({ name: "spec.pdf", type: "application/pdf", size: 5_000_000 })).toBeNull();
  expect(checkFile({ name: "a.png", type: "image/png", size: 0 })).toMatch(/empty/);
  expect(checkFile({ name: "a.png", type: "image/png", size: 13 * 1024 * 1024 })).toMatch(/12 MB/);
  expect(checkFile({ name: "big.txt", type: "text/plain", size: 2 * 1024 * 1024 })).toMatch(/1 MB/);
  expect(checkFile({ name: "logo.svg", type: "image/svg+xml", size: 100 })).toMatch(/images, PDFs and text/);
  expect(checkFile({ name: "app.exe", type: "application/x-msdownload", size: 100 })).toMatch(/images, PDFs and text/);
});

test("uploadAttachment posts one file as form data with the page's credentials and returns the ref", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ id: "att_0123456789abcdef", name: "a.png", type: "image/png", kind: "image", size: 3 }), { status: 200 });
  }) as any;
  const ref = await uploadAttachment(new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
  expect(ref.id).toBe("att_0123456789abcdef");
  expect(seen!.url).toBe("/api/attachments");
  expect(seen!.init.method).toBe("POST");
  expect(seen!.init.credentials).toBe("same-origin");
  const sent = (seen!.init.body as FormData).get("file") as File;
  expect(sent.name).toBe("a.png");
  expect(sent.size).toBe(3);
});

test("uploadAttachment says why: the hub's reason, a lost connection", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Images must be under 12 MB." }), { status: 413 })) as any;
  await expect(uploadAttachment(new File([new Uint8Array([1])], "a.png"))).rejects.toThrow("Images must be under 12 MB.");
  globalThis.fetch = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as any;
  await expect(uploadAttachment(new File([new Uint8Array([1])], "a.png"))).rejects.toThrow("Upload failed (502)");
  globalThis.fetch = (async () => {
    throw new TypeError("network");
  }) as any;
  await expect(uploadAttachment(new File([new Uint8Array([1])], "a.png"))).rejects.toThrow(/Couldn't reach the room/);
});

test("filesFrom reads a paste or a drop, and a pasted screenshot says what it is", () => {
  expect(pastedName("image.png")).toBe("Pasted image.png");
  expect(pastedName("IMAGE.JPG")).toBe("Pasted image.JPG");
  expect(pastedName("brief.md")).toBe("brief.md");
  expect(pastedName("my image.png")).toBe("my image.png");
  const doc = new File([new Uint8Array([1])], "brief.md");
  const second = new File([new Uint8Array([1])], "two.txt");
  expect(filesFrom({ files: [doc, second], items: [] } as any).map((f) => f.name)).toEqual(["brief.md", "two.txt"]);
  expect(filesFrom(null)).toEqual([]);
  expect(filesFrom({ files: [], items: [{ kind: "string", getAsFile: () => null }] } as any)).toEqual([]);
  expect(filesFrom({ files: [], items: [{ kind: "file", getAsFile: () => doc }] } as any)).toEqual([doc]);
});

test("the composer won't send while a file has failed: the person removes it or tries again first", () => {
  const ready: Pending = { key: "a", name: "a.png", size: 3, status: "ready", ref: { id: "att_0123456789abcdef", name: "a.png", type: "image/png", kind: "image", size: 3 } };
  const failed: Pending = { key: "b", name: "spec.pdf", size: 9, status: "error", error: "Upload failed (502)", file: new File([new Uint8Array([1])], "spec.pdf") };
  const adding: Pending = { key: "c", name: "c.png", size: 3, status: "uploading" };
  expect(composerState("look at this", [ready])).toEqual({ canSend: true, blocked: "" });
  expect(composerState("", [ready])).toEqual({ canSend: true, blocked: "" });
  expect(composerState("", [])).toEqual({ canSend: false, blocked: "" });
  expect(composerState("look at this", [ready, adding]).canSend).toBe(false);
  // Words alone would send, but a failed file is never dropped from the message silently.
  const blocked = composerState("look at this", [ready, failed]);
  expect(blocked.canSend).toBe(false);
  expect(blocked.blocked).toBe("A file didn't attach. Remove it or try again to send.");
  expect(composerState("x", [failed, { ...failed, key: "d" }]).blocked).toMatch(/^2 files didn't attach/);
  expect(composerState("look at this", [ready], true).canSend).toBe(false);
});

test("the composer doesn't offer Send for a set the hub would turn away: more than six files, or more than 25 MB together", () => {
  const ready = (n: number, size = 100): Pending => ({ key: `k${n}`, name: `f${n}.pdf`, size, status: "ready", ref: { id: `att_${n}`, name: `f${n}.pdf`, type: "application/pdf", kind: "pdf", size } });
  expect(composerState("", [ready(1), ready(2)]).canSend).toBe(true);
  const seven = [1, 2, 3, 4, 5, 6, 7].map((n) => ready(n));
  const many = composerState("hi", seven);
  expect(many.canSend).toBe(false);
  expect(many.blocked).toMatch(/Up to 6 files/);
  const big = composerState("hi", [ready(1, 20 * 1024 * 1024), ready(2, 20 * 1024 * 1024)]);
  expect(big.canSend).toBe(false);
  expect(big.blocked).toMatch(/25 MB/);
  // A failed file doesn't count toward the limits (it's blocked for its own reason).
  expect(composerState("hi", [...[1, 2, 3, 4, 5, 6].map((n) => ready(n)), { key: "x", name: "bad.pdf", size: 9, status: "error", error: "no" }]).blocked).toMatch(/didn't attach/);
});

test("openDevServer opens the link the hub made the way a dev tile is opened (localized), keeps its one-time code, and closes its tab with a message when no link comes", async () => {
  const { openDevServer } = await import("../src/shared/ui");
  const g = globalThis as any;
  const saved = { window: g.window, location: g.location, alert: g.alert, fetch: globalThis.fetch };
  try {
    const opened: string[] = [];
    const tab = { location: { href: "" }, closed: false, close() { this.closed = true; } };
    const messages: string[] = [];
    g.window = { open: (u: string) => (opened.push(u), tab), alert: (m: string) => void messages.push(m) };
    g.navigator = { onLine: true };
    // The host's own window on 127.0.0.1: the LAN address becomes localhost, the code stays.
    g.location = { hostname: "127.0.0.1", protocol: "http:", host: "127.0.0.1:4790" };
    globalThis.fetch = (async () => new Response(JSON.stringify({ url: "http://192.168.1.20:5100/app?jam_code=abc123" }), { status: 200 })) as any;
    await openDevServer("http://192.168.1.20:5100/app");
    expect(tab.location.href).toBe("http://localhost:5100/app?jam_code=abc123");
    // A remote client on the public address reaches it on the dev subdomain.
    g.location = { hostname: "room.example.net", protocol: "https:", host: "room.example.net" };
    tab.location.href = "";
    await openDevServer("http://192.168.1.20:5100/app");
    expect(tab.location.href).toBe("https://dev-5100.room.example.net/app?jam_code=abc123");
    // A named host, and a hash route, on the public address.
    tab.location.href = "";
    globalThis.fetch = (async () => new Response(JSON.stringify({ url: "http://jamsesh-host.local:5100/app?jam_code=abc123#/board" }), { status: 200 })) as any;
    await openDevServer("http://jamsesh-host.local:5100/app");
    expect(tab.location.href).toBe("https://dev-5100.room.example.net/app?jam_code=abc123#/board");
    // No link: the tab closes and the person is told.
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "That isn't one of this session's dev servers." }), { status: 404 })) as any;
    await openDevServer("http://192.168.1.20:5100/app");
    expect(tab.closed).toBe(true);
    expect(messages.at(-1)).toContain("dev server");
  } finally {
    Object.assign(g, saved);
  }
});
