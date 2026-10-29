// Draws the rainbow trail (6.2) on a canvas laid over the page. The loop runs only while something
// is fading or the pointer was moving a moment ago, so an idle recording costs nothing.
import { useEffect, useRef } from "react";
import { CALM, FULL, Trail } from "./trailmodel";

export type TrailFeed = { push: ((x: number, y: number, scale?: number) => void) | null };

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * `feed.push(x, y, scale?)` takes pointer positions in the canvas's own pixels (the viewport when `fixed`,
 * else the box it is placed in); `scale` is how much bigger than usual to draw (a dart on a big screen). `head` also draws a ring where the pointer is and, if it rests,
 * fills it: that rest is what becomes a note's pin.
 */
export function RainbowTrail({ feed, fixed = true, head = true }: { feed: { current: TrailFeed }; fixed?: boolean; head?: boolean }) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = cv.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const reduced = reducedMotion();
    const trail = new Trail(reduced ? CALM : FULL);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let w = 0;
    let h = 0;
    const size = () => {
      w = fixed ? innerWidth : c.clientWidth;
      h = fixed ? innerHeight : c.clientHeight;
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    const ro = fixed || typeof ResizeObserver === "undefined" ? null : new ResizeObserver(size);
    ro?.observe(c);
    if (fixed) addEventListener("resize", size);

    // On a big screen the trail is drawn as large as the dart, so it reads from across the room.
    let sc = 1;
    const scale = () => (fixed ? 1 : sc);
    let raf = 0;
    let anchor = { x: -99, y: -99, at: 0 };
    let hue = 0;
    const draw = () => {
      raf = 0;
      const now = performance.now();
      ctx.clearRect(0, 0, w, h);
      ctx.lineCap = "butt";
      ctx.lineJoin = "round";
      const pieces = trail.pieces(now);
      // A soft wide pass first, then the bright core: a glow without a blur filter.
      for (const pass of [0, 1]) {
        for (const q of pieces) {
          ctx.globalAlpha = pass ? q.alpha : q.alpha * 0.22;
          ctx.lineWidth = (pass ? q.width : q.width * 2.8) * scale();
          ctx.strokeStyle = `hsl(${q.hue} ${reduced ? 55 : 88}% ${pass ? 66 : 62}%)`;
          ctx.beginPath();
          ctx.moveTo(q.x0, q.y0);
          ctx.quadraticCurveTo(q.cx, q.cy, q.x1, q.y1);
          ctx.stroke();
        }
      }
      const last = trail.pts[trail.pts.length - 1];
      const recent = last && now - last.at < 4000;
      if (head && recent) {
        const held = now - anchor.at;
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = `hsl(${hue} 88% 68%)`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(last.x, last.y, 10, 0, Math.PI * 2);
        ctx.stroke();
        if (held > 300) {
          // The rest has registered as a hold: draw it filling up.
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(last.x, last.y, 17, -Math.PI / 2, -Math.PI / 2 + Math.min(1, (held - 300) / 1200) * Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      if (trail.live(now) || recent) raf = requestAnimationFrame(draw);
      else ctx.clearRect(0, 0, w, h);
    };
    feed.current.push = (x, y, s) => {
      if (s && s > 0) sc = s;
      const at = performance.now();
      trail.push(x, y, at);
      const last = trail.pts[trail.pts.length - 1];
      if (last) hue = trail.style.hueFrom;
      if (Math.hypot(x - anchor.x, y - anchor.y) > 6) anchor = { x, y, at };
      if (!raf) raf = requestAnimationFrame(draw);
    };
    return () => {
      feed.current.push = null;
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      if (fixed) removeEventListener("resize", size);
    };
  }, [feed, fixed, head]);
  return <canvas ref={cv} className={fixed ? "rec-trail" : "rec-trail inbox"} aria-hidden="true" />;
}
