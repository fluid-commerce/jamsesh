import { useEffect, useRef, useState } from "react";
import { cameraProblem, parseJoin, type Scanned } from "./joinHelp";

/** Looks through the camera for the big screen's QR code and hands back what it says. */
export function QrScanner({ onScan, onClose }: { onScan: (s: Scanned) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState("");
  const [wrong, setWrong] = useState(false);
  const [ready, setReady] = useState(false);
  const done = useRef(onScan);
  done.current = onScan;

  useEffect(() => {
    let stop = false;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout>;
    // Asked for after a tick, so a remount right away (React strict mode) doesn't ask the camera twice.
    const start = setTimeout(async () => {
      try {
        const [{ default: jsQR }, s] = await Promise.all([import("jsqr"), navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })]);
        if (stop) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        const el = video.current;
        if (!el) return;
        el.srcObject = s;
        await el.play();
        setReady(true);
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        const look = () => {
          if (stop || !ctx) return;
          if (el.videoWidth) {
            const k = Math.min(1, 640 / el.videoWidth);
            canvas.width = Math.round(el.videoWidth * k);
            canvas.height = Math.round(el.videoHeight * k);
            ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
            if (hit?.data) {
              const joined = parseJoin(hit.data);
              setWrong(!joined);
              if (joined) return void done.current(joined);
            }
          }
          timer = setTimeout(look, 120);
        };
        look();
      } catch (e) {
        if (!stop) setProblem(cameraProblem(e));
      }
    }, 0);
    return () => {
      stop = true;
      clearTimeout(start);
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="qr-scan" role="dialog" aria-label="Scan the QR code on the big screen">
      <div className={`qr-view ${ready ? "on" : ""}`}>
        <video ref={video} muted playsInline />
        {ready && <i className="qr-frame" aria-hidden />}
      </div>
      <p className="qr-note" role="status" data-wrong={wrong || undefined}>
        {problem || (wrong ? "That isn't a JamSesh code. Point at the QR code on the big screen." : ready ? "Point the camera at the QR code on the big screen." : "Starting the camera…")}
      </p>
      <button type="button" className="connect-paste" onClick={onClose}>
        Type the code instead
      </button>
    </div>
  );
}
