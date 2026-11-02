// A stand-in for `figcraft-cli mcp` in tests: answers each newline-delimited JSON-RPC request on
// stdin at once (an empty tool list, and an empty JSON object as every tool's text).
let buf = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id == null) continue;
    const result = msg.method === "tools/list" ? { tools: [] } : { content: [{ type: "text", text: "{}" }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  }
}

export {};
