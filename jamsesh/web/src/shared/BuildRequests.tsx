// An agent asking to build on the host, on the big screen and in everyone's window. People answer
// out loud ("approve", "deny"), or with these buttons from any window.
import { useState } from "react";
import { api, pref, useHub, type BuildRequest } from "./hub";

export function BuildRequests({ big }: { big?: boolean }) {
  const { state } = useHub();
  const waiting = (state?.buildRequests ?? []).filter((r) => r.status === "pending");
  if (!waiting.length) return null;
  return (
    <div className={`build-requests ${big ? "big" : ""}`} role="region" aria-label="Host build requests">
      {waiting.map((r) => (
        <Card key={r.id} r={r} />
      ))}
    </div>
  );
}

function Card({ r }: { r: BuildRequest }) {
  const [busy, setBusy] = useState(false);
  const decide = async (approve: boolean) => {
    setBusy(true);
    await api(`/build-requests/${r.id}`, { approve, personId: pref("personId") }).catch(() => {});
    setBusy(false);
  };
  const repo = r.repo.replace(/\.git$/, "").split(/[/:]/).pop();
  return (
    <div className="build-request">
      <div className="build-request-head">
        <span className="build-request-dot" />
        <span>
          <b>{r.agentName}</b> wants to build <b>{repo}</b>
          {r.branch ? <span className="build-request-branch"> · {r.branch}</span> : null} on the host
        </span>
      </div>
      <code className="build-request-cmd">{r.command}</code>
      <div className="build-request-foot">
        <span className="build-request-say">
          Say <b>“approve”</b> or <b>“deny”</b>
        </span>
        <button className="btn small" disabled={busy} onClick={() => decide(false)}>
          Deny
        </button>
        <button className="btn small primary" disabled={busy} onClick={() => decide(true)}>
          Approve
        </button>
      </div>
    </div>
  );
}
