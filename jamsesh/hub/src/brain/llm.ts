// Access to the Vercel AI Gateway with the key from Settings (or ~/.jamsesh/.env).
import { createGateway } from "@ai-sdk/gateway";
import { config } from "../config";
import type { Session } from "../session";

let cached: { key: string; gw: ReturnType<typeof createGateway> } | null = null;

export function gateway(session: Session) {
  if (config.offline) return null;
  const key = session.gatewayKey();
  if (!key) return null;
  if (cached?.key !== key) cached = { key, gw: createGateway({ apiKey: key }) };
  return cached.gw;
}

export function model(session: Session, job: keyof ReturnType<Session["settings"]>["models"]) {
  const gw = gateway(session);
  if (!gw) return null;
  return gw(session.settings().models[job]);
}

export function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/(Bearer\s+)[\w.-]+/gi, "$1…").slice(0, 300);
}
