// Session storage: SQLite on disk, with small collections cached in memory.
// Events (the context log) get full-text search through FTS5.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { bus } from "./bus";
import type {
  Agent,
  Annotation,
  Artifact,
  Fact,
  Device,
  DevServer,
  Directive,
  Document,
  EventKind,
  JamEvent,
  Person,
  Relevance,
  Share,
  Utterance,
  Workstream,
} from "./types";

type Collections = {
  people: Person;
  devices: Device;
  agents: Agent;
  workstreams: Workstream;
  directives: Directive;
  artifacts: Artifact;
  devservers: DevServer;
  utterances: Utterance;
  shares: Share;
  annotations: Annotation;
  facts: Fact;
  documents: Document;
};
export type CollectionName = keyof Collections;

export const PALETTE = ["#FF6B4A", "#3E8BFF", "#22C08B", "#B36BFF", "#FFB020", "#FF4FA3", "#18C6D6", "#8FD14F"];

/** Collections and settings that belong to the team and outlive any one session. */
const TEAM_COLLECTIONS = new Set<string>(["people", "devices"]);
const TEAM_SETTINGS = new Set<string>([
  "hostId",
  "voiceResetAt",
  "voiceResets",
  "personKeepers",
  "gatewayKey",
  "brainName",
  "brainAliases",
  "vocabulary",
  "fastEngine",
  "brainNotes",
  "brainEnabled",
  "voiceReplies",
  "voice",
  "models",
  "transcription",
  "hostControl",
  "pairSecret",
  "pairedDevices",
  "sessions",
]);

export function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

/** As long as a laptop keeps a queued change (web/src/shared/offline.ts): a replay is always recognized. */
const REPLAY_MS = 7 * 86_400_000;

/** Where a voice sample came from: heard in passing, read aloud, or a correction. */
export type VoiceKind = "auto" | "enrol" | "correction";
const CANCEL_KEEP_MS = 60 * 60_000;

export class Store {
  db: Database;
  private cache = new Map<CollectionName, Map<string, any>>();

  /** The team store (people, devices, voiceprints, team settings); null when this is the team store. */
  team: Store | null = null;

  constructor(dir: string, file = "jamsesh.db") {
    this.db = new Database(join(dir, file), { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        collection TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, updated INTEGER NOT NULL,
        PRIMARY KEY (collection, id)
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL, kind TEXT NOT NULL, author_type TEXT NOT NULL,
        author_id TEXT, author_name TEXT NOT NULL, text TEXT NOT NULL,
        relevance TEXT, workstream_id TEXT, data TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text, author_name, content='events', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, text, author_name) VALUES (new.id, new.text, new.author_name);
      END;
      CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, text, author_name) VALUES ('delete', old.id, old.text, old.author_name);
        INSERT INTO events_fts(rowid, text, author_name) VALUES (new.id, new.text, new.author_name);
      END;
      CREATE TABLE IF NOT EXISTS voiceprints (
        person_id TEXT NOT NULL, ts INTEGER NOT NULL, embedding BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS digests (scope TEXT PRIMARY KEY, text TEXT NOT NULL, updated INTEGER NOT NULL, through_event INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cancels (device TEXT NOT NULL, token TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (device, token));
      CREATE TABLE IF NOT EXISTS replies (key TEXT PRIMARY KEY, status INTEGER NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL);
    `);
    // Older stores kept voice samples with no kind: they were all learned automatically.
    if (!(this.db.query("PRAGMA table_info(voiceprints)").all() as any[]).some((c) => c.name === "kind")) this.db.exec("ALTER TABLE voiceprints ADD COLUMN kind TEXT NOT NULL DEFAULT 'auto'");
    // Earlier builds took copies of a voice from other hosts. A voice now lives only on the host that learned it.
    this.db.exec("DELETE FROM voiceprints WHERE kind = 'carried'");
  }

  // ---- generic collections ----

  private map<K extends CollectionName>(c: K): Map<string, Collections[K]> {
    let m = this.cache.get(c);
    if (!m) {
      m = new Map();
      for (const row of this.db.query("SELECT id, json FROM docs WHERE collection = ?").all(c) as any[]) {
        m.set(row.id, JSON.parse(row.json));
      }
      this.cache.set(c, m);
    }
    return m as Map<string, Collections[K]>;
  }

  all<K extends CollectionName>(c: K): Collections[K][] {
    if (this.team && TEAM_COLLECTIONS.has(c)) return this.team.all(c);
    return [...this.map(c).values()];
  }

  get<K extends CollectionName>(c: K, id: string): Collections[K] | undefined {
    if (this.team && TEAM_COLLECTIONS.has(c)) return this.team.get(c, id);
    return this.map(c).get(id);
  }

  put<K extends CollectionName>(c: K, doc: Collections[K] & { id: string }, broadcast = true): Collections[K] {
    if (this.team && TEAM_COLLECTIONS.has(c)) return this.team.put(c, doc, broadcast);
    this.map(c).set(doc.id, doc);
    this.db
      .query("INSERT OR REPLACE INTO docs (collection, id, json, updated) VALUES (?, ?, ?, ?)")
      .run(c, doc.id, JSON.stringify(doc), Date.now());
    if (broadcast) bus.changed(c);
    return doc;
  }

  patch<K extends CollectionName>(c: K, id: string, fields: Partial<Collections[K]>): Collections[K] | undefined {
    const cur = this.get(c, id);
    if (!cur) return undefined;
    return this.put(c, { ...cur, ...fields } as any);
  }

  remove(c: CollectionName, id: string): void {
    if (this.team && TEAM_COLLECTIONS.has(c)) return this.team.remove(c, id);
    this.map(c).delete(id);
    this.db.query("DELETE FROM docs WHERE collection = ? AND id = ?").run(c, id);
    bus.changed(c);
  }

  // ---- settings ----

  private txDepth = 0;
  /** Everything `fn` writes lands together or not at all (a crash or a throw in between leaves the earlier state). Nests. */
  atomic<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth++;
      try {
        return fn();
      } finally {
        this.txDepth--;
      }
    }
    // The depth counts only a transaction that really began: a BEGIN that throws leaves it at 0.
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth = 1;
    // Announcements wait for the commit: clients never hear of a write that rolled back.
    const held: (() => void)[] = (this.held = []);
    let out: T;
    try {
      out = fn();
      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      this.held = null;
      this.cache.clear();
      throw e;
    } finally {
      this.txDepth = 0;
    }
    this.held = null;
    for (const f of held) f();
    return out;
  }

  // ---- replayed calls: the first answer to each idempotency key, kept across restarts for as long
  // as a laptop keeps a change queued (seven days) ----

  reply(key: string): { status: number; type: string; body: string } | null {
    return (this.db.query("SELECT status, type, body FROM replies WHERE key = ? AND at > ?").get(key, Date.now() - REPLAY_MS) as { status: number; type: string; body: string } | null) ?? null;
  }

  saveReply(key: string, r: { status: number; type: string; body: string }): void {
    this.db.query("INSERT OR REPLACE INTO replies (key, status, type, body, at) VALUES (?, ?, ?, ?, ?)").run(key, r.status, r.type, r.body.slice(0, 200_000), Date.now());
    if (Math.random() < 0.02) this.db.query("DELETE FROM replies WHERE at < ?").run(Date.now() - REPLAY_MS);
  }

  setting<T>(key: string, fallback: T): T {
    if (this.team && TEAM_SETTINGS.has(key)) return this.team.setting(key, fallback);
    const row = this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as any;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    if (this.team && TEAM_SETTINGS.has(key)) return this.team.setSetting(key, value);
    this.db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
  }

  // ---- events ----

  private held: (() => void)[] | null = null;
  private announce(f: () => void) {
    if (this.held) this.held.push(f);
    else f();
  }

  /** A recording token a window cancelled (kept an hour, longer than any Start can be in flight). Only that window's own cancels push out its oldest. */
  cancelToken(device: string, token: string, now = Date.now()) {
    this.db.query("DELETE FROM cancels WHERE at < ?").run(now - CANCEL_KEEP_MS);
    this.db.query("INSERT OR REPLACE INTO cancels (device, token, at) VALUES (?, ?, ?)").run(device, token, now);
    this.db.query("DELETE FROM cancels WHERE device = ? AND token NOT IN (SELECT token FROM cancels WHERE device = ? ORDER BY at DESC LIMIT 200)").run(device, device);
  }
  tokenCancelled(device: string, token: string, now = Date.now()): boolean {
    return !!this.db.query("SELECT 1 FROM cancels WHERE device = ? AND token = ? AND at >= ?").get(device, token, now - CANCEL_KEEP_MS);
  }

  addEvent(e: {
    kind: EventKind;
    authorType: JamEvent["authorType"];
    authorId?: string | null;
    authorName: string;
    text: string;
    relevance?: Relevance | null;
    workstreamId?: string | null;
    data?: Record<string, any>;
    ts?: number;
  }): JamEvent {
    const ts = e.ts ?? Date.now();
    const row = this.db
      .query(
        `INSERT INTO events (ts, kind, author_type, author_id, author_name, text, relevance, workstream_id, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        ts,
        e.kind,
        e.authorType,
        e.authorId ?? null,
        e.authorName,
        e.text,
        e.relevance ?? null,
        e.workstreamId ?? null,
        JSON.stringify(e.data ?? {}),
      ) as any;
    const event: JamEvent = {
      id: row.id,
      ts,
      kind: e.kind,
      authorType: e.authorType,
      authorId: e.authorId ?? null,
      authorName: e.authorName,
      text: e.text,
      relevance: e.relevance ?? null,
      workstreamId: e.workstreamId ?? null,
      data: e.data ?? {},
    };
    this.announce(() => bus.send({ type: "event", event }));
    return event;
  }

  updateEvent(id: number, fields: Partial<Pick<JamEvent, "text" | "relevance" | "workstreamId" | "authorId" | "authorName" | "data">>) {
    const cur = this.event(id);
    if (!cur) return;
    const next = { ...cur, ...fields, data: { ...cur.data, ...(fields.data ?? {}) } };
    this.db
      .query("UPDATE events SET text = ?, relevance = ?, workstream_id = ?, author_id = ?, author_name = ?, data = ? WHERE id = ?")
      .run(next.text, next.relevance, next.workstreamId, next.authorId, next.authorName, JSON.stringify(next.data), id);
    bus.send({ type: "event", event: next });
    return next;
  }

  /** Drops the voice embedding kept with a person's speech lines (their voice was reset). Returns how many. */
  scrubEmbeddings(personId: string): number {
    const where = "author_id = ? AND json_extract(data, '$.embedding') IS NOT NULL";
    // Counted first: the search index's triggers count toward the update's changes.
    const n = (this.db.query(`SELECT COUNT(*) AS n FROM events WHERE ${where}`).get(personId) as { n: number }).n;
    this.db.query(`UPDATE events SET data = json_remove(data, '$.embedding') WHERE ${where}`).run(personId);
    return n;
  }

  /** Deletes everything one agent put in the room, or that was addressed to it. Returns the ids. */
  deleteAgentEvents(agentId: string): number[] {
    // Only what the agent itself authored: messages others sent it and prompts its person wrote stay.
    const where = "author_id = ?1";
    const rows = this.db.query(`SELECT id, text, author_name FROM events WHERE ${where}`).all(agentId) as { id: number; text: string; author_name: string }[];
    for (const r of rows) this.db.query("INSERT INTO events_fts(events_fts, rowid, text, author_name) VALUES ('delete', ?, ?, ?)").run(r.id, r.text, r.author_name);
    this.db.query(`DELETE FROM events WHERE ${where}`).run(agentId);
    return rows.map((r) => r.id);
  }

  event(id: number): JamEvent | undefined {
    const row = this.db.query("SELECT * FROM events WHERE id = ?").get(id);
    return row ? rowToEvent(row) : undefined;
  }

  /** Events in id order: the newest `limit` of them, or with `oldestFirst` the oldest (for reading forward from `afterId`). */
  recentEvents(opts: { limit?: number; since?: number; kinds?: EventKind[]; afterId?: number; beforeId?: number; oldestFirst?: boolean } = {}): JamEvent[] {
    const where: string[] = [];
    const args: any[] = [];
    if (opts.since) (where.push("ts >= ?"), args.push(opts.since));
    if (opts.afterId != null) (where.push("id > ?"), args.push(opts.afterId));
    if (opts.beforeId != null) (where.push("id < ?"), args.push(opts.beforeId));
    if (opts.kinds?.length) (where.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`), args.push(...opts.kinds));
    const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id ${opts.oldestFirst ? "ASC" : "DESC"} LIMIT ?`;
    args.push(opts.limit ?? 100);
    const rows = (this.db.query(sql).all(...args) as any[]).map(rowToEvent);
    return opts.oldestFirst ? rows : rows.reverse();
  }

  /** Every message tied to a directive (sent or answered with its id), oldest first, with no window. */
  messagesAbout(directiveId: string): JamEvent[] {
    const rows = this.db.query("SELECT * FROM events WHERE kind = 'message' AND json_extract(data, '$.directiveId') = ? ORDER BY id ASC").all(directiveId) as any[];
    return rows.map(rowToEvent);
  }

  /** Messages for one agent after an id (direct, or to everyone from someone else), oldest first: the filter is in the query, so unrelated traffic can't push them out. */
  messagesTo(agentId: string, afterId: number, limit: number): JamEvent[] {
    const rows = this.db
      .query("SELECT * FROM events WHERE kind = 'message' AND id > ? AND json_extract(data, '$.inline') IS NULL AND (json_extract(data, '$.to') = ? OR (json_extract(data, '$.to') = 'all' AND (author_id IS NULL OR author_id != ?))) ORDER BY id ASC LIMIT ?")
      .all(afterId, agentId, agentId, limit) as any[];
    return rows.map(rowToEvent);
  }

  /** Answers already recorded for an ask. */
  messagesAnswering(askId: string): JamEvent[] {
    const rows = this.db.query("SELECT * FROM events WHERE kind = 'message' AND json_extract(data, '$.answerTo') = ?").all(askId) as any[];
    return rows.map(rowToEvent);
  }

  /** The message with this ask id, wherever it is in the history. */
  messageByAsk(askId: string): JamEvent | undefined {
    const row = this.db.query("SELECT * FROM events WHERE kind = 'message' AND json_extract(data, '$.askId') = ? ORDER BY id ASC LIMIT 1").get(askId);
    return row ? rowToEvent(row) : undefined;
  }

  /** Whether this agent's person prompted it since a time (prompt events carry the agent in data.agentId). */
  promptedSince(agentId: string, since: number): boolean {
    return !!this.db.query("SELECT 1 FROM events WHERE kind = 'prompt' AND ts >= ? AND json_extract(data, '$.agentId') = ? LIMIT 1").get(since, agentId);
  }

  /** The oldest events after an id (of some kinds), oldest first: for reading forward from a cursor. */
  eventsAfter(afterId: number, kinds: EventKind[], limit = 200): JamEvent[] {
    const sql = `SELECT * FROM events WHERE id > ?${kinds.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : ""} ORDER BY id ASC LIMIT ?`;
    return (this.db.query(sql).all(afterId, ...kinds, limit) as any[]).map(rowToEvent);
  }

  /** The people who spoke or typed in this session, most recent first. */
  speakers(limit = 24): string[] {
    const rows = this.db
      .query("SELECT author_name AS n FROM events WHERE author_type = 'person' AND author_name NOT IN ('', 'Someone') GROUP BY author_name ORDER BY MAX(id) DESC LIMIT ?")
      .all(limit) as { n: string }[];
    return rows.map((r) => r.n);
  }

  /** How many events there are (before an id, of some kinds), for "N more" counts. */
  countEvents(opts: { beforeId?: number; kinds?: EventKind[] } = {}): number {
    const where: string[] = [];
    const args: any[] = [];
    if (opts.beforeId != null) (where.push("id < ?"), args.push(opts.beforeId));
    if (opts.kinds?.length) (where.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`), args.push(...opts.kinds));
    return (this.db.query(`SELECT COUNT(*) AS n FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""}`).get(...args) as any).n;
  }

  searchEvents(query: string, limit = 20, offset = 0): JamEvent[] {
    const terms = query
      .replace(/["'*^():]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1)
      .map((t) => `"${t}"*`);
    if (!terms.length) return [];
    try {
      return (
        this.db
          .query(
            `SELECT events.* FROM events_fts JOIN events ON events.id = events_fts.rowid
             WHERE events_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?`,
          )
          .all(terms.join(" OR "), limit, offset) as any[]
      ).map(rowToEvent);
    } catch {
      return [];
    }
  }

  lastEventId(): number {
    const row = this.db.query("SELECT MAX(id) AS id FROM events").get() as any;
    return row?.id ?? 0;
  }

  // ---- digests ----

  digest(scope: string): { text: string; updated: number; throughEvent: number } | null {
    const row = this.db.query("SELECT text, updated, through_event FROM digests WHERE scope = ?").get(scope) as any;
    return row ? { text: row.text, updated: row.updated, throughEvent: row.through_event } : null;
  }

  setDigest(scope: string, text: string, throughEvent: number) {
    this.db
      .query("INSERT OR REPLACE INTO digests (scope, text, updated, through_event) VALUES (?, ?, ?, ?)")
      .run(scope, text, Date.now(), throughEvent);
    bus.changed("digest");
  }

  // ---- voiceprints ----

  /** When a person's voice was last reset here (this host's clock), or 0. */
  voiceResetAt(personId: string): number {
    return this.setting<Record<string, number>>("voiceResetAt", {})[personId] ?? 0;
  }

  /** A reset, at a moment later than any before it even if the clock stepped back. */
  markVoiceReset(personId: string): number {
    const all = this.setting<Record<string, number>>("voiceResetAt", {});
    const resets = this.setting<number[]>("voiceResets", []);
    const at = Math.max(Date.now(), (all[personId] ?? 0) + 1, (resets.at(-1) ?? 0) + 1);
    this.setSetting("voiceResetAt", { ...all, [personId]: at });
    this.setSetting("voiceResets", [...resets, at]);
    return at;
  }

  /**
   * The reset epoch: how many resets this host has made, anyone's. The hub hands it out (with each clock pong,
   * and when a read starts); a device stamps it on audio as it captures it, and a read sends back the one it began with.
   */
  voiceEpoch(): number {
    return this.setting<number[]>("voiceResets", []).length;
  }

  /**
   * The latest moment audio captured in `epoch` can count as heard: the first reset after that epoch began, so
   * nothing captured before a reset teaches that voice, however late it arrives or whatever its timestamp says.
   * The current epoch has no limit; anything that isn't an epoch this host issued counts as the oldest.
   */
  heardBy(epoch: number): number {
    const resets = this.setting<number[]>("voiceResets", []);
    if (epoch === resets.length) return Infinity;
    return Number.isInteger(epoch) && epoch >= 0 && epoch < resets.length ? resets[epoch] : (resets[0] ?? Infinity);
  }

  /**
   * Every voice sample comes in here, with when its source was heard (this host's clock). Nothing heard
   * at or before the person's last reset teaches their voice again, whichever path it took (a line still
   * being transcribed, a later correction of an old line, a held first sample). Returns
   * whether it was kept.
   */
  addVoiceSample(personId: string, embedding: Float32Array, kind: VoiceKind, heardAt: number): boolean {
    if (!(Number.isFinite(heardAt) && heardAt > this.voiceResetAt(personId))) return false;
    if (this.team) return this.team.addVoiceSample(personId, embedding, kind, heardAt);
    this.db.query("INSERT INTO voiceprints (person_id, ts, embedding, kind) VALUES (?, ?, ?, ?)").run(personId, Date.now(), new Uint8Array(embedding.buffer.slice(0)), kind);
    // Automatic samples are the only ones that age out: the 40 most recent. What a person read or corrected stays (up to 24 each).
    for (const [k, keep] of [["auto", 40], ["enrol", 24], ["correction", 24]] as const)
      this.db
        .query(
          `DELETE FROM voiceprints WHERE person_id = ? AND kind = ? AND rowid NOT IN
           (SELECT rowid FROM voiceprints WHERE person_id = ? AND kind = ? ORDER BY ts DESC, rowid DESC LIMIT ?)`,
        )
        .run(personId, k, personId, k, keep);
    return true;
  }

  voiceSamples(): { id: number; personId: string; embedding: Float32Array; kind: VoiceKind; ts: number }[] {
    if (this.team) return this.team.voiceSamples();
    return (this.db.query("SELECT rowid AS id, person_id, embedding, kind, ts FROM voiceprints").all() as any[]).map((r) => ({
      id: r.id,
      personId: r.person_id,
      embedding: new Float32Array(new Uint8Array(r.embedding).buffer),
      kind: r.kind as VoiceKind,
      ts: r.ts,
    }));
  }

  deleteVoiceSamples(ids: number[]): void {
    if (this.team) return this.team.deleteVoiceSamples(ids);
    for (const id of ids) this.db.query("DELETE FROM voiceprints WHERE rowid = ?").run(id);
  }

  /** Drops one kind of a person's samples (a new join read replaces the old one). */
  clearVoiceKind(personId: string, kind: VoiceKind): void {
    if (this.team) return this.team.clearVoiceKind(personId, kind);
    this.db.query("DELETE FROM voiceprints WHERE person_id = ? AND kind = ?").run(personId, kind);
  }

  clearVoiceprint(personId: string): void {
    if (this.team) return this.team.clearVoiceprint(personId);
    this.db.query("DELETE FROM voiceprints WHERE person_id = ?").run(personId);
  }
}

function rowToEvent(r: any): JamEvent {
  return {
    id: r.id,
    ts: r.ts,
    kind: r.kind,
    authorType: r.author_type,
    authorId: r.author_id,
    authorName: r.author_name,
    text: r.text,
    relevance: r.relevance,
    workstreamId: r.workstream_id,
    data: JSON.parse(r.data || "{}"),
  };
}
