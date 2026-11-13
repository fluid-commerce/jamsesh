// Who is talking right now: the "<Name> is talking" indicator in the room's windows. A microphone that hears someone start
// tells the hub (the client's `speaking` message); the hub maps the laptop to its person and tells every window.
//
// Display only. Nothing here is stored, and agents, the brain and the wiki never see it: it is not an event, not a line, and
// the bus message that carries it is not sent to agent connections (http.ts).
//
// Every laptop in a room hears everyone, so the room shows one talker: the laptop that hears the voice loudest, like the
// line's speaker label. Remote laptops are other rooms and each shows its own. A muted laptop sends nothing; an unnamed
// laptop reads "Someone", as an unnamed line does.
import { bus } from "./bus";
import type { Session } from "./session";
import type { Talker, Utterance } from "./types";

/** Windows hear about changes at most this often (5 a second). */
const PUBLISH_MS = 200;
/** A talker stays this long after their speech stops, in case their line is about to appear. */
const LINGER_MS = 1000;
/** Most messages the hub takes from one laptop in a second (a client sends five); the rest are dropped. */
const MAX_PER_SECOND = 8;
/** A laptop that stops reporting (a closed lid, a lost connection) is not talking after this. */
const STALE_MS = 3000;
/** The room's talker changes to a louder laptop only when it is this much louder. */
const HYSTERESIS_DB = 3;

interface Entry {
  level: number;
  at: number;
  live: boolean;
  gone: ReturnType<typeof setTimeout> | null;
  /** In the list sent last: an entry that just stopped stays there while it lingers. */
  shown: boolean;
}

export class Speaking {
  private entries = new Map<string, Entry>();
  private lastPublish = 0;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private sweep: ReturnType<typeof setInterval> | null = null;
  private last = "";
  private rate = new Map<string, { since: number; n: number }>();

  constructor(private session: Session) {}

  /** A laptop's microphone heard speech start (`on`), carries on (`on` with a level), or ended. */
  update(deviceId: string, on: boolean, level: number) {
    // Enforced here, whatever a client sends: a device gets this many messages a second, the rest are dropped (never queued).
    // "Speech ended" is always processed (it only ever ends something); repeated starts and level updates are limited.
    if (on) {
      const now = Date.now();
      const w = this.rate.get(deviceId);
      if (!w || now - w.since >= 1000) this.rate.set(deviceId, { since: now, n: 1 });
      else if (++w.n > MAX_PER_SECOND) return;
    }
    const d = this.session.store.get("devices", deviceId);
    // A muted microphone, and a laptop the hub doesn't know, say nothing.
    if (!d || !d.micOn) return this.drop(deviceId);
    const cur = this.entries.get(deviceId);
    const db = Number.isFinite(level) ? Math.min(0, Math.max(-100, level)) : -60;
    if (!on) {
      if (!cur?.live) return;
      cur.live = false;
      cur.level = -100;
      this.clearTimer(cur);
      cur.gone = setTimeout(() => this.drop(deviceId), LINGER_MS);
      cur.gone.unref?.();
      return this.publish();
    }
    if (cur) this.clearTimer(cur);
    this.entries.set(deviceId, { level: db, at: Date.now(), live: true, gone: null, shown: cur?.shown ?? false });
    this.sweep ??= setInterval(() => this.expire(), 1000);
    this.sweep.unref?.();
    this.publish();
  }

  /** A laptop went away, or its mic was muted: it is not talking. */
  drop(deviceId: string) {
    const cur = this.entries.get(deviceId);
    if (!cur) return;
    this.clearTimer(cur);
    this.entries.delete(deviceId);
    this.publish();
  }

  /** A line from someone was shown: their indicator gives way to it. A line nobody could name clears the laptops that heard it. */
  lineShown(u: Utterance) {
    let any = false;
    for (const [id, e] of this.entries) {
      const owner = this.session.store.get("devices", id)?.personId ?? null;
      const mine = u.personId ? owner === u.personId : !owner && u.devices.some((x) => x.deviceId === id);
      if (!mine) continue;
      this.clearTimer(e);
      this.entries.delete(id);
      any = true;
    }
    if (any) this.publish();
  }

  stop() {
    for (const e of this.entries.values()) this.clearTimer(e);
    this.entries.clear();
    if (this.sweep) clearInterval(this.sweep);
    if (this.pending) clearTimeout(this.pending);
    this.sweep = this.pending = null;
  }

  private clearTimer(e: Entry) {
    if (e.gone) clearTimeout(e.gone);
    e.gone = null;
  }

  private expire() {
    const now = Date.now();
    let any = false;
    for (const [id, e] of this.entries) {
      if (e.live && now - e.at > STALE_MS) {
        this.clearTimer(e);
        this.entries.delete(id);
        any = true;
      }
    }
    if (any) this.publish();
    if (!this.entries.size && this.sweep) (clearInterval(this.sweep), (this.sweep = null));
  }

  /** The talkers to show now. */
  talkers(): Talker[] {
    const out: Talker[] = [];
    const room: { id: string; e: Entry }[] = [];
    for (const [id, e] of this.entries) {
      const d = this.session.store.get("devices", id);
      if (!d) continue;
      if ((d.location ?? "room") === "remote") out.push(this.talker(id, e));
      else room.push({ id, e });
    }
    // One talker for the room: the laptop that hears the loudest voice, who stays until another is clearly louder.
    const live = room.filter((x) => x.e.live);
    const loudest = [...live].sort((a, b) => b.e.level - a.e.level)[0];
    const kept = live.find((x) => x.e.shown && loudest && x.e.level >= loudest.e.level - HYSTERESIS_DB);
    const chosen = kept ?? loudest;
    for (const x of room) x.e.shown = x === chosen || (!x.e.live && x.e.shown && !chosen);
    for (const x of room) if (x.e.shown) out.push(this.talker(x.id, x.e));
    return out;
  }

  private talker(deviceId: string, e: Entry): Talker {
    const d = this.session.store.get("devices", deviceId);
    const p = this.session.person(d?.personId ?? null);
    return { deviceId, personId: p?.id ?? null, name: p?.name ?? "Someone", color: p?.color ?? "", level: Math.round(Math.min(1, Math.max(0, (e.level + 60) / 40)) * 10) / 10, live: e.live };
  }

  /** Tells the windows when the list changed, at most five times a second. */
  private publish() {
    if (this.pending) return;
    const wait = Math.max(0, this.lastPublish + PUBLISH_MS - Date.now());
    const send = () => {
      this.pending = null;
      this.lastPublish = Date.now();
      const talkers = this.talkers();
      const key = JSON.stringify(talkers);
      // Quiet rooms stay quiet: nothing is sent while nothing changes.
      if (key === this.last) return;
      this.last = key;
      bus.send({ type: "talking", talkers });
    };
    if (wait === 0) return send();
    this.pending = setTimeout(send, wait);
    this.pending.unref?.();
  }
}
