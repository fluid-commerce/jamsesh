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

test("sound descriptions in asterisks are dropped (seen on the host: *sad music*)", () => {
  expect(cleanTranscript("*sad music*", 3, 40)).toBe("");
  expect(cleanTranscript("Welcome to the show.", 2, 40)).toBe("");
  expect(cleanTranscript("Show the *new* nav", 2, 40)).toBe("Show the *new* nav");
});

test("real sentences that mention outro phrases survive clean audio; the bare outro does not", () => {
  expect(cleanTranscript("Let's look at the next video in the playlist.", 4, 30)).toBe("Let's look at the next video in the playlist.");
  expect(cleanTranscript("Can you put the next video on the big screen?", 4, 30)).toBe("Can you put the next video on the big screen?");
  expect(cleanTranscript("Make the thanks for watching card bigger.", 4, 30)).toBe("Make the thanks for watching card bigger.");
  expect(cleanTranscript("Okay, see you next time.", 3.5, 40)).toBe("");
  expect(cleanTranscript("Don't forget to subscribe", 4, 40)).toBe("");
  // Weak audio still drops the substring form.
  expect(cleanTranscript("Let's look at the next video", 4, 5)).toBe("");
});
