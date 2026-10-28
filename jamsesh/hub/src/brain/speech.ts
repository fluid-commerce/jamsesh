// Speaking to the room. A room full of people talking doesn't want a voice assistant
// that answers everything, but a brain that never makes a sound feels dead. The policy:
//
// - Being addressed by voice gets an instant chime (heard you), never a spoken "on it".
// - Speak only what can't be seen: answers to questions, and problems someone must
//   know about ("there's no mobile dev server yet"). Actions that show up on the big
//   screen or as a routed toast stay silent.
// - Typed requests are answered in text: one person typed, so don't announce it to the room.
// - Things the brain did on its own (from overheard talk, a shipped change) are never
//   spoken; the toast is enough.
// - Short (two sentences), and not more often than every few seconds. A room that
//   asked it to be quiet gets answers only.
// - The host view stops talking when someone in the room starts talking (barge-in).
import { generateSpeech } from "ai";
import { bus } from "../bus";
import type { Session } from "../session";
import { describeError, gateway } from "./llm";

export type SpeechSource = "voice" | "recorded" | "typed" | "ambient";
/** "request": the room must answer out loud (a host build waiting for approval). */
export type SpeechKind = "answer" | "problem" | "confirm" | "request";

let lastSpokeAt = 0;

/** Pure decision, exported for tests. */
export function speechDecision(opts: {
  voiceReplies: boolean;
  source: SpeechSource;
  kind: SpeechKind;
  quietRoom: boolean;
  sinceLastMs: number;
}): "speak" | "text" {
  const { voiceReplies, source, kind, quietRoom, sinceLastMs } = opts;
  if (!voiceReplies) return "text";
  // Someone has to answer, and often nobody is at the host to read it: always said out loud.
  if (kind === "request") return "speak";
  if (source === "typed" || source === "ambient") return "text";
  if (kind === "confirm") return "text";
  if (quietRoom && kind !== "answer") return "text";
  if (sinceLastMs < 4000) return "text";
  return "speak";
}

/** "Talk less", "don't talk unless asked", "stay quiet" and the like, saved as room notes. */
export function quietRoom(notes: string[]) {
  return notes.some((n) =>
    /\b(quiet|silent|shush|hush|mute|don'?t (talk|speak)|do not (talk|speak)|stop (talking|speaking)|less talk|talk(ing)? less|speak(ing)? less|no voice|unless (someone|we|i|anyone|people|they|you'?re|you are) (ask|spoken|talk|address)|only (talk|speak|respond|reply|answer|say anything|chime in|jump in)\b[^.]{0,40}\b(ask|spoken to|addressed|talk to|call on|prompt|need)|(talk|speak|respond|reply) only (when|if)|when (someone|we|i|anyone|people) (ask|ask you|talk to you|address))/i.test(n),
  );
}

/** Keeps spoken replies to two sentences. */
export function trimForSpeech(text: string) {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]*/g) ?? [text];
  return sentences.slice(0, 2).map((x) => x.trim()).join(" ");
}

export function chime(session: Session, deviceId?: string) {
  bus.send({ type: "chime", deviceId: deviceId ?? null } as any);
  void session;
}

export async function speak(session: Session, text: string, opts: { source?: SpeechSource; kind?: SpeechKind } = {}) {
  const s = session.settings();
  const source = opts.source ?? "voice";
  const kind = opts.kind ?? "answer";
  // Requests wait out the gap after the last reply instead of being dropped to text.
  if (kind === "request" && s.voiceReplies) {
    const wait = 4000 - (Date.now() - lastSpokeAt);
    if (wait > 0) await Bun.sleep(wait);
  }
  const decision = speechDecision({ voiceReplies: s.voiceReplies, source, kind, quietRoom: quietRoom(s.brainNotes), sinceLastMs: Date.now() - lastSpokeAt });
  const spoken = decision === "speak";
  const words = spoken ? trimForSpeech(text) : text;
  session.store.addEvent({ kind: "brain", authorType: "brain", authorName: s.brainName, text: words, relevance: "work", data: { spoken, source, speechKind: kind } });
  if (!spoken) {
    bus.send({ type: "toast", tone: kind === "problem" ? "warn" : "info", text: s.brainName, detail: text });
    return "shown";
  }
  lastSpokeAt = Date.now();
  const gw = gateway(session);
  if (gw) {
    try {
      const { audio } = await generateSpeech({ model: gw.speech(s.models.speech), text: words, voice: s.voice });
      bus.send({ type: "speak", audio: audio.base64, mime: audio.mediaType ?? "audio/mpeg", text: words });
      return "spoken";
    } catch (e) {
      console.error("speech:", describeError(e));
    }
  }
  bus.send({ type: "speak", audio: null, mime: "", text: words });
  if (process.platform === "darwin" && process.env.JAMSESH_SILENT !== "1") {
    Bun.spawn(["say", words], { stdout: "ignore", stderr: "ignore" });
  }
  return "spoken";
}
