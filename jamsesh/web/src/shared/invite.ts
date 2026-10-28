import { api } from "./hub";

export interface Invite {
  url: string;
  code: string;
  /** ms since epoch, when the link stops working; 0 when unknown. */
  expiresAt: number;
  /** "invite" = the hub's longer-lived link; "code" = the live 30-second code; "address" = no code available to this window. */
  source: "invite" | "code" | "address";
}

/**
 * Something to paste into a chat so a coworker can join. Prefers the hub's invite link
 * (POST /api/invite); older hubs and non-host windows fall back to the live code or just the address.
 */
export async function createInvite(): Promise<Invite> {
  try {
    const r = await api<{ url: string; code: string; expiresAt?: number }>("/invite", {});
    if (r?.url) return { url: r.url, code: r.code ?? "", expiresAt: r.expiresAt ?? 0, source: "invite" };
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status && status !== 404 && status !== 405) throw e;
  }
  try {
    const c = await api<{ code: string; expiresIn: number; addresses: { url: string }[] }>("/pair/code");
    const base = (c.addresses.find((a) => a.url.startsWith("https")) ?? c.addresses[0])?.url ?? location.origin;
    return { url: `${base}/connect?c=${c.code}`, code: c.code, expiresAt: Date.now() + c.expiresIn, source: "code" };
  } catch {
    return { url: `${location.origin}/connect`, code: "", expiresAt: 0, source: "address" };
  }
}

export function inviteText(i: Invite, sessionName: string) {
  const lines = [`Join "${sessionName}" on JamSesh: ${i.url}`];
  if (i.code) lines.push(`Code: ${i.code}`);
  return lines.join("\n");
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
