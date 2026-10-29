// People's canvases rejoin when the host publishes the canvas again, and the host starts the
// canvas server again when it stops (it crashed, or something killed it).
import { expect, test } from "bun:test";
import { Canvas } from "../src/canvas/canvas";

test("each announcement of the canvas is a new generation, so people's canvases fetch their link again", () => {
  const session = {
    canvas: { status: "off", generation: 0 } as any,
    setCanvas(info: any) {
      this.canvas = { ...this.canvas, ...info };
    },
  };
  const announce = (Canvas.prototype as any).announce;
  announce.call({ session }, "figcraft://join?host=10.0.0.2:47900&file=a&token=t", "figcraft://join?host=10.0.0.2:47900&file=a&token=v");
  expect(session.canvas.generation).toBe(1);
  expect(session.canvas.status).toBe("live");
  announce.call({ session }, "figcraft://join?host=10.0.0.2:47900&file=b&token=t", "figcraft://join?host=10.0.0.2:47900&file=b&token=v");
  expect(session.canvas.generation).toBe(2);
});

function fakeCanvas(serverUrl: string) {
  const calls: string[] = [];
  return {
    calls,
    canvas: {
      host: { alive: true, command: async () => ({ status: "live", peers: [] }) },
      polling: false,
      agents: new Map(),
      session: { canvas: { status: "live" } },
      serverUrl,
      revive: async () => void calls.push("revive"),
      resync: async (why: string) => void calls.push(`resync: ${why}`),
    },
  };
}

test("the watchdog starts the canvas server again when it stopped answering", async () => {
  const { canvas, calls } = fakeCanvas("http://127.0.0.1:1");
  await (Canvas.prototype as any).watchdog.call(canvas);
  expect(calls).toEqual(["revive"]);
});

test("a canvas server that answers is left alone", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  try {
    const { canvas, calls } = fakeCanvas(`http://127.0.0.1:${server.port}`);
    await (Canvas.prototype as any).watchdog.call(canvas);
    expect(calls).toEqual([]);
  } finally {
    server.stop(true);
  }
});
