import type { CSSProperties, Ref } from "react";
import { htmlFrame, useSilent } from "./sound";

/**
 * A page of the room's own HTML in a frame. In a silent room it has no scripts or media (see htmlFrame), its links
 * and forms can't be used at all (the frame is inert: no clicks or keys reach it, so nothing can navigate it, even with
 * target=_self). The empty sandbox and the content policy cover whatever else it tries.
 */
export function HtmlFrame({ doc, title, style, frameRef }: { doc: string; title: string; style: CSSProperties; frameRef?: Ref<HTMLIFrameElement> }) {
  const silent = useSilent();
  const frame = htmlFrame(silent, doc);
  return <iframe ref={frameRef} srcDoc={frame.srcDoc} sandbox={frame.sandbox} allow="" inert={silent} title={title} style={style} />;
}
