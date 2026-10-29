// A font only this person has is wanted by someone's canvas. Ask them, once, whether they may share
// it with the session; if so it goes to the host's memory for everyone's canvas until the session
// ends. Also: the fonts this person is sharing, with a way to take them back. Open fonts never come here.
import { useEffect, useRef, useState } from "react";
import { pref, useHub } from "./hub";
import { macInvoke } from "./canvasJoin";
import { familyKey, openQuestions } from "./roomFonts";
import { declineFont, withdrawFont } from "./roomFontsApi";

const MAX_OFFERS = 3;

export function FontShare() {
  const { state } = useHub();
  const invoke = macInvoke();
  const me = pref("personId") || null;
  const [has, setHas] = useState<string[]>([]);
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const checked = useRef(new Set<string>());
  const wanted = state?.fonts?.wanted ?? [];
  const available = state?.fonts?.available ?? [];
  const open = openQuestions(wanted, available, me, answered);
  // Which of the wanted families this Mac has (names only: nothing is read until they agree).
  const unchecked = open.filter((w) => !checked.current.has(w.key)).map((w) => w.family);
  useEffect(() => {
    if (!invoke || !unchecked.length) return;
    for (const f of unchecked) checked.current.add(familyKey(f));
    invoke("has_fonts", { families: unchecked })
      .then((names: string[]) => Array.isArray(names) && setHas((h) => [...new Set([...h, ...names.map(familyKey)])]))
      .catch(() => {});
  }, [unchecked.join("|")]);
  const mine = available.filter((f) => f.kind === "borrowed" && me && f.lenderId === me);
  const offers = invoke ? open.filter((w) => has.includes(w.key)).slice(0, MAX_OFFERS) : [];
  if (!offers.length && !mine.length) return null;
  const names = (ids: string[]) => ids.map((id) => state?.people.find((p) => p.id === id)?.name).filter(Boolean) as string[];
  const done = (key: string) => setAnswered((a) => new Set(a).add(key));
  return (
    <div className="font-shares" role="region" aria-label="Fonts to share">
      {offers.map((w) => (
        <Offer key={w.key} family={w.family} session={state?.session.name ?? "this session"} askers={names(w.askedBy)} onDone={() => done(w.key)} />
      ))}
      {mine.map((f) => (
        <Sharing key={f.key} font={f} />
      ))}
    </div>
  );
}

function Offer({ family, session, askers, onDone }: { family: string; session: string; askers: string[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const invoke = macInvoke();
  const share = async () => {
    setBusy(true);
    setErr("");
    try {
      // The Mac app asks in a native dialog and reads the files only on a yes: this page never gets them otherwise.
      // The Mac app asks in its own dialog and sends the font to the host itself: this page never holds it.
      if (!invoke) throw new Error("Share fonts from the JamSesh app on your Mac.");
      await invoke("lend_font", { family, session, askers });
      onDone();
    } catch (e: any) {
      setErr(String(typeof e === "string" ? e : e?.message ?? "Couldn't share it."));
      setBusy(false);
    }
  };
  const decline = async () => {
    setBusy(true);
    onDone();
    await declineFont(family).catch(() => {});
  };
  const who = askers.length ? `${askers.join(" and ")} ${askers.length === 1 ? "is" : "are"} drawing text in it` : "A canvas is drawing text in it";
  return (
    <div className="build-request font-share">
      <div className="build-request-head">
        <span className="build-request-dot" />
        <span>
          Share <b>{family}</b> with <b>{session}</b>?
        </span>
      </div>
      <p className="font-share-note">
        {who}, and it shows in a substitute without it. If you share it, everyone's canvas in this session can use it until the session ends. It is never saved on anyone's Mac. Share it only if your licence allows that.
      </p>
      {err && <div className="build-request-err" role="alert">{err}</div>}
      <div className="build-request-foot">
        <span className="build-request-say" />
        <button className="btn small" disabled={busy} onClick={decline}>
          Don't share
        </button>
        <button className="btn small primary" disabled={busy} onClick={share}>
          I'm allowed to share it
        </button>
      </div>
    </div>
  );
}

function Sharing({ font }: { font: { family: string } }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="font-sharing">
      <span className="ellipsis">
        Sharing <b>{font.family}</b> until the session ends
      </span>
      <button
        className="btn small"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await withdrawFont(font.family).catch(() => {});
          setBusy(false);
        }}
      >
        Stop sharing
      </button>
    </div>
  );
}
