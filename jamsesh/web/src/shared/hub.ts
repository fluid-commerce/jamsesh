// Live connection to the hub: one WebSocket carries the whole session state and
// every change after it. Components read it through useHub().
import { useSyncExternalStore } from "react";
import { currentHostKey, isHostConfirmed, readDeviceId, readPref, writePref } from "./identity";
import { markContact, onContact, outbox, uuid } from "./offline";
import type { BusMessage, HubState, JamEvent, Stage, Utterance } from "../../../hub/src/types";

export type { HubState, JamEvent, Stage, Utterance };
export type * from "../../../hub/src/types";

export interface Toast {
  id: number;
  text: string;
  detail?: string;
  tone: "info" | "directive" | "decision" | "warn";
  at: number;
}

export type ConnStatus = "connected" | "connecting" | "offline" | "unauthorized";

interface Snapshot {
  state: HubState | null;
  /** Kept for older callers: true exactly when status is "connected". */
  connected: boolean;
  status: ConnStatus;
  /** Host-time-independent: ms since epoch of the last message or response from the hub (0 = never). */
  lastContact: number;
  /** True once the first clock sample arrived; mic.ts waits for it before stamping audio. */
  clockSynced: boolean;
  /** Bumps on every (re)connect, so views can refetch what the socket doesn't carry. */
  epoch: number;
  toasts: Toast[];
  /** Feed lines the hub deleted (an agent removed with its messages), newest last. */
  removed: number[];
  thinking: string | null;
  levels: Record<string, number>;
  speaking: string | null;
  clockOffset: number;
}

type SpeakListener = (m: { audio: string | null; mime: string; text: string }) => void;

const HEARTBEAT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 8_000;
const RETRY_CAP_MS = 10_000;

/** Reconnect delay: exponential, capped, jittered to 60-100% so a restarted hub isn't stampeded. */
export function reconnectDelay(retry: number, rand: () => number = Math.random) {
  return Math.min(RETRY_CAP_MS, 400 * 2 ** retry) * (0.6 + rand() * 0.4);
}

class HubClient {
  snap: Snapshot = { state: null, connected: false, status: "connecting", lastContact: 0, clockSynced: false, epoch: 0, toasts: [], removed: [], thinking: null, levels: {}, speaking: null, clockOffset: 0 };
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private started = false;
  private retry = 0;
  private failures = 0;
  private everOpened = false;
  private toastId = 0;
  private pings: { offset: number; rtt: number }[] = [];
  private missed = 0;
  private lastRecv = 0;
  private timers: { retry?: number; connect?: number; heartbeat?: number; resync?: number; state?: number } = {};
  /** Wall-clock time of the last message/response; read directly (not reactive) by the banner. */
  lastContact = 0;
  speakListeners = new Set<SpeakListener>();
  /** Every raw message from the hub (WebRTC signaling, share requests, …). */
  messageListeners = new Set<(m: any) => void>();
  reconnectListeners = new Set<() => void>();
  /** Send the browser to /connect on 401. Tests turn this off. */
  autoRedirect = true;

  onMessage(fn: (m: any) => void) {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  /** Runs after every successful reconnect (not the first connect), e.g. to re-register the device. */
  onReconnect(fn: () => void) {
    this.reconnectListeners.add(fn);
    return () => this.reconnectListeners.delete(fn);
  }
  deviceId = "";

  start(deviceId: string) {
    this.deviceId = deviceId;
    if (this.started) return;
    this.started = true;
    onContact(() => this.touch());
    outbox.onUnauthorized = () => this.markUnauthorized();
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.retryNow());
      window.addEventListener("offline", () => this.status("offline"));
      window.addEventListener("focus", () => this.resume());
      document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && this.resume());
      window.addEventListener("pageshow", (e) => (e as PageTransitionEvent).persisted && this.resume());
    }
    this.connect();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  get = () => this.snap;

  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  private status(status: ConnStatus) {
    if (this.snap.status === status) return;
    this.set({ status, connected: status === "connected", lastContact: this.lastContact });
  }

  private touch() {
    this.lastContact = Date.now();
  }

  private clear(k: keyof HubClient["timers"]) {
    if (this.timers[k] != null) (clearTimeout(this.timers[k]), clearInterval(this.timers[k]));
    this.timers[k] = undefined;
  }

  private connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    this.clear("retry");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // Same origin: the device cookie rides along on the upgrade request.
    const ws = new WebSocket(`${proto}://${location.host}/ws?device=${encodeURIComponent(this.deviceId)}`);
    this.ws = ws;
    if (this.snap.status !== "unauthorized" && this.snap.status !== "offline") this.status("connecting");
    this.clear("connect");
    this.timers.connect = window.setTimeout(() => ws.readyState === WebSocket.CONNECTING && this.closed(ws), CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      this.clear("connect");
      const reconnect = this.everOpened;
      this.everOpened = true;
      this.retry = 0;
      this.failures = 0;
      this.missed = 0;
      this.touch();
      this.lastRecv = Date.now();
      this.set({ epoch: this.snap.epoch + 1 });
      this.status("connected");
      this.startHeartbeat();
      this.syncClock();
      // The hub sends {type:"state"} on open; if it somehow doesn't, fetch it.
      this.clear("state");
      this.timers.state = window.setTimeout(() => this.refreshState().catch(() => {}), 2500);
      void outbox.kick();
      if (reconnect) for (const fn of this.reconnectListeners) fn();
    };
    ws.onclose = () => this.closed(ws);
    ws.onerror = () => {};
    ws.onmessage = (e) => {
      this.touch();
      this.lastRecv = Date.now();
      this.missed = 0;
      // The socket survived an offline blip (browser said offline, nothing actually closed).
      if (this.snap.status === "offline" || this.snap.status === "connecting") this.status("connected");
      let m: any;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      for (const fn of this.messageListeners) fn(m);
      this.handle(m);
    };
  }

  /** The socket is gone (closed, failed to open, or declared dead). */
  private closed(ws: WebSocket) {
    if (ws !== this.ws) return;
    ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
    try {
      ws.close();
    } catch {}
    this.ws = null;
    this.clear("connect");
    this.clear("heartbeat");
    this.clear("resync");
    this.clear("state");
    this.failures++;
    if (this.snap.status !== "unauthorized") this.status(navigator.onLine === false || this.failures >= 2 ? "offline" : "connecting");
    if (this.snap.status !== "unauthorized") this.scheduleRetry();
    void this.probe();
  }

  private scheduleRetry() {
    this.clear("retry");
    this.timers.retry = window.setTimeout(() => this.connect(), reconnectDelay(this.retry++));
  }

  private probing = false;
  /** A WebSocket can't report a 401, so ask the API whether we're still paired. */
  private async probe() {
    if (this.probing) return;
    this.probing = true;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch("/api/clock", { cache: "no-store", credentials: "same-origin", signal: ctl.signal }).finally(() => clearTimeout(t));
      this.touch();
      if (res.status === 401) this.markUnauthorized();
      else if (this.snap.status === "unauthorized") {
        this.status("connecting");
        this.retryNow();
      }
    } catch {
      /* unreachable: the retry timer keeps going */
    } finally {
      this.probing = false;
    }
  }

  /** The hub says this device isn't paired (or its token was revoked). */
  markUnauthorized() {
    this.clear("retry");
    this.status("unauthorized");
    this.ws?.close();
    if (this.autoRedirect) goToConnect();
  }

  /** Try right now: network came back, tab woke up, or the user pressed a button. */
  retryNow() {
    if (!this.started) return;
    this.retry = 0;
    if (this.snap.status === "unauthorized") return void this.probe(); // reconnects itself if the 401 cleared
    void outbox.kick();
    if (this.ws?.readyState === WebSocket.OPEN) return this.verifyLive();
    if (this.ws?.readyState === WebSocket.CONNECTING) return;
    this.clear("retry");
    this.connect();
    void this.probe();
  }

  private resume() {
    if (this.snap.status === "connected") this.verifyLive();
    else this.retryNow();
  }

  /** After sleep or a network change an OPEN socket may be dead: ping and give it 4 s. */
  private verifyLive() {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return;
    const since = Date.now();
    this.send({ type: "ping", t: Date.now() });
    window.setTimeout(() => this.ws === ws && this.lastRecv < since && this.closed(ws), 4000);
  }

  private startHeartbeat() {
    this.clear("heartbeat");
    this.timers.heartbeat = window.setInterval(() => {
      const ws = this.ws;
      if (ws?.readyState !== WebSocket.OPEN) return;
      if (this.missed >= 2) return this.closed(ws); // two pings unanswered: dead
      this.missed++;
      this.send({ type: "ping", t: Date.now() });
    }, HEARTBEAT_MS);
  }

  private syncClock() {
    this.pings = [];
    this.clear("resync");
    for (let i = 0; i < 6; i++) window.setTimeout(() => this.send({ type: "ping", t: Date.now() }), i * 250);
    this.timers.resync = window.setTimeout(() => this.syncClock(), 60_000);
  }

  send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Authoritative state over HTTP (fallback when the socket's own state message is missing). */
  async refreshState() {
    const state = await api<HubState>("/state");
    this.set({ state });
  }

  /** Host time now, for stamping audio. */
  now() {
    return Date.now() + this.snap.clockOffset;
  }

  private handle(m: BusMessage | { type: "pong"; t: number; now: number }) {
    const s = this.snap.state;
    switch (m.type) {
      case "pong": {
        const t1 = Date.now();
        const rtt = t1 - m.t;
        this.pings = [...this.pings, { rtt, offset: m.now - (m.t + rtt / 2) }].slice(-12);
        const best = [...this.pings].sort((a, b) => a.rtt - b.rtt)[0];
        this.set({ clockOffset: best.offset, clockSynced: true });
        return;
      }
      case "state":
        // Authoritative. Queued-but-unsent work lives in the outbox (useOutbox().items), never in state.
        this.clear("state");
        return this.set({ state: m.state });
      case "patch":
        if (s) this.set({ state: { ...s, [m.key]: m.value } });
        return;
      case "event": {
        if (!s) return;
        const i = s.events.findIndex((e) => e.id === m.event.id);
        const events = i >= 0 ? s.events.map((e) => (e.id === m.event.id ? m.event : e)) : [...s.events, m.event].slice(-400);
        return this.set({ state: { ...s, events } });
      }
      case "events-removed": {
        const gone = new Set(m.ids);
        this.set({ removed: [...this.snap.removed, ...m.ids].slice(-500) });
        if (s) this.set({ state: { ...s, events: s.events.filter((e) => !gone.has(e.id)) } });
        return;
      }
      case "utterance": {
        if (!s) return;
        const i = s.utterances.findIndex((u) => u.id === m.utterance.id);
        const utterances = i >= 0 ? s.utterances.map((u) => (u.id === m.utterance.id ? m.utterance : u)) : [...s.utterances, m.utterance].slice(-300);
        return this.set({ state: { ...s, utterances } });
      }
      case "stage":
        if (s) this.set({ state: { ...s, stage: m.stage } });
        return;
      case "toast": {
        const t: Toast = { id: ++this.toastId, text: m.text, detail: m.detail, tone: m.tone, at: Date.now() };
        this.set({ toasts: [...this.snap.toasts, t].slice(-4) });
        setTimeout(() => this.set({ toasts: this.snap.toasts.filter((x) => x.id !== t.id) }), m.tone === "directive" || m.tone === "warn" ? 9000 : 6000);
        return;
      }
      case "thinking":
        return this.set({ thinking: m.on ? m.label ?? "Thinking" : null });
      case "level":
        return this.set({ levels: { ...this.snap.levels, [m.deviceId]: m.level } });
      case "share-ended": {
        // The hub ended a share of this device (replaced, or its tile left the big screen): say so once.
        if (m.text && m.deviceId === this.deviceId) {
          const t: Toast = { id: ++this.toastId, text: m.text, tone: "info", at: Date.now() };
          this.set({ toasts: [...this.snap.toasts, t].slice(-4) });
          setTimeout(() => this.set({ toasts: this.snap.toasts.filter((x) => x.id !== t.id) }), 7000);
        }
        return;
      }
      case "rtc":
      case "share-request":
        return;
      case "speak":
        this.set({ speaking: m.text });
        for (const fn of this.speakListeners) fn(m);
        setTimeout(() => this.snap.speaking === m.text && this.set({ speaking: null }), Math.max(3000, m.text.length * 70));
        return;
    }
  }
}

export const hub = new HubClient();

export function useHub() {
  return useSyncExternalStore(hub.subscribe, hub.get);
}

/** Calls that must never wait in the outbox: they only make sense live. */
// Not worth replaying later, or unsafe to: approvals must be live, and a screen size is only worth
// reporting now.
const NEVER_QUEUE = /^\/(drive\/|audio|stage\/expand|pair|invite|hooks\/|agents\/|shares\/request|debug\/|build-requests\/|display|prompt-window|record\/|shares$)/;

export class OfflineError extends Error {
  constructor(msg = "Can't reach the hub right now.") {
    super(msg);
    this.name = "OfflineError";
  }
}

export interface ApiOptions {
  /** false: never queue this call, throw OfflineError instead. */
  queue?: boolean;
  timeoutMs?: number;
}

/** What api() resolves to when a mutation was saved for later instead of sent. */
export interface QueuedResult {
  ok: true;
  queued: true;
  idem: string;
}

/**
 * Talks to the hub. Mutations (POST/PATCH/DELETE) that can't be delivered right now are
 * saved on this laptop and sent later in order, each with an `x-jam-idem` key so the hub
 * applies it once; the caller gets `{ ok: true, queued: true, idem }` back. GETs fail fast.
 */
export async function api<T = any>(path: string, body?: unknown, method?: string, opts: ApiOptions = {}): Promise<T> {
  const m = (method ?? (body === undefined ? "GET" : "POST")).toUpperCase();
  const mutating = m !== "GET" && m !== "HEAD";
  const queueable = mutating && opts.queue !== false && !NEVER_QUEUE.test(path);
  const idem = mutating ? uuid() : undefined;
  const save = async () => {
    await outbox.enqueue(m, path, body, idem);
    return { ok: true, queued: true, idem } as unknown as T;
  };

  // Older persisted calls must be loaded first, or they could replay over this newer one.
  if (queueable) await outbox.load();
  // Keep order: nothing jumps ahead of calls that are still waiting to go out.
  if (queueable && (outbox.get().pending > 0 || navigator.onLine === false)) return save();
  if (navigator.onLine === false) throw new OfflineError();

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? (mutating ? 10_000 : 8_000));
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: m,
      credentials: "same-origin",
      signal: ctl.signal,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idem ? { "x-jam-idem": idem, "x-jam-queued-at": String(Date.now()) } : {}),
        ...(mutating && isHostConfirmed() && currentHostKey() ? { "x-jam-host": currentHostKey() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // The call may or may not have reached the hub; the same idem key makes the retry safe.
    if (queueable) return save();
    throw new OfflineError();
  } finally {
    clearTimeout(timer);
  }
  markContact();
  if (res.status === 401) {
    hub.markUnauthorized();
    if (queueable) return save(); // keep the work; it sends once this laptop is paired again
    throw new Error("This laptop isn't connected to the session.");
  }
  const text = await res.text().catch(() => "");
  const json = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  })();
  if (!res.ok) {
    // A proxy answering 502/503/504 while the hub restarts is a connection problem.
    if (queueable && [502, 503, 504].includes(res.status)) return save();
    // The relay moved to another host while this was on its way: the change is still wanted. It
    // waits in the outbox, with the same idempotency key and host stamp, until its own host is back.
    if (res.status === 409 && /different JamSesh host/i.test(text)) {
      if (queueable) return save();
      throw Object.assign(new Error("That was meant for the host this window was showing; it changed. Try again."), { status: 409 });
    }
    throw Object.assign(new Error(json.error ?? `HTTP ${res.status}`), { status: res.status });
  }
  return json as T;
}

let redirected = 0;
/** Unpaired: go to the connect page, coming back to this page afterwards. */
export function goToConnect() {
  if (typeof location === "undefined" || location.pathname.startsWith("/connect")) return;
  if (Date.now() - redirected < 5000) return; // never loop
  redirected = Date.now();
  location.assign(connectUrl());
}

export function connectUrl() {
  return `/connect?next=${encodeURIComponent(location.pathname + location.search)}`;
}

export function deviceId(kind: string) {
  return readDeviceId(kind);
}

export function pref(key: string, fallback = ""): string {
  return readPref(key, fallback);
}

export function setPref(key: string, value: string) {
  writePref(key, value);
}

export function ago(ts: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}
