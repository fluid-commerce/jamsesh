import { useEffect, useRef, useState } from "react";
import { QrScanner } from "./QrScanner";
import { canScan, scanGoes, type Scanned } from "./joinHelp";

const ALPHABET = /[23456789ABCDEFGHJKMNPQRSTUVWXYZ]/;

/** Pair this device with the host: the 4-character code from the big screen. */
export function ConnectView() {
  const params = new URLSearchParams(location.search);
  // Only a path on this site: "//evil.example" or "https://…" would send someone off-site after pairing.
  const wanted = params.get("next") ?? "";
  const next = /^\/(?![/\\])/.test(wanted) ? wanted : "/client";
  const fromLink = useRef(!!params.get("c"));
  // An invite link carries an 8-character code (single use, ten minutes) instead of the 4-character one.
  const linkCode = (params.get("c") ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const invite = linkCode.length === 8 ? linkCode : "";
  const [chars, setChars] = useState<string[]>(() => (params.get("c") ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4).split("").concat(["", "", "", ""]).slice(0, 4));
  const [state, setState] = useState<"idle" | "joining" | "error">("idle");
  const [error, setError] = useState("");
  const [info, setInfo] = useState<{ name: string; brainName: string } | null>(null);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const [scanning, setScanning] = useState(false);
  // A scanned code for an address this page doesn't know waits for a yes.
  const [elsewhere, setElsewhere] = useState<Scanned | null>(null);

  useEffect(() => {
    fetch("/api/pair/info").then((r) => r.json()).then(setInfo).catch(() => {});
    if (invite) submit(invite);
    else if (chars.join("").length === 4) submit(chars.join(""));
    else boxes.current[chars.findIndex((c) => !c)]?.focus();
  }, []);

  async function submit(code: string) {
    setState("joining");
    setError("");
    const wasLink = fromLink.current;
    if (wasLink && code !== (params.get("c") ?? "").toUpperCase()) fromLink.current = false;
    try {
      const r = await fetch("/api/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, kind: "browser", label: deviceLabel() }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // A code from a scanned or saved link is old by the time it is used: say so, rather than blame the typing.
        const stale = fromLink.current && r.status !== 429;
        const why = code.length === 8 ? "That invite has expired or was already used. Ask for a new one, or type the code on the big screen." : "That code has expired. Codes change every 30 seconds: scan the big screen again, or type the code showing now.";
        throw new Error(stale ? why : (j.error ?? "That didn't work."));
      }
      location.replace(next);
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : String(e));
      setChars(["", "", "", ""]);
      setTimeout(() => boxes.current[0]?.focus(), 30);
    }
  }

  // A box holds one character. Typing into a filled box leaves "old+new"; a paste brings the whole code.
  const type = (i: number, v: string, pasted = false) => {
    let letters = v.toUpperCase().split("").filter((c) => ALPHABET.test(c));
    if (!letters.length) return;
    // A pasted invite code (eight characters) goes in whole.
    if (letters.length === 8) return void submit(letters.join(""));
    let at = i;
    if (pasted || letters.length > 2) at = 0;
    else if (letters.length === 2 && chars[i]) letters = letters.slice(-1);
    letters = letters.slice(0, 4);
    const nextChars = [...chars];
    let j = at;
    for (const c of letters) if (j < 4) nextChars[j++] = c;
    setChars(nextChars);
    if (nextChars.every(Boolean)) submit(nextChars.join(""));
    else boxes.current[Math.min(j, 3)]?.focus();
  };

  const go = (s: Scanned) => location.assign(`${s.origin}/connect${s.code ? `?c=${s.code}` : ""}`);
  // A scanned code for this room fills the boxes; one for another address asks first.
  function scanned(s: Scanned) {
    setScanning(false);
    const where = scanGoes(s, location.origin);
    if (where === "known") return void go(s);
    if (where === "ask") return void setElsewhere(s);
    if (!s.code) return void (setState("error"), setError("That QR code has no code in it. Type the code on the big screen."));
    if (s.code.length === 8) return void submit(s.code);
    setChars(s.code.split(""));
    submit(s.code);
  }

  return (
    <div className="connect">
      <div className="connect-card">
        <svg width="44" height="44" viewBox="0 0 64 64" aria-hidden>
          <rect width="64" height="64" rx="16" fill="#1c1f23" />
          <circle cx="24" cy="32" r="10" fill="#FF6B4A" />
          <circle cx="40" cy="32" r="10" fill="#3E8BFF" fillOpacity=".9" />
        </svg>
        <h1>Join {info?.name ?? "the session"}</h1>
        <p>
          The code is on the big screen, under the QR code. It changes every 30 seconds.
          <br />
          <span className="connect-where">Not up? Ask JamSesh “what's the code?”, or ask the host.</span>
        </p>
        <div className={`code-boxes ${state}`} onPaste={(e) => (e.preventDefault(), type(0, e.clipboardData.getData("text"), true))}>
          {chars.map((c, i) => (
            <input
              key={i}
              ref={(el) => {
                boxes.current[i] = el;
              }}
              value={c}
              type="text"
              inputMode="text"
              enterKeyHint="go"
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete={i === 0 ? "one-time-code" : "off"}
              spellCheck={false}
              aria-label={`Code character ${i + 1}`}
              maxLength={i === 0 ? 4 : 2}
              disabled={state === "joining"}
              onChange={(e) => type(i, e.target.value)}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                if (e.key === "Backspace" && !chars[i] && i > 0) {
                  const n = [...chars];
                  n[i - 1] = "";
                  setChars(n);
                  boxes.current[i - 1]?.focus();
                }
              }}
            />
          ))}
        </div>
        {!canScan() && <span className="connect-where">Or open your phone's Camera app and point it at the QR code.</span>}
        {canScan() && !scanning && (
          <button type="button" className="connect-paste" disabled={state === "joining"} onClick={() => setScanning(true)}>
            Scan the QR code
          </button>
        )}
        {scanning && <QrScanner onScan={scanned} onClose={() => setScanning(false)} />}
        {elsewhere && (
          <div className="connect-elsewhere" role="alertdialog" aria-label="Another address">
            <p>
              That QR code is for <b>{elsewhere.origin.replace(/^https?:\/\//, "")}</b>, not this room. Go there only if it's the big screen in front of you.
            </p>
            <div className="row">
              <button type="button" className="connect-paste" onClick={() => go(elsewhere)}>
                Go to {elsewhere.origin.replace(/^https?:\/\//, "")}
              </button>
              <button type="button" className="connect-paste" onClick={() => setElsewhere(null)}>
                Stay here
              </button>
            </div>
          </div>
        )}
        <button
          type="button"
          className="connect-paste"
          disabled={state === "joining"}
          onClick={async () => {
            try {
              type(0, await navigator.clipboard.readText(), true);
            } catch {
              boxes.current[chars.findIndex((c) => !c) === -1 ? 0 : chars.findIndex((c) => !c)]?.focus();
            }
          }}
        >
          Paste code
        </button>
        <div className="connect-status" role="status">
          {state === "joining" ? "Connecting…" : state === "error" ? error : "Letters and numbers only; capitals don't matter."}
        </div>
        {/* A Mac in a browser (not already inside the app, which shows this page from 127.0.0.1). */}
        {/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints === 0 && location.hostname !== "127.0.0.1" && (
          <>
            <a className="connect-app" href="/download/mac">
              On a Mac? Get the JamSesh app
            </a>
            <details className="connect-help">
              <summary>If macOS won't open it</summary>
              <ol>
                <li>Open the downloaded app once, then dismiss the warning.</li>
                <li>Go to System Settings, Privacy &amp; Security, and click Open Anyway.</li>
                <li>Allow Local Network, Microphone and Camera when asked, so the app can find sessions and hear you.</li>
              </ol>
            </details>
          </>
        )}
      </div>
    </div>
  );
}

function deviceLabel() {
  const ua = navigator.userAgent;
  const kind = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows PC" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "browser";
  return `${kind} · ${browser}`;
}
