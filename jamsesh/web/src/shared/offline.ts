// Offline support: a durable outbox for mutating API calls, the IndexedDB plumbing it
// shares with the audio buffer (mic.ts), and service-worker registration.
//
// The outbox sends every queued call with an `x-jam-idem` header. The hub dedupes on it,
// so a call that reached the hub but whose response was lost can be retried safely.
import { useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// A tiny external store, shared with mic.ts.

export function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const fn of listeners) fn();
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

export function uuid(): string {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {}
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

// ---------------------------------------------------------------------------
// IndexedDB tables, with an in-memory fallback (private windows, blocked storage).

export interface Table<T> {
  add(v: T): Promise<number>;
  all(): Promise<(T & { seq: number })[]>;
  delete(seq: number): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = "jamsesh-offline";
const STORES = ["outbox", "audio"] as const;
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: "seq", autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** Drop the cached connection (tests simulate a reload with this). */
export function resetDbHandle() {
  dbPromise?.then((d) => d?.close()).catch(() => {});
  dbPromise = null;
}

function wrap<R>(req: IDBRequest<R>): Promise<R> {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export function idbTable<T extends object>(store: (typeof STORES)[number]): Table<T> {
  let memSeq = 0;
  const mem = new Map<number, T & { seq: number }>();
  return {
    async add(v) {
      const db = await openDb();
      if (db) {
        try {
          const key = await wrap(db.transaction(store, "readwrite").objectStore(store).add({ ...v }));
          return Number(key);
        } catch {}
      }
      const seq = ++memSeq + 1e9; // keep memory keys apart from persisted ones
      mem.set(seq, { ...v, seq });
      return seq;
    },
    async all() {
      const db = await openDb();
      let rows: (T & { seq: number })[] = [];
      if (db) {
        try {
          rows = (await wrap(db.transaction(store).objectStore(store).getAll())) as (T & { seq: number })[];
        } catch {}
      }
      return [...rows, ...mem.values()].sort((a, b) => a.seq - b.seq);
    },
    async delete(seq) {
      if (mem.delete(seq)) return;
      const db = await openDb();
      if (db) await wrap(db.transaction(store, "readwrite").objectStore(store).delete(seq)).catch(() => {});
    },
    async clear() {
      mem.clear();
      const db = await openDb();
      if (db) await wrap(db.transaction(store, "readwrite").objectStore(store).clear()).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// Outbox

export interface OutboxEntry {
  seq?: number;
  idem: string;
  method: string;
  path: string;
  body?: unknown;
  createdAt: number;
  /** Consecutive HTTP 5xx answers; a call the hub keeps choking on is dropped. */
  serverFails: number;
}

export type SendResult = { kind: "ok" } | { kind: "drop"; status: number } | { kind: "retry"; server?: boolean } | { kind: "unauthorized" };

export interface OutboxView {
  idem: string;
  method: string;
  path: string;
  body?: unknown;
  createdAt: number;
}

export interface OutboxSnapshot {
  pending: number;
  flushing: boolean;
  /** Oldest first. Views can render these as "sending…" items. */
  items: readonly OutboxView[];
  /** Calls the hub has accepted since this page loaded. */
  synced: number;
  /** Calls given up on (hub refused them, or the queue overflowed). */
  dropped: number;
}

export const OUTBOX_MAX_ITEMS = 500;
export const OUTBOX_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const SERVER_FAIL_LIMIT = 6;

/** Exponential backoff with jitter: ~0.5-1 s, 1-2 s, 2-4 s … capped at 30 s. */
export function backoffMs(attempt: number, rand: () => number = Math.random, capMs = 30_000) {
  return Math.min(capMs, 1000 * 2 ** attempt) * (0.5 + rand() * 0.5);
}

export interface OutboxDeps {
  table: Table<OutboxEntry>;
  send: (e: OutboxEntry) => Promise<SendResult>;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  maxItems?: number;
  maxAgeMs?: number;
}

const EMPTY: OutboxSnapshot = { pending: 0, flushing: false, items: [], synced: 0, dropped: 0 };

export class Outbox {
  private entries: OutboxEntry[] = [];
  private store = createStore<OutboxSnapshot>(EMPTY);
  private flushing = false;
  private again = false;
  private attempt = 0;
  private timer: unknown = null;
  private synced = 0;
  private dropped = 0;
  private loaded: Promise<void> | null = null;
  /** Called when the hub answers 401 (device not paired / token revoked). */
  onUnauthorized: (() => void) | null = null;
  /** Called after each accepted call. */
  onSynced: ((e: OutboxEntry) => void) | null = null;
  subscribe = this.store.subscribe;
  get = this.store.get;

  constructor(private d: OutboxDeps) {}

  private now() {
    return (this.d.now ?? Date.now)();
  }

  private publish() {
    this.store.set({
      pending: this.entries.length,
      flushing: this.flushing,
      items: this.entries.map(({ idem, method, path, body, createdAt }) => ({ idem, method, path, body, createdAt })),
      synced: this.synced,
      dropped: this.dropped,
    });
  }

  /** Read whatever survived the last session. Safe to call repeatedly. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      const rows = await this.d.table.all();
      const seen = new Set(this.entries.map((e) => e.seq));
      this.entries = [...rows.filter((r) => !seen.has(r.seq)), ...this.entries].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      await this.prune();
      this.publish();
    })();
    return this.loaded;
  }

  private async prune() {
    const max = this.d.maxItems ?? OUTBOX_MAX_ITEMS;
    const cutoff = this.now() - (this.d.maxAgeMs ?? OUTBOX_MAX_AGE_MS);
    const keep: OutboxEntry[] = [];
    const drop: OutboxEntry[] = [];
    for (const e of this.entries) (e.createdAt < cutoff ? drop : keep).push(e);
    while (keep.length > max) drop.push(keep.shift()!);
    if (!drop.length) return;
    this.entries = keep;
    this.dropped += drop.length;
    await Promise.all(drop.map((e) => (e.seq != null ? this.d.table.delete(e.seq) : undefined)));
  }

  /** Queue a call. Resolves once it is durable. */
  async enqueue(method: string, path: string, body?: unknown, idem: string = uuid()): Promise<OutboxEntry> {
    await this.load();
    const e: OutboxEntry = { idem, method, path, body, createdAt: this.now(), serverFails: 0 };
    e.seq = await this.d.table.add(e);
    this.entries.push(e);
    this.entries.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    await this.prune();
    this.publish();
    void this.flush();
    return e;
  }

  private schedule() {
    if (this.timer != null) return;
    const ms = backoffMs(this.attempt++, this.d.random);
    this.timer = (this.d.setTimer ?? setTimeout)(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  /** Try now (connection came back): cancels any pending backoff and resets it. */
  kick() {
    if (this.timer != null) (this.d.clearTimer ?? clearTimeout)(this.timer as never);
    this.timer = null;
    this.attempt = 0;
    return this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      this.again = true;
      return;
    }
    await this.load();
    this.flushing = true;
    this.publish();
    try {
      do {
        this.again = false;
        await this.prune();
        while (this.entries.length) {
          const e = this.entries[0];
          const r = await this.d.send(e);
          if (r.kind === "retry") {
            if (r.server && ++e.serverFails >= SERVER_FAIL_LIMIT) {
              await this.remove(e, "dropped");
              continue;
            }
            this.schedule();
            return;
          }
          if (r.kind === "unauthorized") {
            this.onUnauthorized?.();
            return; // resumes on the next kick() after the device is paired again
          }
          await this.remove(e, r.kind === "ok" ? "synced" : "dropped");
          this.attempt = 0;
          if (r.kind === "ok") this.onSynced?.(e);
          this.publish();
        }
      } while (this.again);
    } finally {
      this.flushing = false;
      this.publish();
    }
  }

  private async remove(e: OutboxEntry, why: "synced" | "dropped") {
    this.entries = this.entries.filter((x) => x !== e);
    if (why === "synced") this.synced++;
    else this.dropped++;
    if (e.seq != null) await this.d.table.delete(e.seq);
  }

  /** Test helper. */
  stop() {
    if (this.timer != null) (this.d.clearTimer ?? clearTimeout)(this.timer as never);
    this.timer = null;
  }
}

/** Real network sender used by the app's outbox. */
export async function sendEntry(e: OutboxEntry): Promise<SendResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(`/api${e.path}`, {
      method: e.method,
      credentials: "same-origin",
      signal: ctl.signal,
      headers: {
        ...(e.body === undefined ? {} : { "content-type": "application/json" }),
        "x-jam-idem": e.idem,
        "x-jam-queued-at": String(e.createdAt),
      },
      body: e.body === undefined ? undefined : JSON.stringify(e.body),
    });
    markContact();
    if (res.ok) return { kind: "ok" };
    if (res.status === 401) return { kind: "unauthorized" };
    if (res.status >= 500 || res.status === 408 || res.status === 425 || res.status === 429) {
      // A proxy answering 502/503/504 while the hub is down is a connection problem, not the call's fault.
      return { kind: "retry", server: res.status === 500 };
    }
    return { kind: "drop", status: res.status };
  } catch {
    return { kind: "retry" };
  } finally {
    clearTimeout(timer);
  }
}

// Contact tracking lives here so offline.ts needs nothing from hub.ts.
let contactListener: (() => void) | null = null;
export function onContact(fn: () => void) {
  contactListener = fn;
}
function markContact() {
  contactListener?.();
}
export { markContact };

export const outbox = new Outbox({ table: idbTable<OutboxEntry>("outbox"), send: sendEntry });

if (typeof window !== "undefined") {
  void outbox.load().then(() => (outbox.get().pending ? outbox.kick() : undefined));
  window.addEventListener("online", () => void outbox.kick());
}

export function useOutbox() {
  return useSyncExternalStore(outbox.subscribe, outbox.get);
}

// ---------------------------------------------------------------------------
// Service worker

const updateStore = createStore(false);
let waitingReload = false;

export function useUpdateAvailable() {
  return useSyncExternalStore(updateStore.subscribe, updateStore.get);
}

/** Reload into the new version (the new worker has already taken over). */
export function applyUpdate() {
  waitingReload = true;
  location.reload();
}

/** Call once from main.tsx. Production builds only; dev servers would cache stale modules. */
export async function registerServiceWorker(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (!(import.meta as any).env?.PROD) return;
  try {
    const hadController = !!navigator.serviceWorker.controller;
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    const flag = () => {
      if (!waitingReload) updateStore.set(true);
    };
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w?.addEventListener("statechange", () => {
        if (w.state === "installed" && navigator.serviceWorker.controller) flag();
      });
    });
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type === "sw-updated" && hadController) flag();
    });
    // Look for a new version whenever the app comes back to the foreground.
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && reg.update().catch(() => {}));
  } catch {
    /* no service worker: the app still works online */
  }
}
