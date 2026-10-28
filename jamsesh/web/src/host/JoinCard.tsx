import { useEffect, useState } from "react";
import { api } from "../shared/hub";
import { QR } from "../shared/ui";

type Code = { code: string; expiresIn: number; period: number; addresses: { label: string; url: string }[] };

/** The live join code: refreshes when it rolls over, with a countdown ring. */
export function useJoinCode() {
  const [code, setCode] = useState<Code | null>(null);
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
  return { code, left };
}

export function primaryAddress(code: Code | null) {
  const list = code?.addresses ?? [];
  return list.find((a) => a.url.startsWith("https")) ?? list[0] ?? { label: "", url: location.origin };
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
  const { code, left } = useJoinCode();
  const addr = primaryAddress(code);
  const host = addr.url.replace(/^https?:\/\//, "");
  const others = (code?.addresses ?? []).filter((a) => a.url !== addr.url);
  return (
    <div className={`join-card ${large ? "large" : ""}`}>
      <QR text={`${addr.url}/connect?c=${code?.code ?? ""}`} size={large ? 240 : 180} />
      <div className="join-address mono">{host}</div>
      <div className="join-code" aria-live="polite">
        <span className="mono">{code?.code ?? "····"}</span>
        <CodeRing left={left} size={large ? 30 : 24} />
      </div>
      <div className="join-hint">
        Scan, or open the address and type the code.
        <br />
        For your agent: <span className="mono">join jamsesh at {host}, code {code?.code ?? "…"}</span>
      </div>
      {others.length > 0 && (
        <div className="join-others">
          {others.map((o) => (
            <span key={o.url}>
              {o.label}: <span className="mono">{o.url.replace(/^https?:\/\//, "")}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
