// The message box's attachment helpers: the pre-upload check, the upload call itself (the real
// fetch path, as the client makes it), and files from a paste or a drop.
import { afterEach, expect, test } from "bun:test";
import { checkFile, filesFrom, pastedName, uploadAttachment } from "../src/shared/attach";

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
