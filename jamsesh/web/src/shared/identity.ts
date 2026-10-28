// What this browser remembers about itself, per JamSesh host.
//
// One record per hub origin (so a laptop that visits two hubs keeps them apart). Every
// localStorage touch is wrapped: private windows and blocked storage fall back to memory.

export interface RememberedSession {
  id: string;
  name: string;
  joinedAt: number;
  lastSeen: number;
}

export interface Identity {
  hubOrigin: string;
  personId: string;
  name: string;
  location: string;
  /** Device id for the role this page plays most recently; see `devices` for each role. */
  deviceId: string;
  devices: Record<string, string>;
  lastSeen: number;
  sessions: RememberedSession[];
  /** Everything else the app stores through pref()/setPref(). */
  prefs: Record<string, string>;
}

const MAX_SESSIONS = 20;
const memory = new Map<string, Identity>();

// The host this window talks to. In the Mac app every host is reached at the same local address
// (its relay), so the host's own id keeps identities apart; set before anything reads them.
let hostKey = "";
export function setHostKey(id: string) {
  if (!id || hostKey) return;
  hostKey = id;
  // First time with ids: the identity saved under the plain address belongs to this host.
  const plain = lsGet(storageKey(location.origin));
  if (plain && !lsGet(storageKey(`${location.origin}#${id}`))) {
    try {
      localStorage.setItem(storageKey(`${location.origin}#${id}`), plain);
    } catch {}
  }
}
export const currentHostKey = () => hostKey;
const origin = () => (typeof location === "undefined" ? "" : hostKey ? `${location.origin}#${hostKey}` : location.origin);
const storageKey = (o: string) => `jamsesh.identity::${o}`;

function blank(hubOrigin: string): Identity {
  return { hubOrigin, personId: "", name: "", location: "", deviceId: "", devices: {}, lastSeen: 0, sessions: [], prefs: {} };
}

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function getIdentity(): Identity {
  const o = origin();
  const raw = lsGet(storageKey(o));
  if (raw) {
    try {
      return { ...blank(o), ...JSON.parse(raw), hubOrigin: o };
    } catch {}
  }
  return memory.get(o) ?? blank(o);
}

function write(next: Identity) {
  memory.set(next.hubOrigin, next);
  try {
    localStorage.setItem(storageKey(next.hubOrigin), JSON.stringify(next));
  } catch {}
}

export function rememberIdentity(patch: Partial<Omit<Identity, "hubOrigin" | "sessions" | "prefs" | "devices">> & { prefs?: Record<string, string>; devices?: Record<string, string> }): Identity {
  const cur = getIdentity();
  const next: Identity = {
    ...cur,
    ...patch,
    hubOrigin: cur.hubOrigin,
    prefs: { ...cur.prefs, ...patch.prefs },
    devices: { ...cur.devices, ...patch.devices },
    lastSeen: patch.lastSeen ?? Date.now(),
  };
  write(next);
  return next;
}

/** Note that this browser joined (or came back to) a session. Most recent first. */
export function rememberSession(id: string, name: string): Identity {
  const cur = getIdentity();
  const now = Date.now();
  const prior = cur.sessions.find((s) => s.id === id);
  const sessions = [{ id, name: name || prior?.name || id, joinedAt: prior?.joinedAt ?? now, lastSeen: now }, ...cur.sessions.filter((s) => s.id !== id)].slice(0, MAX_SESSIONS);
  const next = { ...cur, sessions, lastSeen: now };
  write(next);
  return next;
}

// ---- backing for the older pref()/setPref()/deviceId() helpers in hub.ts ----

const FIELD_PREFS = ["personId", "name", "location"] as const;
type FieldPref = (typeof FIELD_PREFS)[number];
const isField = (k: string): k is FieldPref => (FIELD_PREFS as readonly string[]).includes(k);

export function readPref(key: string, fallback = ""): string {
  const id = getIdentity();
  if (isField(key)) {
    if (id[key]) return id[key];
  } else if (key in id.prefs) return id.prefs[key];
  // Values written before per-host records existed.
  const legacy = lsGet(`jamsesh.${key}`);
  return legacy ?? fallback;
}

export function writePref(key: string, value: string) {
  try {
    localStorage.removeItem(`jamsesh.${key}`); // the per-host record is now the source of truth
  } catch {}
  if (isField(key)) rememberIdentity({ [key]: value });
  else rememberIdentity({ prefs: { [key]: value } });
}

export function readDeviceId(kind: string): string {
  const id = getIdentity();
  let dev = id.devices[kind] || lsGet(`jamsesh.device.${kind}`) || "";
  if (!dev) dev = `${kind}-${Math.random().toString(36).slice(2, 10)}`;
  if (id.devices[kind] !== dev || id.deviceId !== dev) rememberIdentity({ deviceId: dev, devices: { [kind]: dev }, lastSeen: id.lastSeen });
  return dev;
}
