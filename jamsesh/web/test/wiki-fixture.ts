// A seeded wiki folder for tests and screenshots: a made-up project, written through the hub's own file layer.
import { addSource, appendLog, rebuildIndex, writePage } from "../../hub/src/wiki/files";
import type { Category } from "../../hub/src/wiki/files";

interface Spec {
  slug: string;
  title: string;
  category: Category;
  text: string;
}

const CORE: Spec[] = [
  { slug: "passport", title: "Passport", category: "workstreams", text: "The sign-in and account work for the mobile app. It covers [[passport-login]], [[account-menu]] and the rules in [[session-length]]. Owner: [[felipe]]." },
  { slug: "passport-login", title: "Passport login", category: "features", text: "People sign in with a code sent to their phone, then stay signed in for the length set in [[session-length]]. See [[passport]] for the wider work and [[magic-link|the email option]] we decided against." },
  { slug: "account-menu", title: "Account menu", category: "features", text: "A menu in the top right with profile, devices and sign out. Built for [[passport]] by [[sam]]. It replaces the old settings page, see [[settings-page]]." },
  { slug: "session-length", title: "Session length", category: "decisions", text: "We keep people signed in for 30 days on a phone and 8 hours on a shared screen (src: __SRC__, 00:04). Decided in the standup, argued by [[felipe]] and [[chey]]." },
  { slug: "magic-link", title: "Magic link sign-in", category: "decisions", text: "Dropped. Email links get opened on the wrong device and [[passport-login]] already covers it. See (src: __SRC__, 00:12)." },
  { slug: "felipe", title: "Felipe", category: "people", text: "Engineering lead on [[passport]]. Works in [[mobile-app]]." },
  { slug: "sam", title: "Sam", category: "people", text: "Designs the [[account-menu]] and the empty states across [[mobile-app]]." },
  { slug: "chey", title: "Chey", category: "people", text: "Owns the product direction. Cares most about how it feels in the first minute: see [[onboarding]]." },
  { slug: "mobile-app", title: "Mobile app", category: "repos", text: "The React Native app. Ships to TestFlight on Fridays. Workstreams: [[passport]], [[onboarding]]." },
  { slug: "onboarding", title: "Onboarding", category: "workstreams", text: "First run: three screens, then the room. Open question: [[skip-or-require-profile]]. Depends on [[passport-login]]." },
  { slug: "skip-or-require-profile", title: "Skip or require a profile photo?", category: "questions", text: "Chey wants it skippable, Felipe wants it required for the room. Not settled. Affects [[onboarding]] and [[account-menu]]." },
  { slug: "settings-page", title: "Settings page", category: "features", text: "Retired once [[account-menu]] shipped." },
  { slug: "offline-sign-in", title: "Offline sign-in", category: "requirements", text: "Someone already signed in must still open the app with no signal. Applies to [[passport-login]] and [[session-length]]." },
];

const TOPICS = ["Push notifications", "Dark mode", "Deep links", "Analytics", "Accessibility", "Release train", "Crash reports", "Localization", "Payments", "Search", "Avatars", "Rate limits", "Design tokens", "Onboarding video", "Invite codes", "Support inbox", "Feature flags", "Performance budget", "Copy style", "Data export", "App store listing", "Beta testers", "Terms of service"];
const KINDS: Category[] = ["features", "decisions", "requirements", "questions", "topics", "workstreams", "repos", "people"];

/** `count` pages in all: the core set, then generated pages linked into it. Returns the first source's id. */
export function seedWiki(dir: string, count = 13): { source: string; transcript: string } {
  const transcript = addSource(dir, {
    kind: "transcript",
    title: "Standup, Wednesday",
    by: "JamSesh",
    text: ["[00:01] Chey: Okay, sessions. How long do we keep people signed in?", "[00:04] Felipe: Thirty days on a phone, eight hours on a shared screen.", "[00:06] Sam: And the account menu?", "[00:12] Chey: Skip the magic link. Email opens on the wrong device.", "[00:15] Felipe: Agreed."].join("\n"),
  }).id;
  const doc = addSource(dir, { kind: "document", title: "Passport brief", by: "Chey", text: "# Passport brief\n\nSign in, stay signed in, sign out. Keep it calm." }).id;
  const specs: Spec[] = [...CORE];
  for (let i = 0; specs.length < count; i++) {
    const t = TOPICS[i % TOPICS.length] + (i >= TOPICS.length ? ` ${Math.floor(i / TOPICS.length) + 1}` : "");
    const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const near = specs[(i * 7 + 3) % specs.length].slug;
    const far = specs[(i * 5 + 1) % Math.min(specs.length, 13)].slug;
    specs.push({ slug, title: t, category: KINDS[i % KINDS.length], text: `Notes on ${t.toLowerCase()}. Related: [[${near}]] and [[${far}]]. Not yet decided how it fits with [[mobile-app]].` });
  }
  for (const p of specs) {
    writePage(dir, p.slug, `# ${p.title}\n\n${p.text.replaceAll("__SRC__", transcript)}\n`, { category: p.category, sources: p.text.includes("__SRC__") ? [transcript] : [doc], workstreams: ["Passport"] });
  }
  appendLog(dir, "Ingested Standup, Wednesday", ["session-length", "magic-link"]);
  appendLog(dir, "Added Passport brief", ["passport"]);
  rebuildIndex(dir);
  return { source: doc, transcript };
}
