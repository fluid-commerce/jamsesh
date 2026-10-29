// Driving the big screen from your own app (SPEC 10.6). This file is the client API: who is driving, starting and
// handing over control, the stream of every cursor, and a registry so a tile on the big screen can say how it takes input.
// 6.2's recorder draws its trail from onGlide; 6.3's device tiles register themselves with registerDriveTarget.
import { useEffect } from "react";
import { api, hub, pref, useHub, type DriveEvent, type HubState, type Person, type Stage } from "./hub";

export type { DriveEvent };

/** A cursor event as everyone's window gets it. Positions are fractions 0..1 of the screen's stage area. */
export interface DriveCursor {
  screen: string;
  personId: string;
  name: string;
  color: string;
  ev: DriveEvent;
  /** Host clock, ms. */
  t: number;
}

/** One cursor as drawn this frame (after gliding), for anything that wants to follow the dart. */
export interface Glide {
  screen: string;
  personId: string;
  name: string;
  color: string;
  /** Fractions of the stage area. */
  x: number;
  y: number;
  down: boolean;
}

export interface DriverState {
  screen: string;
  /** The person who holds the screen's lock. */
  owner: Person | null;
  /** Everyone driving now (the owner, and whoever they handed control to). */
  drivers: Person[];
  me: { id: string | null; isOwner: boolean; driving: boolean };
}

export const stageOf = (state: HubState | null, screen: string): Stage | undefined => (screen === "main" ? state?.stage : state?.screens?.find((s) => s.id === screen)?.stage);

/** Who is driving a screen, from a copy of the state (the hub's live one by default). */
export function driverState(screen = "main", state: HubState | null = hub.get().state, meId: string = pref("personId")): DriverState {
  const lock = stageOf(state, screen)?.lock;
  const people = state?.people ?? [];
  const drivers = (lock?.drivers ?? []).map((id) => people.find((p) => p.id === id)).filter(Boolean) as Person[];
  return {
    screen,
    owner: (lock?.personId && people.find((p) => p.id === lock.personId)) || null,
    drivers,
    me: { id: meId || null, isOwner: !!lock?.personId && lock.personId === meId, driving: !!meId && drivers.some((p) => p.id === meId) },
  };
}

/** Whether anyone is driving any screen right now. */
export function anyoneDriving(state: HubState | null = hub.get().state): boolean {
  return !!state?.stage.lock?.drivers?.length || !!state?.screens?.some((s) => s.stage.lock?.drivers?.length);
}

export function useDriverState(screen = "main"): DriverState {
  const { state } = useHub();
  return driverState(screen, state);
}

export interface DriveHandle {
  screen: string;
  /** Sends one event; false when this window isn't driving any more (the lock moved, or control was taken back). */
  send(ev: DriveEvent): boolean;
  /** Whether this window is still driving. */
  alive(): boolean;
  stop(): Promise<void>;
}

/** Start driving a screen you hold (or were handed). Throws with the hub's reason when you can't. */
export async function startDriving(screen = "main"): Promise<DriveHandle> {
  if (!driverState(screen).me.driving) await api("/drive/start", { screen });
  const alive = () => driverState(screen).me.driving;
  return {
    screen,
    alive,
    send: (ev) => alive() && (hub.send({ type: "drive", screen, ev }), true),
    stop: () => stopDriving(screen),
  };
}

export const stopDriving = async (screen = "main", who?: string) => void (await api("/drive/stop", { screen, ...(who ? { who } : {}) }));
/** Hand driving to a named person; you stop driving until you start again. Only the screen's owner can. */
export const passControl = async (to: string, screen = "main") => void (await api("/drive/pass", { screen, to }));
/** Let a second person drive alongside you, each with a cursor. */
export const driveTogether = async (to: string, screen = "main") => void (await api("/drive/together", { screen, to }));

// ---------- the cursor stream ----------

/** Every driver's raw events, from every screen. */
export function onCursor(fn: (c: DriveCursor) => void): () => void {
  return hub.onMessage((m) => m?.type === "drive" && m.ev && fn(m as DriveCursor));
}

/** The hub turned down this window's input (not driving), with why. */
export function onDriveDenied(fn: (m: { screen: string; why: string }) => void): () => void {
  return hub.onMessage((m) => m?.type === "drive-denied" && fn(m));
}

const glideSubs = new Set<(g: Glide[]) => void>();
/** Each frame the big screen draws cursors, the smoothed position of every one it shows (6.2 draws its trail from this). */
export const onGlide = (fn: (g: Glide[]) => void): (() => void) => (glideSubs.add(fn), () => void glideSubs.delete(fn));
export const emitGlide = (g: Glide[]) => glideSubs.forEach((f) => f(g));

// ---------- tiles that take input ----------

/** An input event for a tile: positions are fractions 0..1 of the tile's own box. */
export type TileEvent =
  | { k: "move" | "down" | "up"; lx: number; ly: number; b?: number; n?: number }
  | { k: "wheel"; lx: number; ly: number; dx: number; dy: number; ctrl?: boolean }
  | { k: "key"; key: string; code?: string; down: boolean; mods?: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean } }
  | { k: "leave" };

export interface DriveTarget {
  el: HTMLElement;
  handle(ev: TileEvent, personId: string): void;
}

const targets = new Set<DriveTarget>();

/** A tile on the big screen takes a driver's input by registering its element. Returns how to stop. */
export function registerDriveTarget(el: HTMLElement, handle: DriveTarget["handle"]): () => void {
  const t = { el, handle };
  targets.add(t);
  return () => void targets.delete(t);
}

/** The registered tile under a point (client pixels) inside `within`: the smallest one that holds it. */
export function targetAt(within: Element, x: number, y: number): DriveTarget | null {
  let best: DriveTarget | null = null;
  let area = Infinity;
  for (const t of targets) {
    if (!t.el.isConnected || !within.contains(t.el)) continue;
    const r = t.el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    if (r.width * r.height <= area) ((best = t), (area = r.width * r.height));
  }
  return best;
}

/** Register an element for the lifetime of a component. */
export function useDriveTarget(el: HTMLElement | null | undefined, handle: DriveTarget["handle"] | null) {
  useEffect(() => {
    if (el && handle) return registerDriveTarget(el, handle);
  }, [el, handle]);
}
