// The join read's lifecycle, outside React so every path can be tested: ask the host, open the microphone, record,
// convert, upload. One read at a time. cancel() (the profile closing) ends it wherever it is: the microphone and
// recorder stop, timers clear, nothing is uploaded, and the host is told the read is over.
import { beginRead, endRead } from "./voiceprint";

export type ReadState = "idle" | "recording" | "saving" | "done" | "error";
export interface ReadView {
  state: ReadState;
  msg: string;
  secs: number;
}

interface Recorder {
  state: string;
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

export interface ReadDeps {
  beginRead: (personId: string) => Promise<{ epoch: number; read: string }>;
  endRead: (personId: string, id: string, read: boolean) => Promise<unknown>;
  getUserMedia: () => Promise<MediaStream>;
  recorder: (stream: MediaStream) => Recorder;
  toWav: (blob: Blob) => Promise<ArrayBuffer>;
  upload: (personId: string, epoch: number, read: string, wav: ArrayBuffer, signal: AbortSignal) => Promise<Response>;
  /** The longest read before it stops by itself. */
  maxMs: number;
}

export const browserReadDeps = (toWav: (blob: Blob) => Promise<ArrayBuffer>): ReadDeps => ({
  beginRead,
  endRead,
  getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false } }),
  recorder: (stream) => new MediaRecorder(stream) as unknown as Recorder,
  toWav,
  upload: (personId, epoch, read, wav, signal) => fetch(`/api/people/${personId}/voice?epoch=${epoch}&read=${encodeURIComponent(read)}`, { method: "POST", headers: { "content-type": "audio/wav" }, body: wav, signal }),
  maxMs: 45_000,
});

export class VoiceRead {
  view: ReadView = { state: "idle", msg: "", secs: 0 };
  /** The read under way, if any: a second start while one is in any step is ignored. */
  private run: { cancelled: boolean; stop: () => void; cancel: () => void } | null = null;

  constructor(
    private personId: string,
    private brainName: string,
    private deps: ReadDeps,
    private onChange: (v: ReadView) => void,
  ) {}

  private set(patch: Partial<ReadView>) {
    this.view = { ...this.view, ...patch };
    this.onChange(this.view);
  }

  get busy() {
    return !!this.run;
  }

  /** "Done reading": the recording ends and is sent. */
  stop() {
    this.run?.stop();
  }

  /** The profile closed: everything stops, nothing is sent, the host stops holding the room's lines out. */
  cancel() {
    this.run?.cancel();
  }

  async start() {
    if (this.run) return;
    const d = this.deps;
    const pid = this.personId;
    let stream: MediaStream | null = null;
    let rec: Recorder | null = null;
    let tick: ReturnType<typeof setInterval> | undefined;
    let auto: ReturnType<typeof setTimeout> | undefined;
    let spoke = false;
    let ended = false;
    /** The host took the start: from then on it must hear the end (not before, or the end could overtake it). */
    let begun = false;
    /** The read's id from the host: its end and its recording carry it, so they never touch another read. */
    let readId = "";
    /** Aborts the upload when the profile closes while it's on its way. */
    const sending = new AbortController();
    const release = () => {
      clearInterval(tick);
      clearTimeout(auto);
      stream?.getTracks().forEach((t) => t.stop());
    };
    /** Tells the host once that this read is over without a recording it took. */
    const end = (read: boolean) => {
      if (ended) return;
      ended = true;
      void d.endRead(pid, readId, read).catch(() => {});
    };
    const run = {
      cancelled: false,
      stop: () => rec?.state === "recording" && rec.stop(),
      cancel: () => {
        run.cancelled = true;
        if (rec) {
          rec.onstop = null;
          if (rec.state === "recording") rec.stop();
        }
        release();
        // Closed on the host before the upload is stopped: a recording arriving after this isn't taken. One the host
        // took already stays taken (the read was finished: Done was pressed or its time ran out).
        if (begun) end(spoke);
        sending.abort();
        if (this.run === run) this.run = null;
      },
    };
    this.run = run;
    const done = (patch: Partial<ReadView>) => {
      if (this.run === run) this.run = null;
      if (!run.cancelled) this.set(patch);
    };

    let epoch: number;
    try {
      ({ epoch, read: readId } = await d.beginRead(pid));
    } catch (e) {
      // The host never started holding lines out: nothing to end.
      ended = true;
      return done({ state: "error", msg: `The host couldn't get ready for your read, so nothing was recorded. ${e instanceof Error ? e.message : ""}`.trim() });
    }
    begun = true;
    if (run.cancelled) return end(false);
    try {
      stream = await d.getUserMedia();
      // Closed while the browser asked for the microphone: it is given back at once.
      if (run.cancelled) return release();
      const live = stream;
      const chunks: Blob[] = [];
      rec = d.recorder(live);
      const r = rec;
      r.ondataavailable = (e) => chunks.push(e.data);
      const t0 = Date.now();
      tick = setInterval(() => !run.cancelled && this.set({ secs: Math.floor((Date.now() - t0) / 1000) }), 250);
      auto = setTimeout(() => r.state === "recording" && r.stop(), d.maxMs);
      r.onstop = async () => {
        release();
        if (run.cancelled) return;
        this.set({ state: "saving" });
        try {
          const wav = await d.toWav(new Blob(chunks, { type: r.mimeType }));
          if (run.cancelled) return;
          const res = await d.upload(pid, epoch, readId, wav, sending.signal);
          // Taken or refused by the host, the read is over there; only a failed upload needs ending.
          if (res.ok) ended = true;
          else end(true);
          const body = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; error?: string };
          done(body.ok ? { state: "done", msg: `${this.brainName} knows your voice.` } : { state: "error", msg: body.reason ?? body.error ?? "That didn't work. Try again." });
        } catch (e) {
          end(true);
          if (run.cancelled) return;
          done({ state: "error", msg: e instanceof Error ? e.message : String(e) });
        }
      };
      r.onerror = () => r.state === "recording" && r.stop();
      r.start();
      spoke = true;
      this.set({ secs: 0, state: "recording", msg: "" });
    } catch (e) {
      release();
      end(false);
      done({ state: "error", msg: e instanceof Error ? e.message : String(e) });
    }
  }
}
