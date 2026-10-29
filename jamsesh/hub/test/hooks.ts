// The Claude Code hook script as tests drive it: a hook finds its agent by the chat's session id, on
// the agent's own machine, and hands back the delivery ids it passed on with its next call (Hub.offer).
import type { Hub } from "../src/hub";
import type { Agent } from "../src/types";

const drivers = new WeakMap<Hub, ReturnType<typeof driver>>();
export const hooksOf = (hub: Hub) => drivers.get(hub) ?? drivers.set(hub, driver(hub)).get(hub)!;

function driver(hub: Hub) {
  const passedOn = new Map<string, string[]>();
  // An agent registered without a chat gets one, as jam_join with a chat id would.
  const chat = (a: Agent) => {
    const cur = hub.session.agent(a.id) ?? a;
    return cur.chatId ? cur : hub.session.store.put("agents", { ...cur, chatId: `chat-${cur.id}` });
  };
  const call = (a: Agent, extra: object) => {
    const c = chat(a);
    const jamAcks = passedOn.get(c.id) ?? [];
    passedOn.delete(c.id);
    return { c, body: { session_id: c.chatId, ...extra, jamAcks } };
  };
  const keep = (id: string, delivery?: string | null) => delivery && passedOn.set(id, [...(passedOn.get(id) ?? []), delivery]);
  const sync = (kind: "onPrompt" | "onTool" | "onStop") => (a: Agent, extra: object = {}) => {
    const { c, body } = call(a, extra);
    const r: any = hub[kind](body, "127.0.0.1", c.machine);
    keep(c.id, r.jamDelivery);
    return r;
  };
  return {
    prompt: sync("onPrompt"),
    tool: sync("onTool"),
    stop: sync("onStop"),
    listen: async (a: Agent, extra: object = {}, maxMs?: number) => {
      const { c, body } = call(a, extra);
      const r = await hub.listen(body, "127.0.0.1", c.machine, maxMs);
      keep(c.id, r.delivery);
      return r.text;
    },
    /** Forgets what was passed on, as if the hook's answer never arrived. */
    lose: (a: Agent) => void passedOn.delete(a.id),
  };
}
