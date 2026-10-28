import { useEffect, useState } from "react";
import { api } from "../shared/hub";
import { QR } from "../shared/ui";
import { bare, joinOptions, type Code, type NetInfo } from "./joinOptions";

export { joinOptions, primaryAddress } from "./joinOptions";

/** The live join code: refreshes when it rolls over, with a countdown ring. */
export function useJoinCode() {
  const [code, setCode] = useState<Code | null>(null);
  const [net, setNet] = useState<NetInfo | null>(null);
  const [left, setLeft] = useState(1);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let tick: ReturnType<typeof setInterval>;
    const load = async () => {
      const c = await api<Code>("/pair/code").catch(() => null);
      if (!c) return void (timer = setTimeout(load, 3000));
      setCode(c);
      const until = Date.now() + c.expiresIn;
      clearInterval(tick);
      tick = setInterval(() => setLeft(Math.max(0, (until - Date.now()) / c.period)), 250);
      timer = setTimeout(load, c.expiresIn + 80);
    };
    load();
    return () => (clearTimeout(timer), clearInterval(tick));
  }, []);
  // Whether the public address is confirmed reachable (only the host machine can ask).
  const hasHttps = !!code?.addresses.some((a) => a.url.startsWith("https"));
  useEffect(() => {
    if (!hasHttps) return setNet(null);
    let stop = false;
    const poll = () => api<NetInfo>("/net/status").then((n) => !stop && setNet(n)).catch(() => {});
    poll();
    const id = setInterval(poll, 20_000);
    return () => ((stop = true), clearInterval(id));
  }, [hasHttps]);
  return { code, left, net };
}

export function CodeRing({ left, size = 22 }: { left: number; size?: number }) {
  const r = size / 2 - 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ transform: "rotate(-90deg)", flex: "none" }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="2.5" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={left < 0.2 ? "var(--directive)" : "var(--built)"} strokeWidth="2.5" strokeDasharray={c} strokeDashoffset={c * (1 - left)} strokeLinecap="round" style={{ transition: "stroke-dashoffset .25s linear" }} />
    </svg>
  );
}

/** QR, address and the big code: everything someone needs to join. */
export function JoinCard({ large }: { large?: boolean }) {
  const { code, left, net } = useJoinCode();
  const { options, unconfirmed } = joinOptions(code, net);
  const lead = options[0];
  const two = options.length > 1;
  const c = code?.code ?? "····";
  return (
    <div className={`join-card ${large ? "large" : ""}`}>
      <div className={`join-qrs ${two ? "two" : ""}`}>
        {options.map((o) => (
          <div key={o.key} className="join-qr">
            <QR text={`${o.url}/connect?c=${c}`} size={two ? (large ? 200 : 150) : large ? 240 : 180} />
            {two && <div className="join-qr-title">{o.title}</div>}
            <div className="join-address mono">{o.host}</div>
          </div>
        ))}
      </div>
      <div className="join-code" aria-live="polite">
        <span className="mono">{c}</span>
        <CodeRing left={left} size={large ? 30 : 24} />
      </div>
      <div className="join-hint">
        Scan, or open the address and type the code.
        <br />
        For your agent: <span className="mono">join jamsesh at {lead.host}, code {c}</span>
      </div>
      {unconfirmed && (
        <div className="join-others">
          Remote address <span className="mono">{bare(unconfirmed.url)}</span> isn't confirmed reachable yet, so it isn't offered.
        </div>
      )}
    </div>
  );
}
