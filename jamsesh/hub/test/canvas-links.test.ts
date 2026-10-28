// The host reopens its saved canvas through loopback: the saved link names the LAN address, which
// the canvas server doesn't listen on, and a failed rejoin used to publish an empty file instead.
import { expect, test } from "bun:test";
import { Canvas } from "../src/canvas/canvas";

const loopLink = (link: string, port: number) => Canvas.prototype.loopLink.call({ port } as unknown as Canvas, link);

test("a saved LAN link rejoins through loopback on today's port", () => {
  expect(loopLink("figcraft://join?host=192.168.2.18:47900&file=e5a7&token=t", 47900)).toBe("figcraft://join?host=127.0.0.1:47900&file=e5a7&token=t");
  expect(loopLink("figcraft://join?host=10.0.0.7:47900&file=f1&token=t", 47903)).toBe("figcraft://join?host=127.0.0.1:47903&file=f1&token=t");
  expect(loopLink("figcraft://join?host=Deers-Mac-mini.local:47900&file=f1&token=t", 47900)).toContain("host=127.0.0.1:47900&file=f1");
});
