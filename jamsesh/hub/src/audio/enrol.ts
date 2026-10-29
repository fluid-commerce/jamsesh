// The voice read: a few sentences each person reads aloud when they join, so JamSesh knows
// their voice from the first line. No wake word in them: the room's microphones hear the read.
export const ENROL_SCRIPT = [
  "This is my voice, and this is how I sound while I work.",
  "When I ask for something to go up on the big screen, or to send a change to my agent, it is me talking.",
  "Here is me describing what I see: the layout, the colors, the spacing, and what I would change next.",
];

/** How long the read takes, so the screen can say so. */
export const ENROL_SECONDS = 20;
/** A read opens a window this long unless it is closed sooner; the room's laptops hear it in that time. */
export const ENROL_WINDOW_MS = 90_000;
/** After the read ends, laptops with slow uploads still deliver it. */
export const ENROL_GRACE_MS = 25_000;

const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);
const run = (w: string[], i: number) => w.slice(i, i + 3).join(" ");
/** Every three words in a row of the script, also across sentences, since a laptop may cut the read anywhere. */
const SCRIPT_RUNS = new Set(words(ENROL_SCRIPT.join(" ")).map((_, i, w) => run(w, i)));

/**
 * Share of a line's words that are part of three or more script words in the script's order: a
 * transcript of the read, however it was cut up or misheard here and there. Someone else talking
 * with the same words ("the layout and the spacing on the big screen") isn't the read.
 */
export function scriptShare(text: string) {
  const w = words(text);
  if (w.length < 3) return 0;
  const covered = new Set<number>();
  for (let i = 0; i + 3 <= w.length; i++) if (SCRIPT_RUNS.has(run(w, i))) for (let k = i; k < i + 3; k++) covered.add(k);
  return covered.size / w.length;
}
