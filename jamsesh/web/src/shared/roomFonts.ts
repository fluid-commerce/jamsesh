// Fonts for everyone (SPEC 12.4), page side. The host holds the open fonts its repositories use and
// the fonts people lent for the session; a canvas loads the ones it lacks and asks the room for what
// is still missing. A person whose Mac has a font that someone is waiting for is asked once whether
// they may share it (the Mac app's own dialog sends it; no page reads a Mac's fonts). Nothing here is
// stored: bytes go from the host's memory into the canvas's memory.
import type { FontInfo, FontWant } from "../../../hub/src/types";
import { missingFamilies, type Fc } from "./canvasJoin";

export const familyKey = (f: string) => f.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** What a canvas needs from the room to get its fonts. */
export interface RoomFonts {
  available: FontInfo[];
  /** One face of a held font, base64 (null: gone or refused). */
  fetchFace: (key: string, n: number) => Promise<string | null>;
  /** Tell the room these families are drawn in a substitute (it fetches open ones and asks people for the rest). */
  want: (families: string[]) => Promise<unknown>;
}

/**
 * Per canvas: the faces already in it (by font key), how often each face failed, the families it has drawn in a
 * substitute, and the ones the room was told about.
 */
export interface FontMemory {
  faces: Map<string, Set<number>>;
  fails: Map<string, number>;
  needed: Set<string>;
  asked: Set<string>;
}
export const newFontMemory = (): FontMemory => ({ faces: new Map(), fails: new Map(), needed: new Set(), asked: new Set() });

/** A face the host can't serve, or the canvas refuses, is tried this many times (one a pass); a dropped connection doesn't count. */
export const FACE_TRIES = 3;

/**
 * Loads into the canvas the room's fonts (open fonts and borrowed ones) for the families it lacks, face by face: a
 * face that didn't come is tried again on later passes, even once another face of its family has filled in. Then
 * asks the room for what is still missing. Returns the families still drawn in a substitute. The canvas keeps every
 * font in memory only (`text.loadFont` installs nothing).
 */
export async function loadFonts(fc: Fc, memory: FontMemory, room: RoomFonts): Promise<string[]> {
  let missing = await missingFamilies(fc);
  for (const f of missing) memory.needed.add(familyKey(f));
  const held = new Map(room.available.map((f) => [familyKey(f.family), f]));
  let loadedAny = false;
  for (const family of memory.needed) {
    const font = held.get(family);
    if (!font) continue;
    const have = memory.faces.get(font.key) ?? new Set<number>();
    memory.faces.set(font.key, have);
    for (let n = 0; n < font.faces; n++) {
      const face = `${font.key}/${n}`;
      if (have.has(n) || (memory.fails.get(face) ?? 0) >= FACE_TRIES) continue;
      const data = await room.fetchFace(font.key, n).catch(() => undefined);
      if (data === undefined) continue;
      if (data && (await fc.execute("text.loadFont", { data }).then(() => true, () => false))) (have.add(n), (loadedAny = true));
      else memory.fails.set(face, (memory.fails.get(face) ?? 0) + 1);
    }
  }
  if (loadedAny) missing = await missingFamilies(fc);
  const ask = missing.filter((f) => !memory.asked.has(familyKey(f)) && !held.has(familyKey(f)));
  if (ask.length) {
    for (const f of ask) memory.asked.add(familyKey(f));
    await room.want(ask).catch(() => {
      for (const f of ask) memory.asked.delete(familyKey(f));
    });
  }
  return missing;
}

/** The fonts someone is waiting for that this person hasn't been asked about, or declined, or that have since arrived. */
export function openQuestions(wanted: FontWant[], available: FontInfo[], me: string | null, answered: Set<string>): FontWant[] {
  if (!me) return [];
  const have = new Set(available.map((f) => f.key));
  return wanted.filter((w) => !have.has(w.key) && !w.declinedBy.includes(me) && !answered.has(w.key));
}

/** After a failed lookup: counts a try for each family and puts back in `checked` the ones out of tries. True when any family may still be asked again. */
export function noteLookupFailed(tries: Map<string, number>, families: string[], checked: Set<string>, max = 3): boolean {
  let more = false;
  for (const f of families) {
    const k = familyKey(f);
    const n = (tries.get(k) ?? 0) + 1;
    tries.set(k, n);
    if (n >= max) checked.add(k);
    else more = true;
  }
  return more;
}

/** Asks the Mac which of these families it has. Families are marked checked while asking; a failed lookup unmarks them so it can be asked again. */
export async function lookUpFonts(invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>, families: string[], checked: Set<string>): Promise<string[] | null> {
  for (const f of families) checked.add(familyKey(f));
  try {
    const names = await invoke("has_fonts", { families });
    return Array.isArray(names) ? names.map(String) : [];
  } catch {
    for (const f of families) checked.delete(familyKey(f));
    return null;
  }
}
