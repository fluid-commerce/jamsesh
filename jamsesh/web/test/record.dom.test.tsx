import { enterDom, leaveDom } from "./dom-setup";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { useState } from "react";
import type { RecordNote } from "../src/shared/notes";

enterDom();
// Loaded after the page exists (see dom-setup.ts).
const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const { RecordPrompt, RecordScope } = await import("../src/shared/annotate");
const { hub } = await import("../src/shared/hub");
const { RecordTidy } = await import("../src/shared/record");

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  leaveDom();
  expect(typeof document).toBe("undefined");
});

const note = (id: string, text: string): RecordNote => ({ id, text, t0: 0, t1: 1, personId: "p", pin: null });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = { method: string; path: string; body: any };
let calls: Call[] = [];
let handler: (c: Call) => Response | Promise<Response>;
const hits = (path: RegExp, method?: string) => calls.filter((c) => path.test(c.path) && (!method || c.method === method));

beforeEach(() => {
  calls = [];
  (hub as { deviceId: string }).deviceId = "dev1";
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const c: Call = { method: String(init?.method ?? "GET"), path: String(url).replace(/^\/api/, ""), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    return handler(c);
  }) as typeof fetch;
});
afterEach(cleanup);

const mic = () => {
  const released: number[] = [];
  return { released, status: { on: false, error: null }, lend: async () => ({ turnedOn: true, release: () => void released.push(1) }), flush: async () => {} };
};

/** The button inside the same page scope the app gives it. */
const Page = ({ m, show = true }: { m: ReturnType<typeof mic>; show?: boolean }) => <RecordScope>{show && <RecordPrompt personId="p1" brainName="Computah" mic={m} />}</RecordScope>;
const button = (c: HTMLElement) => c.ownerDocument.querySelector(".rec-btn") as HTMLButtonElement;

const happy = (over: Partial<Record<string, (c: Call) => Response>> = {}) => (c: Call) => {
  const f = over[`${c.method} ${c.path.split("?")[0]}`];
  if (f) return f(c);
  if (c.path === "/record/start") return json({ id: "rec1" });
  if (c.path === "/record/stop") return json({ ok: true, recordingId: "rec1", notes: [note("a", "make it bigger")] });
  if (c.path === "/record/send") return json({ ok: true, sent: [], brain: 1 });
  if (c.path === "/record/cancel") return json({ ok: true, state: "ended", outcome: { kind: "cancel" } });
  if (c.path.startsWith("/record/rec1")) return json({ ok: true, state: "live" });
  return json({ ok: false }, 404);
};

const press = async (b: HTMLElement) => void (await act(async () => void fireEvent.click(b)));

test("Record, Stop, tidy, Send: the notes go out once and the sheet closes with a confirmation", async () => {
  handler = happy();
  const m = mic();
  const ui = render(<Page m={m} />);
  await press(button(ui.container));
  await waitFor(() => expect(button(ui.container).getAttribute("aria-pressed")).toBe("true"));
  expect(hits(/record\/start/)[0].body.token).toMatch(/^rt_/);
  await press(button(ui.container));
  await ui.findByText("Your notes");
  expect(m.released.length).toBe(1);
  await press(ui.getByRole("button", { name: /^Send 1 note/ }));
  await ui.findByText("Notes sent");
  expect(hits(/record\/send/).length).toBe(1);
  expect(hits(/record\/send/)[0].body.notes.map((n: RecordNote) => n.text)).toEqual(["make it bigger"]);
});

test("a Stop whose reply was lost is recovered from the hub: the notes still arrive, and nothing is cancelled", async () => {
  handler = happy({ "POST /record/stop": () => json({ error: "gone" }, 409), "GET /record/rec1": () => json({ ok: true, state: "ended", outcome: { kind: "stop", result: { ok: true, recordingId: "rec1", notes: [note("a", "recovered note")] } } }) });
  const ui = render(<Page m={mic()} />);
  await press(button(ui.container));
  await waitFor(() => expect(button(ui.container).getAttribute("aria-pressed")).toBe("true"));
  await press(button(ui.container));
  await ui.findByDisplayValue("recovered note");
  expect(hits(/record\/cancel/).length).toBe(0);
});

test("a Send that fails leaves the sheet locked; the retry sends the same notes and succeeds", async () => {
  let sends = 0;
  handler = happy({ "POST /record/send": () => (++sends === 1 ? json({ error: "db busy" }, 500) : json({ ok: true, sent: [], brain: 1 })) });
  const ui = render(<Page m={mic()} />);
  await press(button(ui.container));
  await waitFor(() => expect(button(ui.container).getAttribute("aria-pressed")).toBe("true"));
  await press(button(ui.container));
  await ui.findByText("Your notes");
  await press(ui.getByRole("button", { name: /^Send 1 note/ }));
  await ui.findByText(/Your notes are still here/);
  expect((ui.getByLabelText("Note 1") as HTMLTextAreaElement).readOnly).toBe(true);
  expect((ui.getByRole("button", { name: "Discard" }) as HTMLButtonElement).disabled).toBe(true);
  await press(ui.getByRole("button", { name: /^Send 1 note/ }));
  await ui.findByText("Notes sent");
  const bodies = hits(/record\/send/).map((c) => c.body.notes.map((n: RecordNote) => n.text));
  expect(bodies).toEqual([["make it bigger"], ["make it bigger"]]);
});

test("Discard on a sheet nothing was sent from throws the notes away; they do not come back", async () => {
  handler = happy();
  const ui = render(<Page m={mic()} />);
  await press(button(ui.container));
  await waitFor(() => expect(button(ui.container).getAttribute("aria-pressed")).toBe("true"));
  await press(button(ui.container));
  await ui.findByText("Your notes");
  await press(ui.getByRole("button", { name: "Discard" }));
  await press(ui.getAllByRole("button", { name: "Discard" })[0]);
  await waitFor(() => expect(ui.queryByText("Your notes")).toBeNull());
  expect(hits(/record\/send/).length).toBe(0);
});

test("the tidy notes survive the button unmounting and remounting (a layout change)", async () => {
  handler = happy();
  const m = mic();
  const ui = render(<Page m={m} />);
  await press(button(ui.container));
  await waitFor(() => expect(button(ui.container).getAttribute("aria-pressed")).toBe("true"));
  await press(button(ui.container));
  await ui.findByText("Your notes");
  ui.rerender(<Page m={m} show={false} />);
  ui.rerender(<Page m={m} show={true} />);
  // The scope is kept by the page: the sheet is back with the same notes, and sending from it works.
  expect(ui.queryByText("Your notes")).not.toBeNull();
  expect((ui.getByLabelText("Note 1") as HTMLTextAreaElement).value).toBe("make it bigger");
  await press(ui.getByRole("button", { name: /^Send 1 note/ }));
  await ui.findByText("Notes sent");
});

test("a button that unmounts mid-recording hands the recording to the hub, gives the mic back, and the next button finishes the job", async () => {
  handler = happy();
  const m = mic();
  const ui = render(<Page m={m} />);
  await press(button(ui.container));
  await waitFor(() => expect(button(ui.container).getAttribute("aria-pressed")).toBe("true"));
  const token = hits(/record\/start/)[0].body.token;
  // The cancel does not get through the first time (the page is going away).
  handler = (c) => (c.path === "/record/cancel" ? json({ error: "down" }, 503) : happy()(c));
  ui.unmount();
  await waitFor(() => expect(hits(/record\/cancel/).length).toBeGreaterThan(0));
  expect(hits(/record\/cancel/)[0].body).toEqual({ deviceId: "dev1", token });
  expect(m.released.length).toBe(1);
  // A new button mounts: it asks after the recording and cancels it again; the hub says it ended.
  let asked = 0;
  handler = (c) => (c.path.startsWith("/record/rec1") ? (asked++, json({ ok: true, state: "live" })) : c.path === "/record/cancel" ? json({ ok: true, state: "ended", outcome: { kind: "cancel" } }) : happy()(c));
  const again = render(<Page m={mic()} />);
  await waitFor(() => expect(hits(/record\/cancel/).length).toBeGreaterThan(1));
  expect(asked).toBeGreaterThan(0);
  again.unmount();
});

test("a button that unmounts while its Stop is still in flight still hands the recording to the hub", async () => {
  handler = happy();
  const ui = render(<Page m={mic()} />);
  await press(button(ui.container));
  await waitFor(() => expect(button(ui.container).getAttribute("aria-pressed")).toBe("true"));
  const token = hits(/record\/start/)[0].body.token;
  handler = (c) => (c.path === "/record/stop" ? new Promise<Response>(() => {}) : happy()(c));
  await press(button(ui.container));
  await waitFor(() => expect(hits(/record\/stop/).length).toBe(1));
  ui.unmount();
  await waitFor(() => expect(hits(/record\/cancel/).length).toBeGreaterThan(0));
  expect(hits(/record\/cancel/)[0].body.token).toBe(token);
});

// ---- the tidy sheet on its own, inside a small stand-in for the button's bookkeeping ----

/** Types into a textarea the way a person does: through the element's own setter (React watches the value it set itself), then an input event. */
function typeInto(el: HTMLElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
  fireEvent.input(el);
}


/** The tidy sheet inside the same bookkeeping the Record button gives it: a send locks the list, and a retry sends the first set. */
function Harness({ onSend, fail = false }: { onSend: (notes: RecordNote[]) => Promise<void>; fail?: boolean }) {
  const [notes, setNotes] = useState([note("a", "make it bigger"), note("b", "and bluer")]);
  const [state, setState] = useState<{ busy: boolean; submitted?: RecordNote[]; error?: string; gone?: boolean }>({ busy: false });
  if (state.gone) return <p>discarded</p>;
  return (
    <RecordTidy
      notes={notes}
      brain="Computah"
      busy={state.busy}
      locked={state.busy || !!state.submitted}
      error={state.error}
      onChange={(n) => !state.busy && !state.submitted && setNotes(n)}
      onSend={async () => {
        const sent = state.submitted ?? notes.filter((n) => n.text.trim());
        setState({ busy: true, submitted: sent });
        try {
          await onSend(sent);
          setState({ busy: false, gone: true });
        } catch {
          setState({ busy: false, submitted: sent, error: "Couldn't send. Your notes are still here." });
        }
      }}
      onDiscard={() => setState({ busy: false, gone: true })}
    />
  );
}

test("Send carries the tidied notes; editing before it counts, and a join merges two into one", async () => {
  const sent: RecordNote[][] = [];
  const ui = render(<Harness onSend={async (n) => void sent.push(n)} />);
  typeInto(ui.getByLabelText("Note 1"), "make it much bigger");
  fireEvent.click(ui.getByLabelText("Join note 2 with the one above"));
  fireEvent.click(ui.getByRole("button", { name: /^Send 1 note/ }));
  await ui.findByText("discarded");
  expect(sent.length).toBe(1);
  expect(sent[0].map((n) => n.text)).toEqual(["make it much bigger and bluer"]);
});

test("after a failed Send the list is read-only and the retry sends the very same notes", async () => {
  const sent: string[][] = [];
  let calls = 0;
  const ui = render(<Harness onSend={async (n) => { sent.push(n.map((x) => x.text)); if (++calls === 1) throw new Error("offline"); }} />);
  fireEvent.click(ui.getByRole("button", { name: /^Send 2 notes/ }));
  await ui.findByText(/Your notes are still here/);
  // Locked: typing, joining and deleting do nothing, and Discard is not offered while delivery is unresolved.
  const box = ui.getByLabelText("Note 1") as HTMLTextAreaElement;
  expect(box.readOnly).toBe(true);
  typeInto(box, "changed after");
  expect((ui.getByLabelText("Delete note 1") as HTMLButtonElement).disabled).toBe(true);
  expect((ui.getByRole("button", { name: "Discard" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(ui.getByRole("button", { name: /^Send 2 notes/ }));
  await ui.findByText("discarded");
  // The text typed while locked changed nothing that was sent.
  expect(sent).toEqual([["make it bigger", "and bluer"], ["make it bigger", "and bluer"]]);
});

test("Discard asks first; while it is being asked the keyboard Send does nothing, and Keep returns to the list", async () => {
  const sent: RecordNote[][] = [];
  const ui = render(<Harness onSend={async (n) => void sent.push(n)} />);
  fireEvent.click(ui.getByRole("button", { name: "Discard" }));
  expect(ui.getByText("Throw these notes away?")).toBeTruthy();
  fireEvent.keyDown(window, { key: "Enter", metaKey: true });
  expect(sent.length).toBe(0);
  fireEvent.click(ui.getByRole("button", { name: "Keep them" }));
  expect(ui.getByLabelText("Note 1")).toBeTruthy();
  fireEvent.keyDown(window, { key: "Enter", metaKey: true });
  await ui.findByText("discarded");
  expect(sent.length).toBe(1);
});

test("Discard throws the notes away once confirmed", async () => {
  const ui = render(<Harness onSend={async () => {}} />);
  fireEvent.click(ui.getByRole("button", { name: "Discard" }));
  fireEvent.click(ui.getAllByRole("button", { name: "Discard" })[0]);
  await ui.findByText("discarded");
});
