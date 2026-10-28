// Pairing and access. A device (a laptop's JamSesh window, a phone, an agent) pairs
// once with the 4-character code on the big screen, which changes every 30 seconds
// like an authenticator app. Pairing hands the device a long random token; only its
// hash is kept. Tokens are revocable from Settings. Guessing is rate-limited per
// address and across everyone, and the code is only good for a minute at most.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { bus } from "./bus";
import type { Store } from "./store";

export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O, 1/I/L
export const CODE_PERIOD_MS = 30_000;

export interface PairedDevice {
  id: string;
  kind: "browser" | "agent";
  label: string;
  tokenHash: string;
  personId: string | null;
  createdAt: number;
  lastSeen: number;
  ip: string;
  revoked: boolean;
  /** For a Mac's agents' credential: the person's window it was issued from. */
  ownerDeviceId?: string;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** The code for one 30-second window: HMAC of the window number, mapped onto the alphabet. */
export function codeFor(secret: string, window: number) {
  const mac = createHmac("sha256", secret).update(String(window)).digest();
  let n = mac.readUInt32BE(0);
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += CODE_ALPHABET[n % CODE_ALPHABET.length];
    n = Math.floor(n / CODE_ALPHABET.length);
  }
  return out;
}

/** "k7m2", "K7 M2" and "k-7-m-2" all read as K7M2. */
export function normalizeCode(input: string) {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

type Attempts = { n: number; until: number; last?: number };

export class Auth {
  private secret: string;
  private devices = new Map<string, PairedDevice>();
  private byHash = new Map<string, PairedDevice>();
  private perIp = new Map<string, Attempts>();
  private globalFails: number[] = [];
  private lastSeenWrite = 0;

  constructor(private store: Store) {
    this.secret = store.setting<string>("pairSecret", "") || randomBytes(32).toString("hex");
    store.setSetting("pairSecret", this.secret);
    for (const d of store.setting<PairedDevice[]>("pairedDevices", [])) this.index(d);
  }

  private index(d: PairedDevice) {
    this.devices.set(d.id, d);
    this.byHash.set(d.tokenHash, d);
  }

  private persist() {
    this.store.setSetting("pairedDevices", [...this.devices.values()]);
  }

  current(now = Date.now()) {
    const window = Math.floor(now / CODE_PERIOD_MS);
    return { code: codeFor(this.secret, window), expiresIn: CODE_PERIOD_MS - (now % CODE_PERIOD_MS), period: CODE_PERIOD_MS };
  }

  /** Invite links: an 8-character code, good once, for ten minutes (for people not in the room). */
  private invites = new Map<string, number>();

  invite(now = Date.now()) {
    for (const [c, until] of this.invites) if (until < now) this.invites.delete(c);
    let code = "";
    const bytes = randomBytes(8);
    for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    const expiresAt = now + 10 * 60_000;
    this.invites.set(code, expiresAt);
    return { code, expiresAt };
  }

  /** The current code, or the one before it (people read it off the screen), or an unused invite. */
  verifyCode(input: string, now = Date.now()) {
    const want = normalizeCode(input);
    const invite = this.invites.get(want);
    if (invite) {
      this.invites.delete(want);
      return invite > now;
    }
    if (want.length !== 4) return false;
    const w = Math.floor(now / CODE_PERIOD_MS);
    return [w, w - 1].some((x) => safeEqual(normalizeCode(codeFor(this.secret, x)), want));
  }

  /** Why pairing is refused right now for this address, or null. */
  blocked(ip: string, now = Date.now()): string | null {
    this.globalFails = this.globalFails.filter((t) => now - t < 5 * 60_000);
    if (this.globalFails.length >= 60) return "Too many wrong codes on this host. Pairing is paused for a few minutes.";
    const a = this.perIp.get(ip);
    if (a && a.until > now) return "Too many wrong codes from your address. Try again in a few minutes.";
    return null;
  }

  pair(opts: { code: string; kind: PairedDevice["kind"]; label: string; ip: string; personId?: string | null }): { ok: true; token: string; device: PairedDevice } | { ok: false; error: string } {
    const now = Date.now();
    const why = this.blocked(opts.ip, now);
    if (why) return { ok: false, error: why };
    if (!this.verifyCode(opts.code, now)) {
      // Eight wrong codes within a minute from one address (an office shares one) pauses it for two
      // minutes: plenty against guessing a code that changes every 30 seconds.
      const a = this.perIp.get(opts.ip) ?? { n: 0, until: 0, last: 0 };
      if (now - (a.last ?? 0) > 60_000) a.n = 0;
      a.n++;
      a.last = now;
      if (a.n >= 8) ((a.until = now + 2 * 60_000), (a.n = 0));
      this.perIp.set(opts.ip, a);
      this.globalFails.push(now);
      return { ok: false, error: "That code didn't match. Codes change every 30 seconds; use the one on the screen now." };
    }
    this.perIp.delete(opts.ip);
    const token = `jst_${randomBytes(32).toString("base64url")}`;
    const device: PairedDevice = {
      id: `dev_${randomBytes(6).toString("hex")}`,
      kind: opts.kind,
      label: opts.label.slice(0, 80) || (opts.kind === "agent" ? "Agent" : "Browser"),
      tokenHash: hash(token),
      personId: opts.personId ?? null,
      createdAt: now,
      lastSeen: now,
      ip: opts.ip,
      revoked: false,
    };
    this.index(device);
    this.persist();
    bus.send({ type: "toast", tone: "info", text: opts.kind === "agent" ? "An agent connected" : "A laptop connected", detail: device.label });
    return { ok: true, token, device };
  }

  /** A token without a code, for a device that's already trusted (the Mac app's agents credential). */
  issue(opts: { kind: PairedDevice["kind"]; label: string; ip: string; personId?: string | null; ownerDeviceId?: string }): { token: string; device: PairedDevice } {
    const now = Date.now();
    const token = `jst_${randomBytes(32).toString("base64url")}`;
    const device: PairedDevice = { id: `dev_${randomBytes(6).toString("hex")}`, kind: opts.kind, label: opts.label.slice(0, 80), tokenHash: hash(token), personId: opts.personId ?? null, createdAt: now, lastSeen: now, ip: opts.ip, revoked: false, ownerDeviceId: opts.ownerDeviceId };
    this.index(device);
    this.persist();
    return { token, device };
  }

  /** The device a token belongs to, or null (unknown or revoked). */
  check(token: string | null | undefined, ip?: string): PairedDevice | null {
    if (!token) return null;
    const d = this.byHash.get(hash(token));
    if (!d || d.revoked) return null;
    const now = Date.now();
    d.lastSeen = now;
    if (ip) d.ip = ip;
    if (now - this.lastSeenWrite > 60_000) ((this.lastSeenWrite = now), this.persist());
    return d;
  }

  update(id: string, fields: Partial<Pick<PairedDevice, "label" | "personId">>) {
    const d = this.devices.get(id);
    if (!d) return null;
    Object.assign(d, fields);
    // The person's agents on that Mac work for the same person.
    if (fields.personId !== undefined) for (const a of this.devices.values()) if (a.ownerDeviceId === id) a.personId = fields.personId;
    this.persist();
    return d;
  }

  /** Whose agents these are, for the credentials issued from one window ("host" for the host's own). */
  setOwnerPerson(ownerDeviceId: string, personId: string) {
    let changed = false;
    for (const a of this.devices.values()) if (a.ownerDeviceId === ownerDeviceId && a.personId !== personId) (a.personId = personId), (changed = true);
    if (changed) this.persist();
  }

  revoke(id: string) {
    const d = this.devices.get(id);
    if (!d) return false;
    d.revoked = true;
    // Disconnecting a Mac's window disconnects its agents too.
    for (const a of this.devices.values()) if (a.ownerDeviceId === id && !a.revoked) (a.revoked = true), bus.send({ type: "revoked", deviceId: a.id } as any);
    this.persist();
    bus.send({ type: "revoked", deviceId: id } as any);
    return true;
  }

  /**
   * The machine a credential stands for: its owner window ("host" or the Mac's browser device), so
   * agents keep their identity when the app re-issues their credential on a relaunch.
   */
  machineOf(id: string | null | undefined): string | null {
    if (!id) return null;
    return this.devices.get(id)?.ownerDeviceId ?? id;
  }

  /** Revokes the agents credentials an owner window issued earlier (the app issues a new one on each launch). */
  revokeAgentsOf(ownerDeviceId: string) {
    for (const a of this.devices.values()) if (a.ownerDeviceId === ownerDeviceId && a.kind === "agent" && !a.revoked) this.revoke(a.id);
  }

  list() {
    return [...this.devices.values()].filter((d) => !d.revoked).map(({ tokenHash: _h, ...d }) => d);
  }
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
