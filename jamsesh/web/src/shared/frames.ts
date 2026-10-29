// Drawing a frame at the size its box needs. The stored render is capped at 1600 px; a TV, or a
// viewer on a big screen, asks the hub for a larger one.
import { useEffect, useState, type RefObject } from "react";
import type { Artifact } from "./hub";

/** The sizes the hub draws a frame at (hub/src/http.ts keeps the same list). */
export const FULL_SIZES = [1600, 2400, 3200, 4096];

/** The size to ask the hub to draw a frame at so it isn't upscaled in a box of `box` css px; null when the stored render is enough. */
export function fullSize(art: Pick<Artifact, "kind" | "width" | "height" | "nodeId">, box: { w: number; h: number }, dpr: number): number | null {
  if (art.kind !== "frame" || !art.nodeId || !art.width || !art.height) return null;
  const fit = Math.min(box.w / art.width, box.h / art.height) * dpr;
  const long = fit * Math.max(art.width, art.height);
  // The hub draws at these sizes only, so a window drag doesn't ask for a new picture every pixel.
  return long > 1600 ? FULL_SIZES.find((n) => n >= long) ?? FULL_SIZES[FULL_SIZES.length - 1] : null;
}

/** The picture to draw for `art` in whatever box `ref`'s parent turns out to be, falling back to the stored render if the hub can't draw it larger. */
export function useArtSrc(art: Artifact, ref: RefObject<HTMLElement | null>, enabled = true): { src: string | null; onError: () => void } {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    const el = enabled ? ref.current?.parentElement : null;
    if (!el) return;
    const read = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, enabled]);
  const size = enabled && box ? fullSize(art, box, window.devicePixelRatio || 1) : null;
  const version = art.image?.match(/([\w.-]+)\.png$/)?.[1] ?? "";
  const url = size ? `/renders/full/${art.id}.png?size=${size}&v=${version}` : null;
  return { src: url && failed !== url ? url : art.image, onError: () => url && setFailed(url) };
}
