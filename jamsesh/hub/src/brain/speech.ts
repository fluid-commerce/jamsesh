// Speaking to the room: gateway text-to-speech, played by the host view; macOS
// `say` on the host when there is no key or the gateway fails.
import { generateSpeech } from "ai";
import { bus } from "../bus";
import type { Session } from "../session";
import { describeError, gateway } from "./llm";

export async function speak(session: Session, text: string) {
  const s = session.settings();
  session.store.addEvent({ kind: "brain", authorType: "brain", authorName: "Room brain", text, relevance: "work", data: { spoken: s.voiceReplies } });
  if (!s.voiceReplies) return;
  const gw = gateway(session);
  if (gw) {
    try {
      const { audio } = await generateSpeech({ model: gw.speech(s.models.speech), text, voice: s.voice });
      bus.send({ type: "speak", audio: audio.base64, mime: audio.mediaType ?? "audio/mpeg", text });
      return;
    } catch (e) {
      console.error("speech:", describeError(e));
    }
  }
  bus.send({ type: "speak", audio: null, mime: "", text });
  if (process.platform === "darwin" && process.env.JAMSESH_SILENT !== "1") {
    Bun.spawn(["say", text], { stdout: "ignore", stderr: "ignore" });
  }
}
