import { useEffect } from "react";
import { anyoneDriving } from "./driving";

/** True when a key press is going into a text field, so single-letter shortcuts must stay out of the way. */
export function isTypingTarget(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && !!t.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

/** A plain key (no Cmd, Ctrl or Alt), so Cmd+F and Cmd+2 keep their browser meaning. */
export const plain = (e: KeyboardEvent) => !e.metaKey && !e.ctrlKey && !e.altKey;

/**
 * Clicking into an iframe (the canvas, a dev server) moves keyboard focus there, and the page stops
 * hearing shortcuts such as M. On a screen nobody types into, take focus back when the pointer leaves
 * (unless someone is driving the screen: their typing goes into that frame).
 */
export function useReclaimFocus(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const reclaim = () => {
      if (document.activeElement?.tagName === "IFRAME") (document.activeElement as HTMLElement).blur();
      window.focus();
    };
    const id = setInterval(() => {
      // Focus sits in an iframe and the pointer is not over it: bring it back.
      const f = document.activeElement;
      if (f?.tagName === "IFRAME" && !(f as HTMLElement).matches(":hover") && !anyoneDriving()) reclaim();
    }, 800);
    return () => clearInterval(id);
  }, [enabled]);
}
