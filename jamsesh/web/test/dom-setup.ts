// A browser-like page for the few tests that mount components (happy-dom, registered as globals).
//
// Keep every mounted test in ONE file (test/record.dom.test.tsx; add new describe-style groups there): a second DOM test file in the same
// `bun test` run broke the first one's tests when tried, because the files share one process and one react-dom.
//
// In a DOM test file:
//   import { enterDom, leaveDom } from "./dom-setup";
//   enterDom();                                       // before anything that needs a document
//   const { render } = await import("@testing-library/react");   // dynamic: static imports can be evaluated first
//   afterAll(leaveDom);                               // puts the globals back, so no other test file sees a `document`
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export function enterDom() {
  if (GlobalRegistrator.isRegistered) return;
  GlobalRegistrator.register({ url: "http://localhost/", width: 1024, height: 768 });
  // React decides whether to listen for `input` (what a textarea's onChange rides on) by asking the document if it has an `oninput`.
  // happy-dom has none, so without this typing never reaches a component.
  if (!("oninput" in document)) (document as unknown as { oninput: null }).oninput = null;
}

export const leaveDom = () => void (GlobalRegistrator.isRegistered && GlobalRegistrator.unregister());
