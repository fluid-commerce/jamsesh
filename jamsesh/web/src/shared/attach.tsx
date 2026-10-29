// Attachments in the message box and in the feed (SPEC 12.6). The hub decides what is allowed; the
// checks here only save a round trip, so a wrong file is told off before it uploads.
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { hub, type AttachmentRef } from "./hub";

export type { AttachmentRef };

export const MAX_FILES = 6;
const MB = 1024 * 1024;
const TEXT_EXT = /\.(txt|md|markdown|json|csv|tsv|log|ya?ml|toml|ini|css|jsx?|tsx?|py|rs|go|swift|kt|sql|sh|rb|java|c|h|cpp)$/i;

export const attachmentUrl = (id: string) => `/api/attachments/${id}`;

export function sizeLabel(n: number) {
  return n < 1024 ? `${n} B` : n < MB ? `${Math.round(n / 1024)} KB` : `${(n / MB).toFixed(1)} MB`;
}

/** A quick look before uploading; the hub checks the bytes itself. Returns what's wrong, or null. */
export function checkFile(f: { name: string; type: string; size: number }): string | null {
  if (!f.size) return "That file is empty.";
  const image = /^image\/(png|jpeg|gif|webp)$/.test(f.type);
  const pdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  const text = TEXT_EXT.test(f.name) || f.type.startsWith("text/") || !/\.[a-z0-9]{1,8}$/i.test(f.name);
  if (!image && !pdf && !text) return "JamSesh takes images, PDFs and text files.";
  if (image && f.size > 12 * MB) return "Images must be under 12 MB.";
  if (pdf && f.size > 20 * MB) return "PDFs must be under 20 MB.";
  if (!image && !pdf && f.size > MB) return "Text files must be under 1 MB.";
  return null;
}

/** Sends one file to the hub; resolves to what the message should carry. */
export async function uploadAttachment(file: File, signal?: AbortSignal): Promise<AttachmentRef> {
  const form = new FormData();
  form.set("file", file, file.name);
  let res: Response;
  try {
    res = await fetch("/api/attachments", { method: "POST", body: form, credentials: "same-origin", signal });
  } catch {
    throw new Error("Couldn't reach the room. Try again.");
  }
  if (res.status === 401) {
    hub.markUnauthorized();
    throw new Error("This laptop isn't connected to the session.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Upload failed (${res.status})`);
  return body as AttachmentRef;
}

export interface Pending {
  key: string;
  name: string;
  size: number;
  /** A local preview for images, revoked when the chip goes. */
  preview?: string;
  status: "uploading" | "ready" | "error";
  ref?: AttachmentRef;
  error?: string;
  /** The file itself, while it can be tried again (an upload that failed on the way, not one turned away up front). */
  file?: File;
}

/**
 * Whether the composer can send: words or a ready file, nothing still adding, and no file that failed. A failed
 * file is never dropped from a send: the person removes it or tries it again first. `blocked` says why not.
 */
export function composerState(text: string, items: Pending[], busy = false): { canSend: boolean; blocked: string } {
  const failed = items.filter((i) => i.status === "error").length;
  const uploading = items.some((i) => i.status === "uploading");
  const ready = items.some((i) => i.status === "ready");
  const blocked = failed ? `${failed === 1 ? "A file" : `${failed} files`} didn't attach. Remove ${failed === 1 ? "it" : "them"} or try again to send.` : "";
  return { canSend: (!!text.trim() || ready) && !uploading && !failed && !busy, blocked };
}

/** The files waiting to go with a message: adding, uploading, removing. */
export function useAttachments(upload: typeof uploadAttachment = uploadAttachment) {
  const [items, setItems] = useState<Pending[]>([]);
  const live = useRef(items);
  live.current = items;
  const patch = (key: string, p: Partial<Pending>) => setItems((cur) => cur.map((i) => (i.key === key ? { ...i, ...p } : i)));

  const send = useCallback(
    (key: string, f: File) =>
      upload(f).then(
        (ref) => patch(key, { status: "ready", ref, file: undefined }),
        (e) => patch(key, { status: "error", error: e instanceof Error ? e.message : String(e), file: f }),
      ),
    [upload],
  );
  const add = useCallback(
    (files: File[]) => {
      const room = MAX_FILES - live.current.filter((i) => i.status !== "error").length;
      const take = files.slice(0, Math.max(0, room));
      const next: Pending[] = take.map((f) => {
        const problem = checkFile(f);
        return {
          key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: f.name || "file",
          size: f.size,
          preview: !problem && f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
          status: problem ? "error" : "uploading",
          error: problem ?? undefined,
        } as Pending;
      });
      if (files.length > take.length) next.push({ key: `over-${Date.now()}`, name: `${files.length - take.length} more`, size: 0, status: "error", error: `Up to ${MAX_FILES} files per message.` });
      setItems((cur) => [...cur, ...next]);
      take.forEach((f, i) => {
        if (next[i].status === "uploading") void send(next[i].key, f);
      });
    },
    [send],
  );
  /** Uploads a file that failed on the way again. */
  const retry = useCallback(
    (key: string) => {
      const f = live.current.find((i) => i.key === key && i.status === "error")?.file;
      if (!f) return;
      patch(key, { status: "uploading", error: undefined });
      void send(key, f);
    },
    [send],
  );
  const remove = useCallback((key: string) => {
    setItems((cur) => {
      const gone = cur.find((i) => i.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return cur.filter((i) => i.key !== key);
    });
  }, []);
  const clear = useCallback(() => {
    for (const i of live.current) if (i.preview) URL.revokeObjectURL(i.preview);
    setItems([]);
  }, []);
  useEffect(
    () => () => {
      live.current.forEach((i) => i.preview && URL.revokeObjectURL(i.preview));
    },
    [],
  );
  return {
    items,
    add,
    remove,
    retry,
    clear,
    uploading: items.some((i) => i.status === "uploading"),
    failed: items.filter((i) => i.status === "error").length,
    ids: items.flatMap((i) => (i.status === "ready" && i.ref ? [i.ref.id] : [])),
  };
}

/** Files from a paste or a drop, whichever way the browser hands them over. */
export function filesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out = [...data.files];
  if (!out.length) for (const it of data.items ?? []) if (it.kind === "file") out.push(...(it.getAsFile() ? [it.getAsFile()!] : []));
  // A pasted screenshot arrives called "image.png"; say what it is.
  return out.map((f) => (pastedName(f.name) !== f.name ? new File([f], pastedName(f.name), { type: f.type }) : f));
}

/** What a pasted screenshot is called: browsers name every one "image.png". */
export const pastedName = (name: string) => (/^image\.(png|jpe?g|gif|webp)$/i.test(name) ? `Pasted image.${name.split(".").pop()}` : name);

export const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");

const ClipIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
  </svg>
);
const DocIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4" />
  </svg>
);

/** The button that opens the file picker. */
export function AttachButton({ onFiles, disabled }: { onFiles: (f: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="say-attach" aria-label="Attach images or files" title="Attach images or files" disabled={disabled} onClick={() => input.current?.click()}>
        <ClipIcon />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.json,.csv,.log,.yml,.yaml"
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </>
  );
}

/** What's waiting to go: a thumbnail for pictures, a chip for files, with a way to take each back out (or try a failed one again). */
export function AttachTray({ items, onRemove, onRetry }: { items: Pending[]; onRemove: (key: string) => void; onRetry?: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <ul className="say-files" aria-label="Attached files">
      {items.map((i) => (
        <li key={i.key} className={`say-file ${i.preview ? "pic" : ""} ${i.status}`} title={i.error ?? i.name}>
          {i.preview ? <img src={i.preview} alt={i.name} /> : <DocIcon />}
          {!i.preview && (
            <span className="say-file-text">
              <span className="say-file-name">{i.name}</span>
              <span className="say-file-meta">{i.status === "error" ? i.error : i.status === "uploading" ? "Adding…" : sizeLabel(i.size)}</span>
            </span>
          )}
          {i.preview && i.status !== "ready" && <span className="say-file-badge">{i.status === "error" ? "!" : "…"}</span>}
          {i.status === "error" && i.file && onRetry && (
            <button type="button" className="say-file-retry" aria-label={`Try ${i.name} again`} title="Try again" onClick={() => onRetry(i.key)}>
              ↻
            </button>
          )}
          <button type="button" className="say-file-x" aria-label={`Remove ${i.name}`} onClick={() => onRemove(i.key)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Attachments on a feed line: pictures as thumbnails that open full size, files as chips that download. */
export function FeedAttachments({ list }: { list: AttachmentRef[] }) {
  if (!list?.length) return null;
  return (
    <span className="feed-files">
      {list.map((a) =>
        a.kind === "image" ? (
          <a key={a.id} className="feed-pic" href={attachmentUrl(a.id)} target="_blank" rel="noreferrer" title={a.name}>
            <img src={attachmentUrl(a.id)} alt={a.name} loading="lazy" />
          </a>
        ) : (
          <a key={a.id} className="feed-chip" href={attachmentUrl(a.id)} target="_blank" rel="noreferrer" download={a.kind === "pdf" ? a.name : undefined} title={a.name}>
            <DocIcon />
            <span className="say-file-name">{a.name}</span>
            <span className="say-file-meta">{sizeLabel(a.size)}</span>
          </a>
        ),
      )}
    </span>
  );
}
