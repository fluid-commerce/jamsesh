import { useState } from "react";
import { pref, setPref } from "./hub";
import type { MicStatus } from "./mic";
import { isInsecure } from "./rtc";

/** Mic trouble, said once and plainly. Plain http is a different problem from a dead mic, so it gets its own note. */
export function MicNotice({ status, onRetry, phone }: { status: MicStatus; onRetry: () => void; phone?: boolean }) {
  const [seen, setSeen] = useState(pref("httpNotice") === "1");
  const cls = `mic-notice ${phone ? "m-error" : ""}`;
  if (isInsecure()) {
    if (seen) return null;
    return (
      <div className={`${cls} info`} role="status">
        <span>
          This page is on plain http, so your browser blocks the mic, camera and screen sharing. Use the JamSesh Mac app, or ask the host for the secure address.
        </span>
        <button className="btn small" onClick={() => (setPref("httpNotice", "1"), setSeen(true))}>
          Got it
        </button>
      </div>
    );
  }
  if (!status.error) return null;
  return (
    <div className={cls} role="alert">
      <span>{status.error}</span>
      <button className="btn small" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

