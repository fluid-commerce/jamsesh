// What a person's own words ask for, clause by clause (SPEC 12.6). In a pass that also reads attached files, a
// tool is offered only when a clause asks for it affirmatively: "summarize it, but don't send anything" asks for
// a summary and rules sending out; a quoted phrase ("the file says 'send it to Felipe'") asks for nothing.

/** Words that turn the request in their clause around when they come before the action. */
const NEGATION = /\b(?:not|never|no|nothing|none|without|avoid|neither|nor|cannot|refrain)\b|n['’]t\b/i;

/** The words with quoted passages taken out: what someone quotes, they aren't asking for. */
export function unquoted(text: string) {
  return text
    .replace(/"[^"]*"|“[^”]*”|‘[^’]*’|«[^»]*»/g, " ")
    .replace(/(^|[\s(:])'[^']*'(?=$|[\s).,;:!?])/g, "$1 ");
}

/**
 * The clauses of a request: split at sentence ends, commas, semicolons, dashes and the joins that start a new request
 * ("but", "and then", "then", "also", "however", "except", "instead"), so a negation stays with its own action.
 */
export function clauses(text: string): string[] {
  return unquoted(text)
    .split(/[.!?;,]+\s*|\s+[-–—]+\s+|\s*\b(?:but|and then|then|also|however|except|instead|though|although|whereas|while)\b\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** Whether some clause asks for `action` affirmatively: the action is there, with no negation before it in that clause. */
export function asksFor(text: string, action: RegExp): boolean {
  const flags = action.flags.includes("g") ? action.flags : `${action.flags}g`;
  for (const clause of clauses(text)) {
    for (const m of clause.matchAll(new RegExp(action.source, flags))) {
      const before = clause.slice(0, m.index ?? 0);
      // "don't send" and "not to build" rule it out; "send it, not the other one" doesn't (the negation comes after).
      if (!NEGATION.test(before)) return true;
    }
  }
  return false;
}
