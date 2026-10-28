// Live connection to the hub: one WebSocket carries the whole session state and
// every change after it. Components read it through useHub().
import { useSyncExternalStore } from "react";
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

interface Snapshot {
  state: HubState | null;
  connected: boolean;
  toasts: Toast[];
  thinking: string | null;
  levels: Record<string, number>;
  speaking: string | null;
  clockOffset: number;
}

type SpeakListener = (m: { audio: string | null; mime: string; text: string }) => void;

class HubClient {
  snap: Snapshot = { state: null, connected: false, toasts: [], thinking: null, levels: {}, speaking: null, clockOffset: 0 };
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private retry = 0;
  private toastId = 0;
  private pings: { offset: number; rtt: number }[] = [];
  speakListeners = new Set<SpeakListener>();
  /** Every raw message from the hub (WebRTC signaling, share requests, …). */
  messageListeners = new Set<(m: any) => void>();

  onMessage(fn: (m: any) => void) {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }
  deviceId = "";

  start(deviceId: string) {
    this.deviceId = deviceId;
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

  private connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?device=${encodeURIComponent(this.deviceId)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.set({ connected: true });
      this.syncClock();
    };
    ws.onclose = () => {
      this.set({ connected: false });
      setTimeout(() => this.connect(), Math.min(5000, 500 * 2 ** this.retry++));
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      for (const fn of this.messageListeners) fn(m);
      this.handle(m);
    };
  }

  private syncClock() {
    this.pings = [];
    for (let i = 0; i < 6; i++) setTimeout(() => this.send({ type: "ping", t: Date.now() }), i * 250);
    setTimeout(() => this.syncClock(), 60_000);
  }

  send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
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
        this.pings.push({ rtt, offset: m.now - (m.t + rtt / 2) });
        const best = [...this.pings].sort((a, b) => a.rtt - b.rtt)[0];
        this.set({ clockOffset: best.offset });
        return;
      }
      case "state":
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

export async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

export function deviceId(kind: "host" | "client") {
  const key = `jamsesh.device.${kind}`;
  let id: string | null = null;
  try {
    id = localStorage.getItem(key);
  } catch {}
  if (!id) {
    id = `${kind}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      localStorage.setItem(key, id);
    } catch {}
  }
  return id;
}

export function pref(key: string, fallback = ""): string {
  try {
    return localStorage.getItem(`jamsesh.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

export function setPref(key: string, value: string) {
  try {
    localStorage.setItem(`jamsesh.${key}`, value);
  } catch {}
}

export function ago(ts: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}
