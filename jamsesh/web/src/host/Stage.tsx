import { useEffect, useMemo, useRef, type ReactElement, type ReactNode } from "react";
import { api, ago, type Artifact, type HubState, type Share, type Tile } from "../shared/hub";
import { AgentRow, ArtifactTile, Avatar, CanvasFrame, QR, RoomFeed, ScaledFrame, colorFor, useNow } from "../shared/ui";
import { CodeRing, JoinCard, primaryAddress, useJoinCode } from "./JoinCard";

const BOARD_MAX = 5;

export function Stage({ state, interactive }: { state: HubState; interactive?: boolean }) {
  const stage = state.stage;
  const byId = useMemo(() => new Map(state.artifacts.map((a) => [a.id, a])), [state.artifacts]);
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter(Boolean) as Artifact[];
  const spotlight = (a: Artifact) => interactive && api("/stage", { mode: "spotlight", items: [a.id], title: a.title, by: "Someone in the room" });

  let body: ReactElement;
  switch (stage.mode) {
    case "welcome":
      body = state.artifacts.length ? <Board state={state} onPick={spotlight} /> : <Welcome state={state} />;
      break;
    case "join":
      body = <JoinStage state={state} />;
      break;
    case "spotlight":
      body = <Columns title={stage.title} caption={stage.caption} items={pick(stage.items)} state={state} big />;
      break;
    case "compare":
      body = <Columns title={stage.title} caption={stage.caption} items={pick(stage.items)} state={state} lettered />;
      break;
    case "parity":
      body = <Parity state={state} pick={pick} />;
      break;
    case "agents":
      body = <Agents state={state} />;
      break;
    case "canvas":
      body = (
        <div className="tile" style={{ height: "100%", animation: "none" }}>
          <CanvasFrame kind="view" name="Big screen" title="Live canvas" />
        </div>
      );
      break;
    case "custom":
      body = <Custom state={state} />;
      break;
    case "layout":
      body = <LayoutView state={state} />;
      break;
    default:
      body = <Board state={state} onPick={spotlight} />;
  }
  return (
    <div key={`${stage.mode}-${stage.since}`} style={{ height: "100%", minHeight: 0, animation: "fadein .45s ease both", display: "flex", flexDirection: "column" }}>
      {body}
    </div>
  );
}

function Board({ state, onPick }: { state: HubState; onPick: (a: Artifact) => void }) {
  const now = useNow(4000);
  const items = state.artifacts.slice(0, BOARD_MAX);
  const n = items.length;
  if (!n) return <Welcome state={state} />;
  const layouts: Record<number, { cols: string; rows: string; areas: string[] }> = {
    1: { cols: "1fr", rows: "1fr", areas: ["1 / 1 / 2 / 2"] },
    2: { cols: "1fr 1fr", rows: "1fr", areas: ["1 / 1 / 2 / 2", "1 / 2 / 2 / 3"] },
    3: { cols: "2fr 1fr", rows: "1fr 1fr", areas: ["1 / 1 / 3 / 2", "1 / 2 / 2 / 3", "2 / 2 / 3 / 3"] },
    4: { cols: "2fr 1fr 1fr", rows: "1fr 1fr", areas: ["1 / 1 / 3 / 2", "1 / 2 / 3 / 3", "1 / 3 / 2 / 4", "2 / 3 / 3 / 4"] },
    5: { cols: "2fr 1fr 1fr", rows: "1fr 1fr", areas: ["1 / 1 / 3 / 2", "1 / 2 / 2 / 3", "1 / 3 / 2 / 4", "2 / 2 / 3 / 3", "2 / 3 / 3 / 4"] },
  };
  const hero = items[0];
  const landscape = (hero.width ?? 0) > (hero.height ?? 1) * 1.15 || (hero.kind === "devserver" && hero.platform !== "mobile");
  const wide: Record<number, { cols: string; rows: string; areas: string[] }> = {
    3: { cols: "1fr 1fr", rows: "1.25fr 1fr", areas: ["1 / 1 / 2 / 3", "2 / 1 / 3 / 2", "2 / 2 / 3 / 3"] },
    4: { cols: "1fr 1fr 1fr", rows: "1.25fr 1fr", areas: ["1 / 1 / 2 / 3", "1 / 3 / 2 / 4", "2 / 1 / 3 / 2", "2 / 2 / 3 / 4"] },
    5: { cols: "1fr 1fr 1fr", rows: "1.25fr 1fr", areas: ["1 / 1 / 2 / 3", "1 / 3 / 2 / 4", "2 / 1 / 3 / 2", "2 / 2 / 3 / 3", "2 / 3 / 3 / 4"] },
  };
  const l = landscape && wide[n] ? wide[n] : layouts[n];
  return (
    <div style={{ flex: 1, minHeight: 0, display: "grid", gap: 16, gridTemplateColumns: l.cols, gridTemplateRows: l.rows }}>
      {items.map((a, i) => (
        <div key={a.id} style={{ gridArea: l.areas[i], minHeight: 0, display: "flex" }}>
          <div style={{ flex: 1, display: "flex", minWidth: 0 }}>
            <ArtifactTile art={a} state={state} fresh={now - a.updatedAt < 45_000} big={i === 0 && n >= 3} onClick={() => onPick(a)} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Header({ title, caption, right }: { title: string; caption?: string; right?: ReactElement }) {
  if (!title && !caption) return null;
  return (
    <div className="row between" style={{ alignItems: "flex-end", marginBottom: 18 }}>
      <div>
        {title && <h1 style={{ margin: 0, fontSize: "clamp(26px, 2.4vw, 44px)", fontWeight: 650, letterSpacing: "-0.03em" }}>{title}</h1>}
        {caption && <div style={{ color: "var(--muted)", fontSize: "clamp(15px, 1.1vw, 20px)", marginTop: 6 }}>{caption}</div>}
      </div>
      {right}
    </div>
  );
}

function Columns({ title, caption, items, state, lettered, big }: { title: string; caption: string; items: Artifact[]; state: HubState; lettered?: boolean; big?: boolean }) {
  if (!items.length) return <Board state={state} onPick={() => {}} />;
  return (
    <>
      <Header title={title} caption={caption} />
      <div style={{ flex: 1, minHeight: 0, display: "grid", gap: 18, gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {(lettered ? [...items].sort((a, b) => (a.variant || a.title).localeCompare(b.variant || b.title)) : items).map((a, i) => (
          <ArtifactTile key={a.id} art={a} state={state} big={big || items.length <= 3} variant={lettered ? a.variant || String.fromCharCode(65 + i) : undefined} />
        ))}
      </div>
    </>
  );
}

function Parity({ state, pick }: { state: HubState; pick: (ids: string[]) => Artifact[] }) {
  const stage = state.stage;
  const cols = stage.columns?.length ? stage.columns : [{ label: "", items: stage.items }];
  return (
    <>
      <Header title={stage.title || "Side by side"} caption={stage.caption} />
      <div style={{ flex: 1, minHeight: 0, display: "grid", gap: 22, gridTemplateColumns: cols.map((c) => `${Math.max(1, c.items.length)}fr`).join(" ") }}>
        {cols.map((c) => (
          <div key={c.label} style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
            <div className="label" style={{ fontSize: 13, marginBottom: 10 }}>
              {c.label}
            </div>
            <div style={{ flex: 1, minHeight: 0, display: "grid", gap: 14, gridTemplateColumns: `repeat(${Math.max(1, c.items.length)}, minmax(0, 1fr))` }}>
              {pick(c.items).map((a) => (
                <ArtifactTile key={a.id} art={a} state={state} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Agents({ state }: { state: HubState }) {
  const agents = state.agents.filter((a) => a.status !== "offline");
  const now = useNow(5000);
  if (!agents.length) return <Welcome state={state} />;
  const cols = agents.length <= 2 ? agents.length : agents.length <= 4 ? 2 : 3;
  return (
    <>
      <Header title={state.stage.title || "What everyone is doing"} />
      <div style={{ flex: 1, minHeight: 0, display: "grid", gap: 16, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: "minmax(0, 1fr)" }}>
        {agents.map((a) => {
          const latest = state.artifacts.find((x) => x.agentId === a.id && x.image);
          const updates = state.events.filter((e) => e.authorId === a.id && ["update", "artifact", "canvas", "message"].includes(e.kind)).slice(-3).reverse();
          const color = colorFor(state, { agentId: a.id });
          return (
            <div key={a.id} className="tile" style={{ padding: 0, borderColor: a.status === "working" ? `${color}55` : undefined }}>
              <div style={{ padding: "16px 18px 6px" }}>
                <AgentRow agent={a} state={state} />
              </div>
              {latest ? (
                <div className="media" style={{ padding: 14 }}>
                  <img src={latest.image!} alt={latest.title} />
                </div>
              ) : (
                <div style={{ flex: 1, minHeight: 0 }} />
              )}
              <div style={{ padding: "10px 18px 16px", borderTop: "1px solid var(--line)", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 6 }}>
                {updates.length === 0 && <div className="empty-note" style={{ padding: 0 }}>Nothing posted yet.</div>}
                {updates.map((u) => (
                  <div key={u.id} className="row" style={{ fontSize: 14, gap: 8 }}>
                    <span className="chip mono" style={{ width: 34, color: "var(--dim)", fontSize: 12 }}>{ago(u.ts, now)}</span>
                    <span className="grow" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "var(--muted)" }}>{u.text}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** A layout the brain or a person designed: any mix of tiles, in a bento or an explicit grid. */
function LayoutView({ state }: { state: HubState }) {
  const layout = state.stage.layout;
  const tiles = layout?.tiles ?? [];
  if (!tiles.length) return <Board state={state} onPick={() => {}} />;
  const auto = autoGrid(tiles.length);
  const grid = layout?.grid ?? auto;
  return (
    <>
      <Header title={state.stage.title} caption={state.stage.caption} />
      <div style={{ flex: 1, minHeight: 0, display: "grid", gap: 16, gridTemplateColumns: grid.columns, gridTemplateRows: grid.rows }}>
        {tiles.map((t, i) => (
          <div key={i} style={{ gridArea: grid.areas[i] ?? "auto", minHeight: 0, minWidth: 0, display: "flex" }}>
            <TileView tile={t} state={state} />
          </div>
        ))}
      </div>
    </>
  );
}

function autoGrid(n: number): { columns: string; rows: string; areas: string[] } {
  switch (n) {
    case 1:
      return { columns: "1fr", rows: "1fr", areas: ["1 / 1 / 2 / 2"] };
    case 2:
      return { columns: "1fr 1fr", rows: "1fr", areas: ["1 / 1 / 2 / 2", "1 / 2 / 2 / 3"] };
    case 3:
      return { columns: "1.4fr 1fr", rows: "1fr 1fr", areas: ["1 / 1 / 3 / 2", "1 / 2 / 2 / 3", "2 / 2 / 3 / 3"] };
    case 4:
      return { columns: "1fr 1fr", rows: "1fr 1fr", areas: ["1 / 1 / 2 / 2", "1 / 2 / 2 / 3", "2 / 1 / 3 / 2", "2 / 2 / 3 / 3"] };
    default: {
      const cols = n <= 6 ? 3 : 4;
      const rows = Math.ceil(n / cols);
      return { columns: `repeat(${cols}, 1fr)`, rows: `repeat(${rows}, 1fr)`, areas: Array.from({ length: n }, (_, i) => `${Math.floor(i / cols) + 1} / ${(i % cols) + 1} / ${Math.floor(i / cols) + 2} / ${(i % cols) + 2}`) };
    }
  }
}

/** One tile of any kind, framed the same way, with its annotation target. */
export function TileView({ tile, state, interactive }: { tile: Tile; state: HubState; interactive?: boolean }) {
  switch (tile.kind) {
    case "artifact": {
      const a = state.artifacts.find((x) => x.id === tile.artifactId);
      if (!a) return <TileFrame label={tile.label ?? "Gone"} kind="artifact"><div className="empty-note">That artifact was removed.</div></TileFrame>;
      return (
        <div data-jam-target={JSON.stringify({ kind: a.kind === "devserver" ? "web" : "artifact", ref: a.kind === "devserver" ? a.url : a.id, label: a.title })} style={{ flex: 1, display: "flex", minWidth: 0, position: "relative" }}>
          <ArtifactTile art={a} state={state} />
          <Slot target={{ kind: a.kind === "devserver" ? "web" : "artifact", ref: a.kind === "devserver" ? a.url ?? "" : a.id, label: a.title }} />
        </div>
      );
    }
    case "canvas":
      return (
        <TileFrame label={tile.label ?? (tile.follow ? `Canvas · following ${tile.follow}` : tile.page ? `Canvas · ${tile.page}` : "Live canvas")} kind="canvas" target={{ kind: "canvas", ref: "canvas", label: "Canvas" }}>
          <CanvasFrame kind="view" name="Big screen" title="Live canvas" follow={tile.follow ?? undefined} page={tile.page ?? undefined} />
        </TileFrame>
      );
    case "web": {
      const dev = state.devservers.find((d) => d.url === tile.url);
      const mobile = dev?.platform === "mobile" || /mobile|expo|ios|android/i.test(tile.label ?? "");
      return (
        <TileFrame label={tile.label ?? dev?.name ?? hostOf(tile.url)} kind="web" sub={tile.url} target={{ kind: "web", ref: tile.url, label: tile.label ?? dev?.name ?? hostOf(tile.url) }}>
          <ScaledFrame src={tile.url} title={tile.label ?? tile.url} width={mobile ? 390 : 1440} height={mobile ? 844 : 900} />
        </TileFrame>
      );
    }
    case "screen": {
      const sh = state.shares.find((x) => x.id === tile.shareId);
      return (
        <TileFrame label={tile.label ?? sh?.label ?? "Shared screen"} kind="screen" target={{ kind: "screen", ref: tile.shareId, label: tile.label ?? sh?.label ?? "Shared screen" }}>
          {sh && sh.status === "live" ? <ScreenSlot share={sh} /> : <div className="empty-note">{sh?.status === "requested" ? `Waiting for ${sh.personName} to share…` : "This share ended."}</div>}
        </TileFrame>
      );
    }
    case "agent": {
      const a = state.agents.find((x) => x.id === tile.agentId);
      if (!a) return <TileFrame label="Agent" kind="agent"><div className="empty-note">Agent left.</div></TileFrame>;
      return <AgentCard agent={a} state={state} />;
    }
    case "feed":
      return (
        <TileFrame label={tile.label ?? "The room"} kind="feed">
          <div style={{ position: "absolute", inset: 0, padding: 12, display: "flex", flexDirection: "column" }}>
            <RoomFeed big filter="room" />
          </div>
        </TileFrame>
      );
    case "html":
      return (
        <TileFrame label={tile.label ?? ""} kind="html">
          <iframe srcDoc={`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#0c0d0f;color:#f3f2ef;font-family:system-ui}</style>${tile.html}`} sandbox="allow-scripts" title={tile.label ?? "View"} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }} />
        </TileFrame>
      );
  }
  void interactive;
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function TileFrame({ label, sub, kind, children, target }: { label: string; sub?: string; kind: string; children: ReactNode; target?: { kind: string; ref: string; label: string } }) {
  return (
    <div className="tile" data-jam-target={target ? JSON.stringify(target) : undefined} style={{ animation: "none" }}>
      <div className="media" style={{ padding: 0 }}>
        {children}
        {target && <Slot target={target} />}
      </div>
      <div className="meta">
        <span className="badge neutral">{kind === "web" ? "Browser" : kind === "screen" ? "Live share" : kind === "canvas" ? "Canvas" : kind}</span>
        <span className="title">{label}</span>
        {sub && <span className="chip mono" style={{ color: "var(--dim)", fontSize: 12 }}>{sub}</span>}
      </div>
    </div>
  );
}

/** Annotation pins for a tile (filled in by the annotation layer when it's mounted). */
export const tileSlots: { render: ((target: { kind: string; ref: string; label: string }) => ReactNode) | null; screen: ((share: Share) => ReactNode) | null } = { render: null, screen: null };

function Slot({ target }: { target: { kind: string; ref: string; label: string } }) {
  return <>{tileSlots.render?.(target) ?? null}</>;
}

function ScreenSlot({ share }: { share: Share }) {
  return <>{tileSlots.screen?.(share) ?? <div className="empty-note">Connecting to {share.personName}'s {share.kind}…</div>}</>;
}

function AgentCard({ agent: a, state }: { agent: HubState["agents"][number]; state: HubState }) {
  const now = useNow(5000);
  const latest = state.artifacts.find((x) => x.agentId === a.id && x.image);
  const updates = state.events.filter((e) => e.authorId === a.id && ["update", "artifact", "canvas", "message"].includes(e.kind)).slice(-3).reverse();
  return (
    <div className="tile" style={{ padding: 0 }}>
      <div style={{ padding: "16px 18px 6px" }}>
        <AgentRow agent={a} state={state} />
      </div>
      {latest ? (
        <div className="media" style={{ padding: 14 }}>
          <img src={latest.image!} alt={latest.title} />
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0 }} />
      )}
      <div style={{ padding: "10px 18px 16px", borderTop: "1px solid var(--line)", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 6 }}>
        {updates.map((u) => (
          <div key={u.id} className="row" style={{ fontSize: 14, gap: 8 }}>
            <span className="chip mono" style={{ width: 34, color: "var(--dim)", fontSize: 12 }}>{ago(u.ts, now)}</span>
            <span className="grow" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "var(--muted)" }}>{u.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Custom({ state }: { state: HubState }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const html = state.stage.html ?? "";
  const doc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#0c0d0f;color:#f3f2ef;font-family:system-ui,sans-serif}</style><script>window.JAM={state:${JSON.stringify(slim(state)).replace(/</g, "\\u003c")}};addEventListener("message",e=>{if(e.data&&e.data.jam){window.JAM.state=e.data.jam;dispatchEvent(new CustomEvent("jam",{detail:e.data.jam}))}})</script></head><body>${html}</body></html>`,
    // Rebuild the document only when the view itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [html],
  );
  useEffect(() => {
    ref.current?.contentWindow?.postMessage({ jam: slim(state) }, "*");
  }, [state]);
  return (
    <>
      <Header title={state.stage.title} />
      <iframe ref={ref} srcDoc={doc} sandbox="allow-scripts" title={state.stage.title} style={{ flex: 1, border: 0, borderRadius: 22, background: "var(--panel)" }} />
    </>
  );
}

function slim(state: HubState) {
  const origin = location.origin;
  return {
    agents: state.agents,
    people: state.people,
    workstreams: state.workstreams,
    directives: state.directives.slice(0, 20),
    artifacts: state.artifacts.slice(0, 40).map((a) => ({ ...a, image: a.image ? origin + a.image : null })),
    events: state.events.slice(-60),
  };
}

/** Everything someone needs to get on, readable from the back of the room. */
function JoinStage({ state }: { state: HubState }) {
  const { code, left } = useJoinCode();
  const addr = primaryAddress(code);
  const host = addr.url.replace(/^https?:\/\//, "");
  const c = code?.code ?? "····";
  return (
    <div className="join-stage">
      <div className="join-stage-qr">
        <QR text={`${addr.url}/connect?c=${code?.code ?? ""}`} size={520} />
        <div className="join-stage-scan">Point your phone's camera here</div>
      </div>
      <div className="join-stage-info">
        <div className="label">{state.settings.sessionName}</div>
        <div className="join-stage-code" aria-live="polite">
          <span className="mono">{c}</span>
          <CodeRing left={left} size={56} />
        </div>
        <div className="join-stage-addr mono">{host}</div>
        <ol className="join-stage-steps">
          <li>
            <b>Phone</b>
            <span>Open the Camera, point it at the QR code, and tap the link. You're in.</span>
          </li>
          <li>
            <b>Laptop</b>
            <span>
              Open JamSesh and choose this session, or go to <span className="mono">{host}</span> in a browser and type the code.
            </span>
          </li>
          <li>
            <b>Your agent</b>
            <span>
              With the JamSesh app open, tell Claude Code or Codex <span className="mono">connect to jamsesh</span>. Without it:{" "}
              <span className="mono">
                join jamsesh at {host}, code {c}
              </span>
            </span>
          </li>
        </ol>
        <div className="join-stage-foot">The code changes every 30 seconds. Use the one showing now.</div>
      </div>
    </div>
  );
}

function Welcome({ state }: { state: HubState }) {
  return (
    <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
      <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: 56, alignItems: "center", maxWidth: 1200 }}>
        <div>
          <div className="label" style={{ fontSize: 14, marginBottom: 14 }}>
            {state.settings.sessionName}
          </div>
          <h1 style={{ fontSize: "clamp(40px, 4.6vw, 84px)", lineHeight: 1.02, letterSpacing: "-0.045em", margin: "0 0 26px", fontWeight: 680 }}>
            Talk it through.
            <br />
            <span style={{ color: "var(--dim)" }}>The agents are listening.</span>
          </h1>
          <div style={{ fontSize: 20, color: "var(--muted)", maxWidth: 560, lineHeight: 1.5 }}>
            Scan the code with your phone, or open the address on your laptop and type the code. To bring your agent, tell it the address and the code.
          </div>
          {state.people.length > 0 && (
            <div className="row" style={{ marginTop: 34, gap: 14, flexWrap: "wrap" }}>
              {state.people.map((p) => (
                <span key={p.id} className="row" style={{ gap: 8 }}>
                  <Avatar name={p.name} color={p.color} size={34} photo={p.photo} />
                  <span style={{ fontSize: 17 }}>{p.name}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        <JoinCard large />
      </div>
    </div>
  );
}
