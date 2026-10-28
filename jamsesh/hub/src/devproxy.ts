// Dev servers on the host. An agent's dev server runs on its own machine; the hub
// opens a port here that forwards raw TCP to it, so HTTP, WebSockets and hot
// reload work unchanged, and everyone opens it at the host's address.
import type { Socket, TCPSocketListener } from "bun";
import { config } from "./config";
import { newId } from "./store";
import type { Session } from "./session";
import type { DevServer, Platform } from "./types";

interface Pipe {
  peer: Socket<any> | null;
  queue: Uint8Array[];
}

export class DevProxy {
  private listeners = new Map<string, TCPSocketListener<any>>();

  constructor(private session: Session) {}

  restore() {
    for (const d of this.session.devservers()) this.listen(d).catch(() => this.session.store.patch("devservers", d.id, { up: false }));
  }

  async register(opts: { agentId: string; name: string; target: string; platform?: Platform | null }): Promise<DevServer> {
    const target = normalizeTarget(opts.target);
    const existing = this.session.devservers().find((d) => d.agentId === opts.agentId && (d.name === opts.name || d.target === target));
    const used = new Set(this.session.devservers().map((d) => d.hostPort));
    let hostPort = existing?.hostPort ?? config.devPortStart;
    while (!existing && used.has(hostPort)) hostPort++;
    if (existing) this.close(existing.id);
    const d: DevServer = {
      id: existing?.id ?? newId("dev"),
      agentId: opts.agentId,
      name: opts.name,
      target,
      hostPort,
      url: `http://${config.publicHost}:${hostPort}`,
      platform: opts.platform ?? this.session.agent(opts.agentId)?.platform ?? null,
      createdAt: existing?.createdAt ?? Date.now(),
      up: false,
    };
    await this.listen(d);
    const up = await this.check(d);
    this.session.store.put("devservers", { ...d, up });
    const agent = this.session.agent(opts.agentId);
    this.session.upsertArtifact({
      id: this.session.artifacts().find((a) => a.kind === "devserver" && a.url === d.url)?.id,
      kind: "devserver",
      stage: "built",
      title: opts.name,
      url: d.url,
      agentId: opts.agentId,
      platform: d.platform,
      note: up ? `Live at ${d.url}` : `Registered; ${target} isn't answering yet`,
    });
    if (agent) this.session.touchAgent(agent.id, { activity: `Dev server: ${opts.name}` });
    return { ...d, up };
  }

  private async listen(d: DevServer) {
    const [host, portStr] = d.target.split(":");
    const port = Number(portStr);
    const listener = Bun.listen<Pipe>({
      hostname: "0.0.0.0",
      port: d.hostPort,
      socket: {
        open(client) {
          client.data = { peer: null, queue: [] };
          Bun.connect<Pipe>({
            hostname: host,
            port,
            socket: {
              open(upstream) {
                upstream.data = { peer: client, queue: [] };
                client.data.peer = upstream;
                for (const chunk of client.data.queue) upstream.write(chunk);
                client.data.queue = [];
              },
              data(upstream, chunk) {
                upstream.data.peer?.write(chunk);
              },
              close(upstream) {
                upstream.data.peer?.end();
              },
              error(upstream) {
                upstream.data.peer?.end();
              },
            },
          }).catch(() => client.end());
        },
        data(client, chunk) {
          if (client.data.peer) client.data.peer.write(chunk);
          else client.data.queue.push(new Uint8Array(chunk));
        },
        close(client) {
          client.data.peer?.end();
        },
        error(client) {
          client.data.peer?.end();
        },
      },
    });
    this.listeners.set(d.id, listener);
  }

  async check(d: DevServer): Promise<boolean> {
    try {
      const r = await fetch(`http://127.0.0.1:${d.hostPort}/`, { signal: AbortSignal.timeout(3000), redirect: "manual" });
      return r.status > 0;
    } catch {
      return false;
    }
  }

  async refresh() {
    for (const d of this.session.devservers()) {
      const up = await this.check(d);
      if (up !== d.up) this.session.store.patch("devservers", d.id, { up });
    }
  }

  close(id: string) {
    this.listeners.get(id)?.stop(true);
    this.listeners.delete(id);
  }

  remove(id: string) {
    this.close(id);
    this.session.store.remove("devservers", id);
  }

  stop() {
    for (const id of [...this.listeners.keys()]) this.close(id);
  }
}

/** "http://192.168.1.4:5173/" or "192.168.1.4:5173" → "192.168.1.4:5173". */
export function normalizeTarget(t: string) {
  const s = t.trim().replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "");
  if (!/^[\w.-]+:\d+$/.test(s)) throw new Error(`Give the dev server as host:port (got "${t}")`);
  return s.replace(/^localhost:/, "127.0.0.1:");
}
