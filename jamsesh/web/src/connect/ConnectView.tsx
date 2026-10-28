import { useEffect, useRef, useState } from "react";

const ALPHABET = /[23456789ABCDEFGHJKMNPQRSTUVWXYZ]/;

/** Pair this device with the host: the 4-character code from the big screen. */
export function ConnectView() {
  const params = new URLSearchParams(location.search);
  // Only a path on this site: "//evil.example" or "https://…" would send someone off-site after pairing.
  const wanted = params.get("next") ?? "";
  const next = /^\/(?![/\\])/.test(wanted) ? wanted : "/client";
  const fromLink = useRef(!!params.get("c"));
  const [chars, setChars] = useState<string[]>(() => (params.get("c") ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4).split("").concat(["", "", "", ""]).slice(0, 4));
  const [state, setState] = useState<"idle" | "joining" | "error">("idle");
  const [error, setError] = useState("");
  const [info, setInfo] = useState<{ name: string; brainName: string } | null>(null);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    fetch("/api/pair/info").then((r) => r.json()).then(setInfo).catch(() => {});
    if (chars.join("").length === 4) submit(chars.join(""));
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
        throw new Error(stale ? "That code has expired. Codes change every 30 seconds: scan the big screen again, or type the code showing now." : (j.error ?? "That didn't work."));
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

  return (
    <div className="connect">
      <div className="connect-card">
        <svg width="44" height="44" viewBox="0 0 64 64" aria-hidden>
          <rect width="64" height="64" rx="16" fill="#1c1f23" />
          <circle cx="24" cy="32" r="10" fill="#FF6B4A" />
          <circle cx="40" cy="32" r="10" fill="#3E8BFF" fillOpacity=".9" />
        </svg>
        <h1>Join {info?.name ?? "the session"}</h1>
        <p>Enter the code under the QR code on the big screen. It changes every 30 seconds.</p>
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
