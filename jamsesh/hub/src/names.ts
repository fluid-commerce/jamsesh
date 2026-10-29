/** The names the brain answers to: one place that cleans them, compares them and lists them. */

export const MAX_ALIASES = 8;
export const MAX_NAME = 40;

/** Letters and digits only, lowercase: how two spellings of a name are compared. */
export const normName = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, "");

export const sameName = (a: string, b: string) => normName(a) === normName(b);

/** Whatever was stored or posted as a list of names: strings only, trimmed, no empties, no repeats (any case), the first MAX_ALIASES, MAX_NAME characters each. */
export function cleanNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const n = raw.trim().replace(/\s+/g, " ").slice(0, MAX_NAME).trim();
    if (!n || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    out.push(n);
    if (out.length >= MAX_ALIASES) break;
  }
  return out;
}

/** The display name, then every alias; anything that isn't a usable string is left out. */
export function brainNames(s: { brainName: unknown; brainAliases?: unknown }): string[] {
  const first = typeof s.brainName === "string" && s.brainName.trim() ? [s.brainName.trim()] : [];
  return [...first, ...cleanNames(s.brainAliases)];
}
