// Small WebRTC layer for screen and camera shares.
//
// Topology: the publisher (the device that is sharing) holds one RTCPeerConnection per viewer and
// always makes the offer. A viewer asks with {op:"want"}; the hub relays signaling between devices
// as {type:"rtc", to, data} -> {type:"rtc", from, to, data}. LAN only by default (host candidates).

import { useEffect, useState, useSyncExternalStore } from "react";
import { api, hub, type Share } from "./hub";

type Kind = Share["kind"];

type Signal =
  | { op: "want"; shareId: string }
  | { op: "offer"; shareId: string; pc: string; sdp: string }
  | { op: "answer"; shareId: string; pc: string; sdp: string }
  | { op: "ice"; shareId: string; pc: string; candidate: RTCIceCandidateInit | null }
  | { op: "bye"; shareId: string };

let iceServers: RTCIceServer[] = [];
/** LAN needs none. Pass STUN/TURN servers here if the room ever spans networks. */
export function configureRtc(opts: { iceServers?: RTCIceServer[] }) {
  if (opts.iceServers) iceServers = opts.iceServers;
}

const rid = () => Math.random().toString(36).slice(2, 10);
const send = (to: string, data: Signal) => hub.send({ type: "rtc", to, data });

export function mediaAvailable(): string | null {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) {
    return "Sharing needs a secure page (https or localhost).";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------------------------

export interface Publication {
  shareId: string;
  kind: Kind;
  stream: MediaStream;
}

interface PubInternal extends Publication {
  peers: Map<string, { pc: RTCPeerConnection; id: string; queued: RTCIceCandidateInit[]; ready: boolean }>;
  stopped: boolean;
}

const pubs = new Map<string, PubInternal>();
const pubListeners = new Set<() => void>();
let pubSnapshot: Publication[] = [];

function publishChanged() {
  pubSnapshot = [...pubs.values()].map(({ shareId, kind, stream }) => ({ shareId, kind, stream }));
  for (const fn of pubListeners) fn();
}

/** What this device is publishing right now. */
export function usePublications(): Publication[] {
  return useSyncExternalStore(
    (fn) => (pubListeners.add(fn), () => pubListeners.delete(fn)),
    () => pubSnapshot,
  );
}

export function localPublication(shareId: string): Publication | undefined {
  return pubs.get(shareId);
}

export async function capture(kind: Kind): Promise<MediaStream> {
  const unavailable = mediaAvailable();
  if (unavailable) throw new Error(unavailable);
  if (kind === "screen") {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 30, max: 30 } },
      audio: false,
    });
    for (const t of stream.getVideoTracks()) t.contentHint = "detail";
    return stream;
  }
  return navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: "user" },
    audio: false,
  });
}

/**
 * Capture a screen or camera and start answering viewers for `shareId`.
 * The caller registers the share with the hub (POST /api/shares) afterwards.
 * Rejects if the user cancels the picker or denies permission.
 */
export async function publish(kind: Kind, shareId: string = `sh-${rid()}${rid()}`): Promise<Publication> {
  init();
  if (pubs.has(shareId)) return pubs.get(shareId)!;
  const stream = await capture(kind);
  const pub: PubInternal = { shareId, kind, stream, peers: new Map(), stopped: false };
  pubs.set(shareId, pub);
  // The browser's own "Stop sharing" button ends the track: end the share for everyone.
  for (const t of stream.getTracks()) t.addEventListener("ended", () => void stopPublishing(shareId), { once: true });
  publishChanged();
  return pub;
}

/** Stop publishing: tell viewers, close connections, release the capture, end the share on the hub. */
export async function stopPublishing(shareId: string, opts: { notifyHub?: boolean } = {}) {
  const pub = pubs.get(shareId);
  if (!pub || pub.stopped) return;
  pub.stopped = true;
  for (const [viewer, peer] of pub.peers) {
    send(viewer, { op: "bye", shareId });
    closePc(peer.pc);
  }
  pub.peers.clear();
  for (const t of pub.stream.getTracks()) t.stop();
  pubs.delete(shareId);
  publishChanged();
  if (opts.notifyHub !== false) await api(`/shares/${shareId}`, undefined, "DELETE").catch(() => {});
}

function closePc(pc: RTCPeerConnection) {
  pc.onicecandidate = null;
  pc.ontrack = null;
  pc.onconnectionstatechange = null;
  try {
    pc.close();
  } catch {}
}

async function onWant(viewer: string, shareId: string) {
  const pub = pubs.get(shareId);
  if (!pub || pub.stopped) return;
  // A repeat "want" (viewer reloaded or gave up) replaces any earlier connection.
  const old = pub.peers.get(viewer);
  if (old) closePc(old.pc);

  const pc = new RTCPeerConnection({ iceServers });
  const id = rid();
  const peer = { pc, id, queued: [] as RTCIceCandidateInit[], ready: false };
  pub.peers.set(viewer, peer);

  for (const track of pub.stream.getTracks()) {
    const sender = pc.addTrack(track, pub.stream);
    if (track.kind === "video") {
      try {
        const p = sender.getParameters();
        p.encodings = p.encodings?.length ? p.encodings : [{}];
        p.encodings[0].maxBitrate = pub.kind === "screen" ? 8_000_000 : 3_000_000;
        // Text stays sharp; motion gives up frames first.
        (p as any).degradationPreference = pub.kind === "screen" ? "maintain-resolution" : "balanced";
        await sender.setParameters(p);
      } catch {}
    }
  }
  pc.onicecandidate = (e) => send(viewer, { op: "ice", shareId, pc: id, candidate: e.candidate ? e.candidate.toJSON() : null });
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      if (pub.peers.get(viewer)?.pc === pc) pub.peers.delete(viewer);
      closePc(pc);
    }
  };
  try {
    await pc.setLocalDescription(await pc.createOffer());
    if (pub.peers.get(viewer)?.pc !== pc) return; // superseded while negotiating
    send(viewer, { op: "offer", shareId, pc: id, sdp: pc.localDescription!.sdp });
  } catch {
    if (pub.peers.get(viewer)?.pc === pc) pub.peers.delete(viewer);
    closePc(pc);
  }
}

async function onAnswer(viewer: string, d: Extract<Signal, { op: "answer" }>) {
  const peer = pubs.get(d.shareId)?.peers.get(viewer);
  if (!peer || peer.id !== d.pc) return;
  try {
    await peer.pc.setRemoteDescription({ type: "answer", sdp: d.sdp });
    peer.ready = true;
    for (const c of peer.queued.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
  } catch {}
}

// ---------------------------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------------------------

export interface WatchState {
  stream: MediaStream | null;
  status: "connecting" | "live";
  /** Times we have asked the publisher; grows while it stays silent. */
  attempts: number;
}

interface Session {
  shareId: string;
  publisher: string;
  refs: number;
  pc: RTCPeerConnection | null;
  pcId: string;
  queued: RTCIceCandidateInit[];
  remoteSet: boolean;
  lastOfferAt: number;
  disconnectedAt: number;
  timer: ReturnType<typeof setInterval> | null;
  listeners: Set<() => void>;
  snap: WatchState;
}

const sessions = new Map<string, Session>();
const WANT_EVERY_MS = 2500;
const OFFER_PATIENCE_MS = 12_000;

function setSnap(s: Session, patch: Partial<WatchState>) {
  s.snap = { ...s.snap, ...patch };
  for (const fn of s.listeners) fn();
}

function want(s: Session) {
  send(s.publisher, { op: "want", shareId: s.shareId });
  setSnap(s, { attempts: s.snap.attempts + 1 });
}

function resetPc(s: Session) {
  if (s.pc) closePc(s.pc);
  s.pc = null;
  s.pcId = "";
  s.queued = [];
  s.remoteSet = false;
  s.lastOfferAt = 0;
  s.disconnectedAt = 0;
  if (s.snap.status !== "connecting" || s.snap.stream) setSnap(s, { status: "connecting", stream: null });
}

function tick(s: Session) {
  const pc = s.pc;
  if (pc) {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") resetPc(s);
    else if (pc.connectionState === "disconnected") {
      s.disconnectedAt ||= Date.now();
      if (Date.now() - s.disconnectedAt > 4000) resetPc(s);
    } else s.disconnectedAt = 0;
  }
  const connected = s.pc?.connectionState === "connected";
  if (connected) return;
  // Don't interrupt a negotiation that is making progress.
  if (s.pc && Date.now() - s.lastOfferAt < OFFER_PATIENCE_MS) return;
  if (s.pc) resetPc(s);
  want(s);
}

async function onOffer(publisher: string, d: Extract<Signal, { op: "offer" }>) {
  const s = sessions.get(d.shareId);
  if (!s || s.publisher !== publisher) return;
  if (s.pc) closePc(s.pc);
  const pc = new RTCPeerConnection({ iceServers });
  s.pc = pc;
  s.pcId = d.pc;
  s.queued = [];
  s.remoteSet = false;
  s.lastOfferAt = Date.now();
  pc.onicecandidate = (e) => send(publisher, { op: "ice", shareId: s.shareId, pc: d.pc, candidate: e.candidate ? e.candidate.toJSON() : null });
  pc.ontrack = (e) => {
    const stream = e.streams[0] ?? new MediaStream([e.track]);
    setSnap(s, { stream, status: "live" });
  };
  pc.onconnectionstatechange = () => {
    if (s.pc !== pc) return;
    if (pc.connectionState === "connected") setSnap(s, { status: "live" });
    if (pc.connectionState === "failed") tick(s);
  };
  try {
    await pc.setRemoteDescription({ type: "offer", sdp: d.sdp });
    s.remoteSet = true;
    for (const c of s.queued.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    await pc.setLocalDescription(await pc.createAnswer());
    if (s.pc === pc) send(publisher, { op: "answer", shareId: s.shareId, pc: d.pc, sdp: pc.localDescription!.sdp });
  } catch {
    if (s.pc === pc) resetPc(s);
  }
}

function acquire(share: Pick<Share, "id" | "deviceId">): Session {
  let s = sessions.get(share.id);
  if (!s) {
    s = {
      shareId: share.id,
      publisher: share.deviceId,
      refs: 0,
      pc: null,
      pcId: "",
      queued: [],
      remoteSet: false,
      lastOfferAt: 0,
      disconnectedAt: 0,
      timer: null,
      listeners: new Set(),
      snap: { stream: null, status: "connecting", attempts: 0 },
    };
    sessions.set(share.id, s);
    const session = s;
    want(session);
    session.timer = setInterval(() => tick(session), WANT_EVERY_MS);
  }
  s.refs++;
  return s;
}

function release(s: Session) {
  if (--s.refs > 0) return;
  if (s.timer) clearInterval(s.timer);
  if (s.pc) send(s.publisher, { op: "bye", shareId: s.shareId });
  resetPc(s);
  sessions.delete(s.shareId);
}

/**
 * Watch a share. `cb` fires on every state change; returns an unsubscribe that also tears down
 * the connection when the last watcher leaves. Several watchers of one share share a connection.
 */
export function watch(share: Pick<Share, "id" | "deviceId">, cb: (state: WatchState) => void): { get: () => WatchState; stop: () => void } {
  init();
  const local = pubs.get(share.id);
  if (local) {
    const state: WatchState = { stream: local.stream, status: "live", attempts: 0 };
    cb(state);
    return { get: () => state, stop: () => {} };
  }
  const s = acquire(share);
  const fire = () => cb(s.snap);
  s.listeners.add(fire);
  let stopped = false;
  return {
    get: () => s.snap,
    stop: () => {
      if (stopped) return;
      stopped = true;
      s.listeners.delete(fire);
      release(s);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Signaling router
// ---------------------------------------------------------------------------------------------

let inited = false;
function init() {
  if (inited) return;
  inited = true;
  hub.onMessage((m) => {
    if (m?.type !== "rtc" || !m.data || m.from === hub.deviceId) return;
    const d = m.data as Signal;
    const from = String(m.from);
    switch (d.op) {
      case "want":
        void onWant(from, d.shareId);
        return;
      case "offer":
        void onOffer(from, d);
        return;
      case "answer":
        void onAnswer(from, d);
        return;
      case "ice": {
        // Publisher-side peer, or viewer-side session, whichever this candidate belongs to.
        const peer = pubs.get(d.shareId)?.peers.get(from);
        if (peer && peer.id === d.pc) {
          if (!d.candidate) return;
          if (peer.ready) void peer.pc.addIceCandidate(d.candidate).catch(() => {});
          else peer.queued.push(d.candidate);
          return;
        }
        const s = sessions.get(d.shareId);
        if (s && s.publisher === from && s.pcId === d.pc && d.candidate) {
          if (s.remoteSet && s.pc) void s.pc.addIceCandidate(d.candidate).catch(() => {});
          else s.queued.push(d.candidate);
        }
        return;
      }
      case "bye": {
        const s = sessions.get(d.shareId);
        if (s && s.publisher === from) resetPc(s);
        const pub = pubs.get(d.shareId);
        const peer = pub?.peers.get(from);
        if (pub && peer) (closePc(peer.pc), pub.peers.delete(from));
        return;
      }
    }
  });
}

/** React hook: the live stream (or null while connecting) for a share. */
export function useWatch(share: Pick<Share, "id" | "deviceId"> | null | undefined): WatchState {
  const [state, setState] = useState<WatchState>(IDLE);
  const id = share?.id;
  const deviceId = share?.deviceId;
  useEffect(() => {
    if (!id || !deviceId) return setState(IDLE);
    const w = watch({ id, deviceId }, setState);
    setState(w.get());
    return w.stop;
  }, [id, deviceId]);
  return state;
}

const IDLE: WatchState = { stream: null, status: "connecting", attempts: 0 };

// Page teardown: let viewers know instead of making them wait for ICE to time out.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const pub of pubs.values()) for (const viewer of pub.peers.keys()) send(viewer, { op: "bye", shareId: pub.shareId });
  });
}
