import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { QR } from "../shared/ui";
import "./setup.css";

type Router = { state: "idle" | "working" | "done"; method: "nat-pmp" | "upnp" | "none"; externalPort: number; message: string; cgnat?: boolean; error?: string; externalIp?: string };
export type NetStatus = {
  enabled: boolean;
  configured: boolean;
  domain?: string;
  publicIp?: string;
  lanIp: string;
  dns: "unknown" | "ok" | "error";
  dnsError?: string;
  cert: { state: "none" | "issuing" | "ok" | "error"; notAfter?: number; error?: string; step?: string; staging?: boolean };
  router: Router;
  reachable: "unknown" | "yes" | "no";
  reachDetail?: string;
  externalPort: number;
  internalPort: number;
  publicUrl?: string;
  checkUrl?: string;
};

type Tone = "ok" | "busy" | "warn" | "idle";
const PILL: Record<Tone, string> = { ok: "built", busy: "mockup", warn: "warn", idle: "neutral" };

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge ${PILL[tone]} ${tone === "busy" ? "live" : ""}`}>{children}</span>;
}

async function call(path: string, body?: unknown): Promise<{ ok: boolean; data: any }> {
  try {
    const res = await fetch(`/api/net/${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, data: { error: "Couldn't reach the host. Is it still running?" } };
  }
}

function useNetStatus() {
  const [status, setStatus] = useState<NetStatus | null>(null);
  const refresh = useCallback(async () => {
    const r = await call("status");
    if (r.ok) setStatus(r.data);
    return r.ok ? (r.data as NetStatus) : null;
  }, []);
  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setTimeout>;
    const loop = async () => {
      const s = await refresh();
      if (live) t = setTimeout(loop, s?.cert.state === "issuing" || s?.router.state === "working" ? 1200 : 3000);
    };
    loop();
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [refresh]);
  return { status, setStatus, refresh };
}

function stepIndex(s: NetStatus | null): number {
  if (!s || !s.configured || !s.enabled) return 0;
  if (s.cert.state !== "ok") return 1;
  if (s.router.state !== "done" || s.router.method === "none") return 2;
  return s.reachable === "yes" ? 4 : 3;
}

function Card({ n, title, tone, pill, open, onToggle, children }: { n: number; title: string; tone: Tone; pill: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className={`setup-card ${open ? "open" : ""}`}>
      <button className="setup-card-head" onClick={onToggle} aria-expanded={open}>
        <span className={`setup-num ${tone}`}>{tone === "ok" ? "✓" : n}</span>
        <span className="setup-title">{title}</span>
        <Pill tone={tone}>{pill}</Pill>
      </button>
      {open && <div className="setup-card-body">{children}</div>}
    </section>
  );
}

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn small"
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function SetupView({ onSkip, previewStatus }: { onSkip?: () => void; previewStatus?: NetStatus }) {
  const live = useNetStatus();
  const status = previewStatus ?? live.status;
  const { setStatus, refresh } = live;
  const derived = stepIndex(status);
  const [picked, setPicked] = useState<number | null>(null);
  const lastDerived = useRef(derived);
  useEffect(() => {
    if (derived !== lastDerived.current) {
      lastDerived.current = derived;
      setPicked(null); // follow progress again
    }
  }, [derived]);
  const open = picked ?? (derived === 4 ? -1 : derived);
  const toggle = (i: number) => setPicked(open === i ? -1 : i);

  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (status?.domain && !name) setName(status.domain.replace(/\.duckdns\.org$/, ""));
  }, [status?.domain]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true);
    setError(null);
    const r = await call("config", { domain: name, token: token || undefined });
    setBusy(false);
    if (!r.ok) return setError(r.data.error ?? "That didn't work.");
    setToken("");
    setStatus(r.data);
    setPicked(null);
  };
  const act = async (path: string) => {
    setBusy(true);
    const r = await call(path, {});
    setBusy(false);
    if (r.ok) setStatus(r.data);
    else await refresh();
  };
  // In the Mac app the wizard has its own window (?app), so there's nowhere to go back to.
  const [closed, setClosed] = useState(false);
  const inApp = new URLSearchParams(location.search).has("app");
  const skip = () => (onSkip ? onSkip() : inApp ? setClosed(true) : (location.href = "/host"));

  const s = status;
  const cert = s?.cert;
  const router = s?.router;
  const s1: [Tone, string] = !s?.configured ? ["idle", "To do"] : s.dns === "error" ? ["warn", "Check name"] : ["ok", "Named"];
  const s2: [Tone, string] = !s?.configured ? ["idle", "Waiting"] : cert?.state === "ok" ? ["ok", "Secured"] : cert?.state === "issuing" ? ["busy", "Working"] : cert?.state === "error" ? ["warn", "Needs a retry"] : ["idle", "Waiting"];
  const s3: [Tone, string] =
    cert?.state !== "ok" ? ["idle", "Waiting"] : router?.state === "working" ? ["busy", "Asking router"] : router?.state === "done" && router.method !== "none" ? ["ok", "Open"] : router?.cgnat ? ["warn", "Blocked"] : router?.state === "done" ? ["warn", "One manual step"] : ["idle", "Waiting"];
  const s4: [Tone, string] = s?.reachable === "yes" ? ["ok", "Reachable"] : s?.reachable === "no" ? ["warn", "Not yet"] : router?.state === "done" && router.method !== "none" ? ["idle", "Ready to check"] : ["idle", "Waiting"];

  if (closed)
    return (
      <div className="setup">
        <div className="setup-inner">
          <header className="setup-hero">
            <p className="setup-eyebrow">Host setup</p>
            <h1>Room only, for now</h1>
            <p>Close this window. Everyone on this network can join. Set up remote access any time from JamSesh's menu bar menu.</p>
          </header>
        </div>
      </div>
    );

  return (
    <div className="setup">
      <div className="setup-inner">
        <header className="setup-hero">
          <p className="setup-eyebrow">Host setup</p>
          <h1>Open your host to the internet</h1>
          <p className="setup-lede">Four short steps give this machine a private address like <span className="mono">yourname.duckdns.org</span> with a real certificate, reachable from anywhere through one port.</p>
        </header>

        {derived === 4 && s?.publicUrl && (
          <section className="setup-done">
            <Pill tone="ok">You're live</Pill>
            <h2>Anyone can join at</h2>
            <div className="setup-address">
              <span className="mono">{s.publicUrl}</span>
              <Copy text={s.publicUrl} />
              <a className="btn small" href={s.publicUrl} target="_blank" rel="noreferrer">
                Open
              </a>
            </div>
            <button className="btn primary" onClick={skip}>
              Go to the host view
            </button>
          </section>
        )}

        <Card n={1} title="Name your host" tone={s1[0]} pill={s1[1]} open={open === 0} onToggle={() => toggle(0)}>
          <ol className="setup-steps">
            <li>
              Sign in at <strong>duckdns.org</strong> (it's free) and add a name, like <span className="mono">cheys-jam</span>.
            </li>
            <li>Copy the token shown at the top of that page.</li>
            <li>Paste both here.</li>
          </ol>
          <a className="btn" href="https://www.duckdns.org" target="_blank" rel="noreferrer">
            Open duckdns.org ↗
          </a>
          <div className="setup-fields">
            <label className="field">
              <span>Name</span>
              <div className="setup-suffix">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="cheys-jam" spellCheck={false} autoCapitalize="off" />
                <em className="mono">.duckdns.org</em>
              </div>
            </label>
            <label className="field">
              <span>Token</span>
              <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={s?.configured ? "Saved. Paste a new one to change it." : "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"} spellCheck={false} autoComplete="off" />
            </label>
          </div>
          {error && <p className="setup-error">{error}</p>}
          {s?.dns === "error" && <p className="setup-error">{s.dnsError}</p>}
          <div className="setup-actions">
            <button className="btn primary" disabled={busy || !name.trim() || (!token.trim() && !s?.configured)} onClick={save}>
              {busy ? "Checking…" : s?.configured ? "Update" : "Save and continue"}
            </button>
            <button className="btn ghost" onClick={skip}>
              Skip, room only
            </button>
          </div>
        </Card>

        <Card n={2} title="Secure it" tone={s2[0]} pill={s2[1]} open={open === 1} onToggle={() => toggle(1)}>
          {cert?.state === "issuing" && (
            <div className="setup-progress">
              <span className="setup-spin" />
              <div>
                <strong>{cert.step ?? "Starting"}</strong>
                <p>Let's Encrypt is checking that the name is yours. This takes one to three minutes the first time.</p>
              </div>
            </div>
          )}
          {cert?.state === "ok" && (
            <p className="setup-note ok">
              Certificate is valid{cert.notAfter ? ` until ${new Date(cert.notAfter).toLocaleDateString(undefined, { dateStyle: "long" })}` : ""}. It renews itself.
              {cert.staging ? " (Test certificate: browsers will warn.)" : ""}
            </p>
          )}
          {cert?.state === "error" && (
            <>
              <p className="setup-error">{cert.error}</p>
              <div className="setup-actions">
                <button className="btn primary" disabled={busy} onClick={() => act("issue-cert")}>
                  Try again
                </button>
              </div>
            </>
          )}
          {(!cert || cert.state === "none") && <p className="setup-note">Waiting for step 1. Once your name is saved, the certificate starts on its own.</p>}
          <div className="setup-actions">
            <button className="btn ghost" onClick={skip}>
              Skip, room only
            </button>
          </div>
        </Card>

        <Card n={3} title="Open it to the internet" tone={s3[0]} pill={s3[1]} open={open === 2} onToggle={() => toggle(2)}>
          {router?.state === "working" && (
            <div className="setup-progress">
              <span className="setup-spin" />
              <div>
                <strong>Asking your router</strong>
                <p>Most routers open the port for you in a couple of seconds.</p>
              </div>
            </div>
          )}
          {router?.state === "done" && router.method !== "none" && (
            <p className="setup-note ok">
              {router.message} Traffic on port <span className="mono">{router.externalPort}</span> now reaches this machine.
            </p>
          )}
          {router?.state === "done" && router.method === "none" && router.cgnat && (
            <div className="setup-callout warn">
              <strong>This network can't take inbound connections</strong>
              <p>{router.message}</p>
              <ul>
                <li>
                  <strong>Tailscale Funnel</strong> gives the host a public https address without touching the router.
                </li>
                <li>
                  <strong>Cloudflare Tunnel</strong> does the same through a free Cloudflare account.
                </li>
              </ul>
            </div>
          )}
          {router?.state === "done" && router.method === "none" && !router.cgnat && (
            <div className="setup-callout">
              <strong>One manual step in your router</strong>
              <p>Your router doesn't allow automatic port forwarding. In its settings, add this rule:</p>
              <dl className="setup-rule">
                <div>
                  <dt>Protocol</dt>
                  <dd className="mono">TCP</dd>
                </div>
                <div>
                  <dt>External port</dt>
                  <dd className="mono">{router.externalPort}</dd>
                </div>
                <div>
                  <dt>Send to</dt>
                  <dd className="mono">{s?.lanIp}</dd>
                </div>
                <div>
                  <dt>Internal port</dt>
                  <dd className="mono">{s?.internalPort}</dd>
                </div>
              </dl>
            </div>
          )}
          {(!router || router.state === "idle") && <p className="setup-note">This starts after the certificate is ready.</p>}
          <div className="setup-actions">
            {router?.state === "done" && (
              <button className="btn" disabled={busy} onClick={() => act("retry-router")}>
                {router.cgnat ? "Check again" : router.method === "none" ? "I've done it, try again" : "Ask again"}
              </button>
            )}
            <button className="btn ghost" onClick={skip}>
              Skip, room only
            </button>
          </div>
        </Card>

        <Card n={4} title="Check" tone={s4[0]} pill={s4[1]} open={open === 3 || open === 4} onToggle={() => toggle(3)}>
          <div className="setup-check">
            <div className="setup-check-main">
              <p>
                Press check and the host tries its own public address, then asks a few servers around the world.
              </p>
              {s?.reachable !== "unknown" && <p className={`setup-note ${s?.reachable === "yes" ? "ok" : ""}`}>{s?.reachDetail}</p>}
              {s?.reachable === "unknown" && s?.reachDetail && <p className="setup-note">{s.reachDetail}</p>}
              <div className="setup-actions">
                <button className="btn primary" disabled={busy || !s?.configured} onClick={() => act("check")}>
                  {busy ? "Checking…" : "Run the check"}
                </button>
              </div>
            </div>
            {s?.checkUrl && (
              <figure className="setup-qr">
                <QR text={s.checkUrl} size={148} />
                <figcaption>
                  Scan with a phone on <strong>cellular</strong> (Wi-Fi off). If it says <span className="mono">ok</span>, you're reachable from anywhere.
                </figcaption>
              </figure>
            )}
          </div>
        </Card>

        {derived !== 4 && (
          <footer className="setup-foot">
            <span>Room-only sessions keep working on your local network at any time.</span>
          </footer>
        )}
      </div>
    </div>
  );
}
