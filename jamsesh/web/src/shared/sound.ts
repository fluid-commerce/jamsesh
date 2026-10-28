// A soft two-note chime, synthesized (no audio files): "heard you".
let ctx: AudioContext | null = null;

export function playChime() {
  try {
    ctx ??= new AudioContext();
    const t = ctx.currentTime + 0.01;
    for (const [i, f] of [660, 990].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      const start = t + i * 0.09;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.09, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    }
  } catch {
    // No audio output available; the toast still shows.
  }
}

/** Fades an element's audio out quickly (someone started talking over it). */
export function fadeOut(el: HTMLAudioElement, ms = 250) {
  const start = el.volume;
  const t0 = performance.now();
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    el.volume = start * (1 - k);
    if (k < 1) requestAnimationFrame(step);
    else el.pause();
  };
  requestAnimationFrame(step);
}
