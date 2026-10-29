import { enterDom, leaveDom } from "./dom-setup";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { RecordNote } from "../src/shared/notes";

enterDom();
// Loaded after the page exists (see dom-setup.ts).
const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const { RecordPrompt, RecordScope } = await import("../src/shared/annotate");
const { hub } = await import("../src/shared/hub");

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

/** Types into a textarea the way a person does: through the element's own setter (React watches the value it set itself), then an input event. */
function typeInto(el: HTMLElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
  fireEvent.input(el);
}



const open2 = async (ui: ReturnType<typeof render>, notes: RecordNote[]) => {
  handler = happy({ "POST /record/stop": () => json({ ok: true, recordingId: "rec1", notes }) });
  await press(button(ui.container));
  await waitFor(() => expect(button(ui.container).getAttribute("aria-pressed")).toBe("true"));
  await press(button(ui.container));
  await ui.findByText("Your notes");
};

test("editing a note and joining two before Send: the notes that go out are the tidied ones", async () => {
  const ui = render(<Page m={mic()} />);
  await open2(ui, [note("a", "make it bigger"), note("b", "and bluer")]);
  typeInto(ui.getByLabelText("Note 1"), "make it much bigger");
  await press(ui.getByLabelText("Join note 2 with the one above"));
  await press(ui.getByRole("button", { name: /^Send 1 note/ }));
  await ui.findByText("Notes sent");
  expect(hits(/record\/send/)[0].body.notes.map((n: RecordNote) => n.text)).toEqual(["make it much bigger and bluer"]);
});

test("while Discard is being asked the keyboard Send does nothing; Keep returns to the list and the keyboard Send works", async () => {
  const ui = render(<Page m={mic()} />);
  await open2(ui, [note("a", "make it bigger")]);
  await press(ui.getByRole("button", { name: "Discard" }));
  await act(async () => void fireEvent.keyDown(window, { key: "Enter", metaKey: true }));
  expect(hits(/record\/send/).length).toBe(0);
  await press(ui.getByRole("button", { name: "Keep them" }));
  await act(async () => void fireEvent.keyDown(window, { key: "Enter", metaKey: true }));
  await ui.findByText("Notes sent");
  expect(hits(/record\/send/).length).toBe(1);
});
