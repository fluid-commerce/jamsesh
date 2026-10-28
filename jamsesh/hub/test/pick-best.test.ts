import { expect, test } from "bun:test";
import { pickBest } from "../src/audio/pipeline";

const seg = (id: string, o: Partial<{ levelDb: number; snr: number; active: number }>) => ({ id, levelDb: -40, snr: 20, active: 0.6, ...o }) as any;

test("an invalid copy with a huge SNR never beats a copy the quality gate accepts", () => {
  // A mic whose noise floor collapsed reads as 70 dB SNR at a level the gate rejects.
  const broken = seg("broken", { levelDb: -70, snr: 70 });
  const good = seg("good", { levelDb: -35, snr: 18 });
  expect(pickBest([broken, good]).id).toBe("good");
  expect(pickBest([good, broken, seg("late", { snr: 25 })]).id).toBe("late");
  // Steady hum: nearly every frame active at low SNR.
  expect(pickBest([seg("hum", { snr: 7, active: 0.95, levelDb: -20 }), good]).id).toBe("good");
  // Nothing eligible: the best of the rejects, so the gate still rejects the group.
  expect(pickBest([broken, seg("quiet", { levelDb: -80, snr: 2 })]).id).toBe("broken");
});
