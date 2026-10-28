// Phone layout plumbing: which layout to use, the visual-viewport variables (so the keyboard never
// covers the bottom controls), and the small icons the phone controls use.
import { useEffect, useState, type ReactNode } from "react";

export type Layout = "desktop" | "phone" | "landscape";

const Q_LANDSCAPE = "(orientation: landscape) and (max-height: 520px) and (pointer: coarse)";
// Phones, and touch tablets held upright: an editable canvas beside a 380px panel doesn't fit either.
const Q_PORTRAIT = "(max-width: 720px), (pointer: coarse) and (orientation: portrait) and (max-width: 1100px)";

function read(): Layout {
  if (typeof matchMedia === "undefined") return "desktop";
  if (matchMedia(Q_LANDSCAPE).matches) return "landscape";
  if (matchMedia(Q_PORTRAIT).matches) return "phone";
  return "desktop";
}

export function useLayout(): Layout {
  const [layout, setLayout] = useState<Layout>(read);
  useEffect(() => {
    const qs = [matchMedia(Q_LANDSCAPE), matchMedia(Q_PORTRAIT)];
    const on = () => setLayout(read());
    qs.forEach((q) => q.addEventListener("change", on));
    on();
    return () => qs.forEach((q) => q.removeEventListener("change", on));
  }, []);
  return layout;
}

/**
 * Publishes `--vvh` / `--vvt` (the visible area, which shrinks when the iOS keyboard opens),
 * `--kb` (keyboard height), `--dock-h` (the bottom controls) and `data-layout` / `data-kbd` on <html>.
 */
export function usePhoneChrome(layout: Layout, dock: HTMLElement | null) {
  useEffect(() => {
    const root = document.documentElement;
    if (layout === "desktop") return;
    root.dataset.layout = layout;
    const vv = window.visualViewport;
    const set = () => {
      if (vv && vv.scale > 1.02) return; // pinch-zoomed: leave the frame where it is
      const h = vv ? vv.height : innerHeight;
      const t = vv ? vv.offsetTop : 0;
      root.style.setProperty("--vvh", `${Math.round(h)}px`);
      root.style.setProperty("--vvt", `${Math.round(t)}px`);
      root.style.setProperty("--kb", `${Math.max(0, Math.round(innerHeight - h - t))}px`);
    };
    set();
    vv?.addEventListener("resize", set);
    vv?.addEventListener("scroll", set);
    addEventListener("resize", set);
    addEventListener("orientationchange", set);
    // Which kind of field has the keyboard: the dock's own, or something else (a pin note, a sheet).
    const field = (e: Event) => {
      const el = (e.type === "focusin" ? e.target : null) as HTMLElement | null;
      if (el && el.matches?.("input:not([type=file]):not([type=checkbox]), textarea, select")) root.dataset.kbd = el.closest(".m-dock") ? "dock" : "other";
      else setTimeout(() => !document.activeElement?.matches?.("input, textarea") && delete root.dataset.kbd, 60);
    };
    addEventListener("focusin", field);
    addEventListener("focusout", field);
    return () => {
      vv?.removeEventListener("resize", set);
      vv?.removeEventListener("scroll", set);
      removeEventListener("resize", set);
      removeEventListener("orientationchange", set);
      removeEventListener("focusin", field);
      removeEventListener("focusout", field);
      delete root.dataset.layout;
      delete root.dataset.kbd;
      for (const v of ["--vvh", "--vvt", "--kb", "--dock-h"]) root.style.removeProperty(v);
    };
  }, [layout]);

  useEffect(() => {
    if (!dock || layout !== "phone") {
      document.documentElement.style.removeProperty("--dock-h");
      return;
    }
    const m = () => document.documentElement.style.setProperty("--dock-h", `${Math.round(dock.getBoundingClientRect().height)}px`);
    m();
    const ro = new ResizeObserver(m);
    ro.observe(dock);
    return () => ro.disconnect();
  }, [dock, layout]);
}

function I({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const SendIcon = () => (
  <I>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </I>
);
export const RoomIcon = () => (
  <I>
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
  </I>
);
export const CloseIcon = () => (
  <I>
    <path d="M6 6l12 12M18 6 6 18" />
  </I>
);
