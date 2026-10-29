import { useEffect, useRef, useState } from "react";
import { copyText, createInvite, inviteText, type Invite } from "../shared/invite";
import { useHub } from "../shared/hub";

const mins = (ms: number) => Math.max(1, Math.round(ms / 60000));

/** Copies a join link and code for a coworker, and shows what was copied. */
export function InviteButton({ compact }: { compact?: boolean }) {
  const { state } = useHub();
  const [phase, setPhase] = useState<"idle" | "busy" | "open" | "error">("idle");
  const [invite, setInvite] = useState<Invite | null>(null);
  const [copied, setCopied] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const name = state?.settings.sessionName ?? "this session";

  useEffect(() => {
    if (phase !== "open") return;
    const away = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setPhase("idle");
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setPhase("idle");
    addEventListener("pointerdown", away);
    addEventListener("keydown", esc);
    return () => (removeEventListener("pointerdown", away), removeEventListener("keydown", esc));
  }, [phase]);

  const make = async () => {
    setPhase("busy");
    try {
      const i = await createInvite();
      setInvite(i);
      setCopied(await copyText(inviteText(i, name)));
      setPhase("open");
    } catch {
      setPhase("error");
    }
  };

  return (
    <div className="invite" ref={wrap}>
      <button className="btn small invite-btn" style={{ height: 36 }} onClick={() => (phase === "open" ? setPhase("idle") : make())} disabled={phase === "busy"} aria-expanded={phase === "open"} title="Copy a link and code so someone can join">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="9" cy="8" r="3.5" />
          <path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6" />
        </svg>
        {!compact && <span className="invite-label">{phase === "busy" ? "Making link…" : "Invite"}</span>}
      </button>
      {phase === "error" && (
        <div className="invite-pop" role="alert">
          Couldn't make an invite. Check your connection and try again.
        </div>
      )}
      {phase === "open" && invite && (
        <div className="invite-pop" role="dialog" aria-label="Invite someone">
          <div className="invite-head">{copied ? "Copied. Paste it to your coworker." : "Copy this to your coworker."}</div>
          <div className="invite-link mono">{invite.url}</div>
          {invite.code && (
            <div className="invite-code">
              Code <b className="mono">{invite.code}</b>
            </div>
          )}
          <div className="invite-note">
            {invite.source === "invite" && invite.expiresAt > 0 && `Works for about ${mins(invite.expiresAt - Date.now())} minutes.`}
            {invite.source === "code" && "This code changes every 30 seconds. Send it quickly, or ask the host for a longer invite."}
            {invite.source === "address" && "Only the host can see the join code: it's on the big screen, under the QR code. Ask them for it."}
          </div>
          <button
            className="btn small"
            onClick={async () => setCopied(await copyText(inviteText(invite, name)))}
          >
            Copy again
          </button>
        </div>
      )}
    </div>
  );
}
