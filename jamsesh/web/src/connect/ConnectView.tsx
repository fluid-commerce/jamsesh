import { useEffect, useRef, useState } from "react";

const ALPHABET = /[23456789ABCDEFGHJKMNPQRSTUVWXYZ]/;

/** Pair this device with the host: the 4-character code from the big screen. */
export function ConnectView() {
  const params = new URLSearchParams(location.search);
  const next = params.get("next") || "/client";
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
    try {
      const r = await fetch("/api/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, kind: "browser", label: deviceLabel() }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "That didn't work.");
      location.replace(next);
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : String(e));
      setChars(["", "", "", ""]);
      setTimeout(() => boxes.current[0]?.focus(), 30);
    }
  }

  const type = (i: number, v: string) => {
    const letters = v.toUpperCase().split("").filter((c) => ALPHABET.test(c));
    if (!letters.length) return;
    const nextChars = [...chars];
    let j = i;
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
        <div className={`code-boxes ${state}`} onPaste={(e) => (e.preventDefault(), type(0, e.clipboardData.getData("text")))}>
          {chars.map((c, i) => (
            <input
              key={i}
              ref={(el) => {
                boxes.current[i] = el;
              }}
              value={c}
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="one-time-code"
              aria-label={`Code character ${i + 1}`}
              maxLength={4}
              disabled={state === "joining"}
              onChange={(e) => type(i, e.target.value)}
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
        <div className="connect-status" role="status">
          {state === "joining" ? "Connecting…" : state === "error" ? error : "Letters and numbers only; capitals don't matter."}
        </div>
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
