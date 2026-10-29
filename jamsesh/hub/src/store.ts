// Session storage: SQLite on disk, with small collections cached in memory.
// Events (the context log) get full-text search through FTS5.
import { pastDeadline } from "./room-context";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { bus } from "./bus";
import type {
  Agent,
  Annotation,
  Artifact,
  Fact,
  TriageCard,
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
  triage: TriageCard;
  documents: Document;
};
export type CollectionName = keyof Collections;

export const PALETTE = ["#FF6B4A", "#3E8BFF", "#22C08B", "#B36BFF", "#FFB020", "#FF4FA3", "#18C6D6", "#8FD14F"];

/** Collections and settings that belong to the team and outlive any one session. */
const TEAM_COLLECTIONS = new Set<string>(["people", "devices"]);
const TEAM_SETTINGS = new Set<string>([
  "hostId",
  "gatewayKey",
  "brainName",
  "brainAliases",
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

export class Store {
  db: Database;
  private cache = new Map<CollectionName, Map<string, any>>();

  /** The team store (people, devices, voiceprints, team settings); null when this is the team store. */
  team: Store | null = null;

  /**
   * Set by Hub.shutdown. "events" (the conversation is sealed, the wiki's last capture is about to read it): an event write
   * throws (code ESEALED), which a request answers with 503, so nothing lands that the capture would miss. "all" (the final
   * capture is done and the hub has stopped): every write path comes through writable(), which drops the write with a logged
   * warning and returns false. A late timer, refresh or job can then neither corrupt anything nor fail unhandled; whatever it
   * would have written is by definition not part of the session record, which was taken at the capture.
   */
  private sealed: "events" | "all" | null = null;

  seal(what: "events" | "all") {
    if (this.sealed !== "all") this.sealed = what;
    if (what === "all") this.team?.seal("all");
  }

  private dropped = 0;

  /** The room has stopped: writes are dropped. */
  get closed() {
    return this.sealed === "all";
  }

  /** True when a write may go ahead. A write by work that began in a request and outlived the shutdown deadline (room-context.ts): false, like sealed "all". Sealed "all": false (the write is dropped, logged). Sealed "events" and an event write: throws. */
  private writable(event = false): boolean {
    if (this.sealed === "all" || pastDeadline()) {
      if (this.dropped++ % 50 === 0) console.warn(`store: the room is closed; a write was dropped (${this.dropped} so far)`);
      return false;
    }
    if (event && this.sealed === "events") throw Object.assign(new Error("The room is closed."), { code: "ESEALED" });
    return true;
  }

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
      CREATE TABLE IF NOT EXISTS replies (key TEXT PRIMARY KEY, status INTEGER NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL);
    `);
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
    if (!this.writable()) return doc;
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
    if (!this.writable()) return;
    this.map(c).delete(id);
    this.db.query("DELETE FROM docs WHERE collection = ? AND id = ?").run(c, id);
    bus.changed(c);
  }

  // ---- settings ----

  // ---- replayed calls: the first answer to each idempotency key, kept across restarts for as long
  // as a laptop keeps a change queued (seven days) ----

  reply(key: string): { status: number; type: string; body: string } | null {
    return (this.db.query("SELECT status, type, body FROM replies WHERE key = ? AND at > ?").get(key, Date.now() - REPLAY_MS) as { status: number; type: string; body: string } | null) ?? null;
  }

  saveReply(key: string, r: { status: number; type: string; body: string }): void {
    if (!this.writable()) return;
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
    if (!this.writable()) return;
    this.db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
  }

  // ---- events ----

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
    if (!this.writable(true)) return { id: 0, ts: e.ts ?? Date.now(), kind: e.kind, authorType: e.authorType, authorId: e.authorId ?? null, authorName: e.authorName, text: e.text, relevance: e.relevance ?? null, workstreamId: e.workstreamId ?? null, data: e.data ?? {} };
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
    bus.send({ type: "event", event });
    return event;
  }

  updateEvent(id: number, fields: Partial<Pick<JamEvent, "text" | "relevance" | "workstreamId" | "authorId" | "authorName" | "data">>) {
    if (!this.writable(true)) return;
    const cur = this.event(id);
    if (!cur) return;
    const next = { ...cur, ...fields, data: { ...cur.data, ...(fields.data ?? {}) } };
    this.db
      .query("UPDATE events SET text = ?, relevance = ?, workstream_id = ?, author_id = ?, author_name = ?, data = ? WHERE id = ?")
      .run(next.text, next.relevance, next.workstreamId, next.authorId, next.authorName, JSON.stringify(next.data), id);
    bus.send({ type: "event", event: next });
    return next;
  }

  /** Deletes everything one agent put in the room, or that was addressed to it. Returns the ids. */
  deleteAgentEvents(agentId: string): number[] {
    if (!this.writable(true)) return [];
    const where = "author_id = ?1 OR json_extract(data, '$.agentId') = ?1 OR json_extract(data, '$.to') = ?1";
    const rows = this.db.query(`SELECT id, text, author_name FROM events WHERE ${where}`).all(agentId) as { id: number; text: string; author_name: string }[];
    for (const r of rows) this.db.query("INSERT INTO events_fts(events_fts, rowid, text, author_name) VALUES ('delete', ?, ?, ?)").run(r.id, r.text, r.author_name);
    this.db.query(`DELETE FROM events WHERE ${where}`).run(agentId);
    return rows.map((r) => r.id);
  }

  event(id: number): JamEvent | undefined {
    const row = this.db.query("SELECT * FROM events WHERE id = ?").get(id);
    return row ? rowToEvent(row) : undefined;
  }

  recentEvents(opts: { limit?: number; since?: number; kinds?: EventKind[]; afterId?: number; beforeId?: number } = {}): JamEvent[] {
    const where: string[] = [];
    const args: any[] = [];
    if (opts.since) (where.push("ts >= ?"), args.push(opts.since));
    if (opts.afterId != null) (where.push("id > ?"), args.push(opts.afterId));
    if (opts.beforeId != null) (where.push("id < ?"), args.push(opts.beforeId));
    if (opts.kinds?.length) (where.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`), args.push(...opts.kinds));
    const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    args.push(opts.limit ?? 100);
    return (this.db.query(sql).all(...args) as any[]).map(rowToEvent).reverse();
  }

  /** Events after an id, oldest first: for reading forward through everything, a page at a time. */
  eventsAfter(afterId: number, limit = 500): JamEvent[] {
    return (this.db.query("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?").all(afterId, limit) as any[]).map(rowToEvent);
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
    if (!this.writable()) return;
    this.db
      .query("INSERT OR REPLACE INTO digests (scope, text, updated, through_event) VALUES (?, ?, ?, ?)")
      .run(scope, text, Date.now(), throughEvent);
    bus.changed("digest");
  }

  // ---- voiceprints ----

  addVoiceSample(personId: string, embedding: Float32Array): void {
    if (this.team) return this.team.addVoiceSample(personId, embedding);
    if (!this.writable()) return;
    this.db.query("INSERT INTO voiceprints (person_id, ts, embedding) VALUES (?, ?, ?)").run(personId, Date.now(), new Uint8Array(embedding.buffer.slice(0)));
    // Keep the 40 most recent samples per person.
    this.db
      .query(
        `DELETE FROM voiceprints WHERE person_id = ? AND rowid NOT IN
         (SELECT rowid FROM voiceprints WHERE person_id = ? ORDER BY ts DESC LIMIT 40)`,
      )
      .run(personId, personId);
  }

  voiceSamples(): { personId: string; embedding: Float32Array }[] {
    if (this.team) return this.team.voiceSamples();
    return (this.db.query("SELECT person_id, embedding FROM voiceprints").all() as any[]).map((r) => ({
      personId: r.person_id,
      embedding: new Float32Array(new Uint8Array(r.embedding).buffer),
    }));
  }

  clearVoiceprint(personId: string): void {
    if (this.team) return this.team.clearVoiceprint(personId);
    if (!this.writable()) return;
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
