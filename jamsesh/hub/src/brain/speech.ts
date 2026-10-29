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
import { config } from "../config";
import type { Session } from "../session";
import { describeError, gateway } from "./llm";

export type SpeechSource = "voice" | "recorded" | "typed" | "ambient";
/** "request": the room must answer out loud (a host build waiting for approval). */
export type SpeechKind = "answer" | "problem" | "confirm" | "request";

let lastSpokeAt = 0;
let lastFallbackToastAt = 0;

/** Forgets when the brain last spoke and last said it fell back (tests share this process). */
export function resetSpeechState() {
  lastSpokeAt = 0;
  lastFallbackToastAt = 0;
}

/** Voices the OpenAI speech models offer; other providers name theirs differently. */
export const OPENAI_VOICES = ["nova", "alloy", "echo", "fable", "onyx", "shimmer", "coral", "sage", "ash"];
/** Microsoft's MAI voices that the gateway accepts by name (checked 2026-10-28); the model's own voice is the default. */
export const MAI_VOICES = ["Grant", "Iris", "Jasper"];

/**
 * The voice to ask the model for: the room's choice when the model offers it, otherwise none, so
 * the model's own default speaks instead of the request failing ("nova" is only an OpenAI voice).
 */
export function voiceFor(model: string, voice: string): string | undefined {
  // OpenAI's models need a voice named; nova is the one rooms have always heard.
  if (model.startsWith("openai/")) return OPENAI_VOICES.includes(voice) ? voice : "nova";
  if (model.startsWith("microsoft/mai-voice")) return MAI_VOICES.includes(voice) ? voice : undefined;
  return voice || undefined;
}

/** One spoken sentence from the configured speech model; throws when it can't (no key, gateway down). */
export async function synthesize(session: Session, text: string, voice?: string) {
  const gw = gateway(session);
  if (!gw) throw new Error(config.offline ? "the hub is running offline" : "no AI Gateway key is set");
  const s = session.settings();
  const chosen = voiceFor(s.models.speech, voice || s.voice);
  const { audio } = await generateSpeech({ model: gw.speech(s.models.speech), text, ...(chosen ? { voice: chosen } : {}) });
  return { audio: audio.base64, mime: audio.mediaType ?? "audio/mpeg" };
}

/**
 * Pure decision, exported for tests. Spoken requests get spoken answers, problems and a few-word
 * confirmation ("Sent to Felipe's agent"); typed and overheard lines get text only.
 */
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

/** True when nothing may make a sound: JAMSESH_SILENT=1 stops the hub's `say`, the audio it sends to pages, and chimes. */
export function silent() {
  return process.env.JAMSESH_SILENT === "1";
}

export function chime(session: Session, deviceId?: string) {
  if (silent()) return;
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
  // A silent hub sends the reply as text only, whole (nothing is said, so there is nothing to keep short): record that it was shown, not said.
  const muted = spoken && silent();
  const words = spoken && !muted ? trimForSpeech(text) : text;
  session.store.addEvent({ kind: "brain", authorType: "brain", authorName: s.brainName, text: words, relevance: "work", data: { spoken: spoken && !muted, shownNotSpoken: muted, source, speechKind: kind } });
  if (!spoken) {
    bus.send({ type: "toast", tone: kind === "problem" ? "warn" : "info", text: s.brainName, detail: text });
    return "shown";
  }
  // Silent: the text still shows, but no speech is made or sent, and it doesn't count as the last thing said.
  if (silent()) {
    bus.send({ type: "speak", audio: null, mime: "", text: words });
    return "shown";
  }
  lastSpokeAt = Date.now();
  let reason = "";
  try {
    const { audio, mime } = await synthesize(session, words);
    bus.send({ type: "speak", audio, mime, text: words });
    return "spoken";
  } catch (e) {
    reason = describeError(e).slice(0, 120);
    console.error("speech:", reason);
  }
  bus.send({ type: "speak", audio: null, mime: "", text: words });
  const mac = process.platform === "darwin";
  // Tests never talk out loud: bun test sets NODE_ENV=test, and hubs they spawn inherit it.
  if (mac && process.env.NODE_ENV !== "test") {
    Bun.spawn(["say", words], { stdout: "ignore", stderr: "ignore" });
  }
  // Said in a worse voice than the room chose: tell them why, once in a while.
  if (Date.now() - lastFallbackToastAt > 5 * 60_000) {
    lastFallbackToastAt = Date.now();
    bus.send({ type: "toast", tone: "warn", text: mac ? "Using the Mac's built-in voice" : "No good voice available", detail: reason });
  }
  return "spoken";
}

/** What the owner of a locked screen hears when an agent wants it: "Chey, Felipe's agent has the checkout build ready. Can I put it up?" */
export function showRequestSpeech(r: { ownerName: string; agentName: string; agentOwner: string; label: string }) {
  const first = (n: string) => n.split(/\s+/)[0];
  const whose = r.agentOwner ? `${first(r.agentOwner)}'s agent` : r.agentName;
  return `${first(r.ownerName)}, ${whose} has ${r.label} ready. Can I put it up?`;
}
