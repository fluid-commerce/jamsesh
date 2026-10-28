// Which addresses to offer people for joining. Pure, so it can be tested.

export type Addr = { label: string; url: string; reachable?: "yes" | "no" | "unknown" | boolean };
export type Code = { code: string; expiresIn: number; period: number; addresses: Addr[] };
export type NetInfo = { reachable?: "yes" | "no" | "unknown"; publicUrl?: string };


export interface JoinOption {
  key: "room" | "remote";
  /** "In the room" or "Remote or phone mic". */
  title: string;
  url: string;
  host: string;
}

export const bare = (u: string) => u.replace(/^https?:\/\//, "");

/**
 * The addresses worth showing, best first. The public https address leads only once the host has
 * confirmed it is reachable; until then people join on the room's own address. When both work,
 * show both: the room address is quickest on the Wi-Fi, https is what remote people and phone
 * microphones need (browsers only allow the mic on https).
 */
export function joinOptions(code: Code | null, net: NetInfo | null): { options: JoinOption[]; unconfirmed: Addr | null } {
  const list = code?.addresses ?? [];
  const https = list.find((a) => a.url.startsWith("https"));
  const lan = list.find((a) => a.url.startsWith("http:") && !/^http:\/\/(localhost|127\.)/.test(a.url)) ?? list.find((a) => a.url.startsWith("http:"));
  const reachable = https && (https.reachable === true || https.reachable === "yes" || (https.reachable == null && net?.reachable === "yes"));
  const options: JoinOption[] = [];
  if (lan) options.push({ key: "room", title: "In the room", url: lan.url, host: bare(lan.url) });
  if (https && reachable) options.push({ key: "remote", title: lan ? "Remote or phone mic" : "Join", url: https.url, host: bare(https.url) });
  if (!options.length) {
    const first = list[0] ?? { label: "", url: (typeof location === "undefined" ? "" : location.origin) };
    options.push({ key: "room", title: "Join", url: first.url, host: bare(first.url) });
  }
  return { options, unconfirmed: https && !reachable ? https : null };
}

/** The one address to print in text (agent line, steps): the first option. */
export function primaryAddress(code: Code | null, net: NetInfo | null = null) {
  const o = joinOptions(code, net).options[0];
  return { label: o.title, url: o.url };
}

