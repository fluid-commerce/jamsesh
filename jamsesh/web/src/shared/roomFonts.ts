// Fonts for everyone (SPEC 12.4), page side. The host holds the open fonts its repositories use and
// the fonts people lent for the session; a canvas loads the ones it lacks, then the ones on its own Mac
// (canvasJoin.ts), and asks the room for what is still missing. A person whose Mac has a font that
// someone is waiting for is asked once whether they may share it. Nothing here is stored: bytes go
// from the host's memory into the canvas's memory.
import type { FontInfo, FontWant } from "../../../hub/src/types";
import { FontTries, loadLocalFonts, missingFamilies, type Fc, type Invoke } from "./canvasJoin";

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

/** Per canvas: the fonts already loaded into it, the families asked of this Mac, and the ones the room was told about. */
export interface FontMemory {
  loaded: Set<string>;
  tried: FontTries;
  asked: Set<string>;
}
export const newFontMemory = (): FontMemory => ({ loaded: new Set(), tried: new FontTries(), asked: new Set() });

/**
 * Loads into the canvas the fonts it lacks, in order: the room's (open fonts and borrowed ones),
 * this Mac's own, and then asks the room for what is still missing. Returns the families still drawn
 * in a substitute. The canvas keeps every font in memory only (`text.loadFont` installs nothing).
 */
export async function loadFonts(fc: Fc, invoke: Invoke | null, memory: FontMemory, room: RoomFonts): Promise<string[]> {
  let missing = await missingFamilies(fc);
  if (!missing.length) return missing;
  const held = new Map(room.available.map((f) => [familyKey(f.family), f]));
  let loadedAny = false;
  for (const family of missing) {
    const font = held.get(familyKey(family));
    if (!font || memory.loaded.has(font.key)) continue;
    memory.loaded.add(font.key);
    let got = 0;
    for (let n = 0; n < font.faces; n++) {
      const data = await room.fetchFace(font.key, n).catch(() => null);
      if (data && (await fc.execute("text.loadFont", { data }).then(() => true, () => false))) got++;
    }
    // A font that didn't come is tried again on the next pass.
    if (got) loadedAny = true;
    else memory.loaded.delete(font.key);
  }
  if (loadedAny) missing = await missingFamilies(fc);
  missing = await loadLocalFonts(fc, invoke, memory.tried);
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
