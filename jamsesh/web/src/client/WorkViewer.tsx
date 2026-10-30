// A full-size look at one piece of work, on your own screen. The arrows step through its group;
// putting it on the big screen is a second, deliberate button.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ago, type Artifact, type HubState } from "../shared/hub";
import { ArtImage, ScaledFrame } from "../shared/ui";
import { CloseIcon } from "./mobile";
import { keyAction, step } from "./viewerNav";

const Arrow = ({ dir }: { dir: "prev" | "next" }) => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={dir === "prev" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
  </svg>
);

export function WorkViewer({ items, index, state, name, onIndex, onClose, onShow }: { items: Artifact[]; index: number; state: HubState; name: string; onIndex: (i: number) => void; onClose: () => void; onShow: (items: Artifact[]) => void }) {
  const art = items[index];
  const [zoom, setZoom] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const swipe = useRef<number | null>(null);
  const last = items.length - 1;
  // Keys are read before the screen behind (its shortcuts) hears them.
  useEffect(() => {
    const was = document.activeElement as HTMLElement | null;
    root.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const act = keyAction(e);
      if (!act) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (act === "close") onClose();
      else if (act === "zoom") setZoom((z) => !z);
      else onIndex(step(index, items.length, act === "next" ? 1 : -1));
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      was?.focus?.();
    };
  }, [index, items.length, onIndex, onClose]);
  useEffect(() => {
    setZoom(false);
  }, [art?.id]);
  // The next picture is ready before the arrow is pressed.
  useEffect(() => {
    for (const a of [items[index + 1], items[index - 1]]) if (a?.image) new Image().src = a.image;
  }, [index, items]);
  if (!art) return null;
  const dev = state.devservers.find((d) => d.url === art.url);
  const live = art.kind === "devserver" && !!art.url && dev?.up !== false;
  return createPortal(
    <div
      ref={root}
      className="wv"
      role="dialog"
      aria-modal="true"
      aria-label={art.title}
      tabIndex={-1}
      onPointerDown={(e) => (swipe.current = e.pointerType === "touch" ? e.clientX : null)}
      onPointerUp={(e) => {
        if (swipe.current === null) return;
        const dx = e.clientX - swipe.current;
        swipe.current = null;
        if (Math.abs(dx) > 60) onIndex(step(index, items.length, dx < 0 ? 1 : -1));
      }}
    >
      <div className="wv-top">
        <button className="wv-close" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">
          <CloseIcon />
        </button>
        <div className="wv-title">
          <strong>{art.title}</strong>
          <span>
            {[art.variant && `Variant ${art.variant}`, art.agentName || "Canvas", ago(art.updatedAt)].filter(Boolean).join(" · ")}
          </span>
        </div>
        {items.length > 1 && (
          <span className="wv-count mono" aria-live="polite">
            {index + 1} of {items.length}
          </span>
        )}
        <div className="wv-actions">
          {items.length > 1 && (
            <button className="btn small" onClick={() => onShow(items.slice(0, 6))}>
              All {Math.min(items.length, 6)} side by side
            </button>
          )}
          <button className="btn primary small wv-show" onClick={() => onShow([art])} title={`The room sees: ${name} put this up`}>
            Show on big screen
            <small>as {name}</small>
          </button>
        </div>
      </div>
      <div className="wv-body">
        <button className="wv-step" onClick={() => onIndex(step(index, items.length, -1))} disabled={index === 0} aria-label="Previous (Left arrow)">
          <Arrow dir="prev" />
        </button>
        <div className={`wv-media ${zoom ? "zoom" : ""} ${live ? "live" : ""}`}>
          {live ? (
            <ScaledFrame src={art.url!} title={art.title} width={art.platform === "mobile" ? 390 : 1440} height={art.platform === "mobile" ? 844 : 900} fill={art.platform !== "mobile"} bare />
          ) : art.image ? (
            <ArtImage art={art} full key={art.id} onClick={() => setZoom((z) => !z)} />
          ) : (
            <div className="empty-note">{art.kind === "devserver" ? dev?.problem ?? "This build isn't answering." : art.note || art.title}</div>
          )}
        </div>
        <button className="wv-step" onClick={() => onIndex(step(index, items.length, 1))} disabled={index === last} aria-label="Next (Right arrow)">
          <Arrow dir="next" />
        </button>
      </div>
      {items.length > 1 && (
        <div className="wv-strip" role="tablist" aria-label="In this group">
          {items.map((a, i) => (
            <button key={a.id} role="tab" aria-selected={i === index} className={i === index ? "on" : ""} onClick={() => onIndex(i)} title={a.title}>
              {a.image ? <img src={a.image} alt="" /> : <span>{a.variant || a.kind}</span>}
              {a.variant && <b>{a.variant}</b>}
            </button>
          ))}
        </div>
      )}
      <div className="wv-hint">Left and right arrows to step, Space for actual size, Esc to close</div>
    </div>,
    document.body,
  );
}
