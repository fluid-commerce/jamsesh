// A client for one headless `figcraft-cli mcp` process: newline-delimited
// JSON-RPC 2.0 over stdio.
import type { Subprocess } from "bun";

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: McpContent[];
  isError?: boolean;
  structuredContent?: unknown;
}

export class FigcraftMcp {
  private proc: Subprocess<"pipe", "pipe", "pipe">;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  tools: { name: string; description?: string; inputSchema?: any }[] = [];

  constructor(bin: string, args: string[] = ["mcp"], env: Record<string, string> = {}) {
    this.proc = Bun.spawn([bin, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    this.readLoop();
    this.drainStderr();
    this.proc.exited.then(() => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("figcraft-cli exited"));
      this.pending.clear();
    });
  }

  get alive() {
    return !this.closed;
  }

  private async readLoop() {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of this.proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
          else p.resolve(msg.result);
        }
      }
    }
  }

  private async drainStderr() {
    for await (const _ of this.proc.stderr) {
      // figcraft-cli logs to stderr; keep the pipe flowing.
    }
  }

  private send(msg: object) {
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
    this.proc.stdin.flush();
  }

  request(method: string, params?: object, timeoutMs = 60_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("figcraft-cli is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`figcraft ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async init() {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "jamsesh-hub", version: "1.0.0" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const list = await this.request("tools/list", {});
    this.tools = list.tools ?? [];
    return this;
  }

  /** Calls are serialized: the engine handles one at a time. */
  call(name: string, args: object = {}, timeoutMs?: number): Promise<ToolResult> {
    const run = () => this.request("tools/call", { name, arguments: args }, timeoutMs);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Runs an engine command and parses its JSON text result. */
  async command(command: string, params: object = {}): Promise<any> {
    const r = await this.call("run_command", { command, params });
    const text = r.content.find((c) => c.type === "text") as { text: string } | undefined;
    if (r.isError) throw new Error(text?.text ?? `${command} failed`);
    if (!text) return null;
    try {
      return JSON.parse(text.text);
    } catch {
      return text.text;
    }
  }

  async json(name: string, args: object = {}): Promise<any> {
    const r = await this.call(name, args);
    const text = r.content.find((c) => c.type === "text") as { text: string } | undefined;
    if (r.isError) throw new Error(text?.text ?? `${name} failed`);
    if (!text) return null;
    try {
      return JSON.parse(text.text);
    } catch {
      return text.text;
    }
  }

  close() {
    if (!this.closed) this.proc.kill();
  }
}
