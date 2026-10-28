import { expect, test } from "bun:test";
import { cleanTranscript } from "../src/audio/transcribe";

// Both came from a host's room mic this morning, at -47 dB, after the mic's noise floor collapsed.
test("names alone and video outros are whisper's inventions", () => {
  const names = ["Chey", "Pat", "Chey's Claude"];
  expect(cleanTranscript("Chey, Pat.", 2.1, 0, names)).toBe("");
  expect(cleanTranscript("Pat", 1.2, 30, names)).toBe("");
  expect(cleanTranscript("I'm going to go to the next video.", 4, 40, names)).toBe("");
  expect(cleanTranscript("Thanks for watching!", 5, 40, names)).toBe("");
});

test("real lines that mention names survive", () => {
  const names = ["Chey", "Pat"];
  expect(cleanTranscript("Pat, can you bring up the nav?", 2.5, 20, names)).toBe("Pat, can you bring up the nav?");
  expect(cleanTranscript("That was Chey", 1.5, 20, names)).toBe("That was Chey");
  expect(cleanTranscript("Let's go with B", 1.5, 20, names)).toBe("Let's go with B");
});
