// Record (6.2): what a person says while pointing becomes notes pinned to those spots.
// Pure alignment of transcript timing against pointer marks, plus finding who owns a pinned item.
import type { Annotation, NotePin, RecordMark, RecordNote, Utterance } from "./types";
import type { Session } from "./session";

/** A mark counts as "while saying it" from this long before the words start to this long after they end. */
export const LEAD_MS = 400;
export const LAG_MS = 300;
/** Pointed first, then explained: a mark this recent before the words still belongs to them. */
export const BEFORE_MS = 2500;
/** Said it, then pointed: a mark starting this soon after the words still belongs to them. */
export const AFTER_MS = 800;
/** A click is a moment; it keeps pulling words toward it for a little after. */
const CLICK_LINGER_MS = 600;
/** Two marks closer than this (0..1) on the same item are the same spot. */
const SAME_SPOT = 0.12;
const MIN_CHUNK_WORDS = 2;

type Line = Pick<Utterance, "id" | "t0" | "t1" | "text" | "personId">;

const span = (m: RecordMark): [number, number] => [m.t, m.t + (m.kind === "click" ? CLICK_LINGER_MS : Math.max(0, m.dur ?? 0))];
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);
const weight = (k: RecordMark["kind"]) => (k === "click" ? 3 : k === "drag" ? 2 : 1);
const sameSpot = (a: RecordMark, b: RecordMark) => a.target.kind === b.target.kind && a.target.ref === b.target.ref && (a.target.nodeId ?? "") === (b.target.nodeId ?? "") && Math.hypot(a.x - b.x, a.y - b.y) <= SAME_SPOT;

const pinOf = (m: RecordMark): NotePin => ({ target: m.target, x: m.x, y: m.y, kind: m.kind, ...(m.scroll ? { scroll: m.scroll } : {}) });

/** Whose pointer a line can be matched with: its own speaker's, or anyone's when either side is unattributed. */
const eligible = (m: RecordMark, l: Line) => !m.driverId || !l.personId || m.driverId === l.personId;

/**
 * One note per thing said. Each is pinned to the pointer moment it was said during; a line that
 * crosses to a different spot is split there, in proportion to when each word was said. Pointing
 * just before speaking, or just after, still counts; anything further apart is a note with no pin.
 * Several drivers on one screen each keep their own pointer: a line never takes another driver's mark.
 */
export function alignNotes(lines: Line[], marks: RecordMark[], opts: { screenId?: string | null } = {}): RecordNote[] {
  const ms = marks.filter((m) => m && m.kind !== "move" && Number.isFinite(m.t) && Number.isFinite(m.x) && Number.isFinite(m.y) && m.target).sort((a, b) => a.t - b.t);
  const notes: RecordNote[] = [];
  const screenId = opts.screenId ?? null;
  for (const l of [...lines].sort((a, b) => a.t0 - b.t0 || (a.id < b.id ? -1 : 1))) {
    const text = l.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const t1 = Math.max(l.t1, l.t0);
    const pool = ms.filter((m) => eligible(m, l));
    const during = pool.filter((m) => {
      const [a, b] = span(m);
      return overlap(a, b, l.t0 - LEAD_MS, t1 + LAG_MS) >= 0 && a <= t1 + LAG_MS;
    });
    const mk = (id: string, t: string, a: number, b: number, m: RecordMark | null): RecordNote => ({ id, text: t, t0: a, t1: b, personId: l.personId, pin: m ? pinOf(m) : null, ...(screenId ? { screenId } : {}) });

    // The marks it was said during, collapsed to distinct spots in the order they happened.
    const spots: RecordMark[] = [];
    for (const m of during) if (!spots.some((s) => sameSpot(s, m))) spots.push(m);
    const words = text.split(" ");
    if (spots.length >= 2 && words.length >= MIN_CHUNK_WORDS * spots.length) {
      // Each word goes to the spot being pointed at when it was said (the latest mark that has started by then).
      const dur = Math.max(1, t1 - l.t0);
      const at = (i: number) => l.t0 + ((i + 0.5) / words.length) * dur;
      const owner = words.map((_, i) => {
        let best = spots[0];
        for (const s of spots) if (s.t - LEAD_MS <= at(i)) best = s;
        return best;
      });
      const chunks: { m: RecordMark; from: number; to: number }[] = [];
      owner.forEach((m, i) => {
        const last = chunks[chunks.length - 1];
        if (last && last.m === m) last.to = i + 1;
        else chunks.push({ m, from: i, to: i + 1 });
      });
      // A chunk too short to mean anything joins its neighbour.
      for (let i = 0; i < chunks.length && chunks.length > 1; ) {
        const c = chunks[i];
        if (c.to - c.from >= MIN_CHUNK_WORDS) {
          i++;
          continue;
        }
        const into = i > 0 ? chunks[i - 1] : chunks[i + 1];
        into.from = Math.min(into.from, c.from);
        into.to = Math.max(into.to, c.to);
        chunks.splice(i, 1);
        i = Math.max(0, i - 1);
      }
      if (chunks.length > 1) {
        chunks.forEach((c, k) => notes.push(mk(`${l.id}.${k}`, words.slice(c.from, c.to).join(" "), Math.round(l.t0 + (c.from / words.length) * dur), Math.round(l.t0 + (c.to / words.length) * dur), c.m)));
        continue;
      }
    }

    let pick: RecordMark | null = null;
    if (during.length) {
      let bestScore = -Infinity;
      for (const m of during) {
        const [a, b] = span(m);
        const score = Math.max(0, overlap(a, b, l.t0, t1)) + weight(m.kind) * 50 - Math.abs(m.t - l.t0) / 100;
        if (score > bestScore) (bestScore = score, (pick = m));
      }
    } else {
      // Pointed, then explained; or explained, then pointed.
      const before = pool.filter((m) => span(m)[1] <= l.t0 - LEAD_MS && l.t0 - span(m)[1] <= BEFORE_MS).pop();
      const after = pool.find((m) => m.t > t1 + LAG_MS && m.t - t1 <= AFTER_MS);
      pick = before ?? after ?? null;
    }
    notes.push(mk(`${l.id}.0`, text, l.t0, t1, pick));
  }
  return notes;
}

/** The agent that owns what a pin is on: a build or frame's author. Null when nobody does. */
export function ownerOf(s: Session, target: Annotation["target"] | undefined | null): string | null {
  if (!target) return null;
  const arts = s.artifacts();
  let art = target.kind === "artifact" ? arts.find((a) => a.id === target.ref) : undefined;
  if (!art && target.kind === "canvas") art = (target.nodeId ? arts.find((a) => a.kind === "frame" && a.nodeId === target.nodeId) : undefined) ?? arts.find((a) => a.kind === "frame" && a.title === target.label);
  if (!art && target.kind === "web") art = arts.find((a) => a.kind === "devserver" && !!a.url && a.url === target.ref);
  const agent = art?.agentId ? s.agent(art.agentId) : undefined;
  return agent && agent.role !== "observer" ? agent.id : null;
}

const where = (x: number, y: number) => {
  const v = y < 0.33 ? "top" : y > 0.66 ? "bottom" : "middle";
  const h = x < 0.33 ? "left" : x > 0.66 ? "right" : "center";
  return v === "middle" && h === "center" ? "the center" : `${v} ${h}`;
};

/** One note as a line an agent can act on: what was said, and exactly where. */
export function describeNote(n: { text: string; pin: NotePin | null; screenId?: string | null; crop?: string | null }, i: number): string {
  const p = n.pin;
  const bits: string[] = [];
  if (p) {
    const t = p.target;
    bits.push(`on ${t.kind} "${t.label}"${t.nodeId ? ` (node ${t.nodeId})` : ""}`);
    if (t.page) bits.push(`page "${t.page}"`);
    bits.push(`at ${where(p.x, p.y)} (${Math.round(p.x * 100)}%, ${Math.round(p.y * 100)}%)`);
    if (t.canvasX != null && t.canvasY != null) bits.push(`canvas point ${Math.round(t.canvasX)}, ${Math.round(t.canvasY)}`);
    if (p.scroll && (p.scroll.x || p.scroll.y)) bits.push(`scrolled to ${Math.round(p.scroll.x)}, ${Math.round(p.scroll.y)}`);
  }
  if (n.screenId) bits.push(`on the big screen "${n.screenId}"`);
  return `${i + 1}. ${bits.length ? `${bits.join(", ")}: ` : ""}“${n.text}”${n.crop ? ` [picture of the spot: ${n.crop}]` : ""}`;
}
