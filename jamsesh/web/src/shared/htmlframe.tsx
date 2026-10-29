import { useRef, useState, type CSSProperties, type Ref } from "react";
import { htmlFrame, useSilent } from "./sound";

/**
 * Remembers how many times a frame has loaded. The first load is the document we gave it; any later one means
 * something inside it navigated (a link, a form, a refresh), so `reset` puts the document back.
 */
export function loadGuard(reset: () => void) {
  let loads = 0;
  return () => {
    loads++;
    if (loads > 1) {
      loads = 0;
      reset();
    }
  };
}

/**
 * A page of the room's own HTML in a frame. In a silent room it has no scripts or media (see htmlFrame), its links
 * and forms can't be used at all (the frame is inert: no clicks or keys reach it, so nothing can navigate it, even with
 * target=_self), and if it somehow loads anything else it is put back at once.
 */
export function HtmlFrame({ doc, title, style, frameRef }: { doc: string; title: string; style: CSSProperties; frameRef?: Ref<HTMLIFrameElement> }) {
  const silent = useSilent();
  const [round, setRound] = useState(0);
  const guard = useRef<(() => void) | null>(null);
  const frame = htmlFrame(silent, doc);
  if (silent) guard.current ??= loadGuard(() => setRound((n) => n + 1));
  return <iframe key={round} ref={frameRef} srcDoc={frame.srcDoc} sandbox={frame.sandbox} allow="" inert={silent} title={title} style={style} onLoad={silent ? () => guard.current?.() : undefined} />;
}
