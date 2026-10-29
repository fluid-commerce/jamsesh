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
const SCRIPT_WORDS = new Set(words(ENROL_SCRIPT.join(" ")));

/** Share of a line's words that come from the script: a transcript of the read, however it was cut up. */
export function scriptShare(text: string) {
  const w = words(text);
  return w.length < 3 ? 0 : w.filter((x) => SCRIPT_WORDS.has(x)).length / w.length;
}
