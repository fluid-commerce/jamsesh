# Area S: setup and connection. Review findings

I read the code and did not run it. I cite file:line for each finding. Checks of claims from the "fixed tonight" list are at the end.

## Verdict

**Spec completeness: mostly complete, with two real omissions and three overclaims.**
- Omissions: how remote people get a code (S4), and what happens when remote access is half-working (S3).
- Overclaims: tunnel trust (S1), person-only approvals (S8), and offline merge (S6).

**Fulfilled by the code: partly.**
- The LAN and Mac-app path is solid: Bonjour discovery, local relay, Keychain token, rotating code, rate limits, hub exits with the app, DuckDNS/ACME/NAT-PMP code.
- The path where the owner's coworkers join from outside the room is fragile (S3, S4, S11).
- The QR-into-an-agent promise (A25b) does not work as built (S2).
- Revocation (S5) and offline merge (S6) are weaker than the spec says.

There is no default public server (B/A22b). Hub, web and app code reference only DuckDNS, Let's Encrypt, ipify, check-host.net and the DoH resolvers.

---

## Ranked findings

### S1. blocker if any tunnel is used, otherwise major · kind: bug + spec-wrong · A22c, security model
- **Evidence:**
  - `hub/src/http.ts:20-22` and `:42`, `:61`, `:70-71`, `:89`, `:334`, `:511`, `:525`: "host" is decided only by the socket peer being loopback.
  - Nothing inspects `X-Forwarded-*`, `Forwarded`, `CF-Connecting-IP` or the Host header.
  - `net/router.ts:184` (`CGNAT_MESSAGE`) and SPEC 4.6 tell CGNAT users to use Tailscale Funnel or Cloudflare Tunnel.
  - Both tunnel daemons connect to the hub from 127.0.0.1.
- **What's wrong:**
  - Every internet request through a tunnel is treated as the host machine.
  - It skips pairing, can read `/api/pair/code`, can POST `/api/net/*` and `/api/settings` (gateway key, hostControl), can DELETE `/api/paired/*`, and can approve builds.
  - SPEC 4.6 says "the hub never treats traffic that arrives through a tunnel as the host machine" and §14 repeats it. The code does not do this.
- **Fix:**
  - Treat a request as local only if the peer is loopback and the request carries none of the proxy headers above.
  - Also require the Host header to be loopback, `localhost`, or this machine's LAN IP.
  - In the app's host-mode relay (`proxy.rs:141-145`), strip any inbound `x-forwarded-*` and then add its own.
  - Alternatively, make `JAMSESH_PUBLIC_URL` mode require pairing for everything.
  - Add a regression test.

### S2. major · kind: bug + spec-wrong · A25a/b
- **Evidence:**
  - `web/src/host/JoinCard.tsx:53` encodes `<addr>/connect?c=CODE`.
  - `hub/src/http.ts:78` serves `/connect` as the SPA shell to everyone; there is no content negotiation.
  - Only `/` (`:75`) and `/agent` answer agents with instructions.
  - SPEC 4.3 claims "feeding the same QR (or its link) to Claude Code sets up and connects the agent". The QR link is `/connect`, which returns a JS bundle to an agent.
- **What's wrong:** The headline "feed the QR to Claude Code or Codex" flow fails. An agent that decodes the QR gets an HTML app shell, not the setup guide. The fallback line `join jamsesh at host, code X` only works if the agent fetches the root address with a non-HTML `Accept`.
- **Fix:**
  - Use one URL for the QR, for example `/join?c=CODE`. If the request is a real browser navigation (`Sec-Fetch-Mode: navigate` or `Sec-Fetch-Dest: document`), redirect to `/connect?c=`. Otherwise return the agent guide.
  - Apply the same logic to `/connect` as a safety net.
  - Update spec 4.3.
  - Note that `/agent` pairs on GET, so link unfurlers such as Slack previews create junk agent devices. Consider requiring a `POST`, or return the guide with a "confirm" step.

### S3. major · kind: bug + spec-missing · A22c, A25c
- **Evidence:**
  - `JoinCard.tsx:29-32` (`primaryAddress`) always prefers the first `https` address.
  - `hub.ts` (`session.extraAddresses`, ~line 107) adds "Anywhere" as soon as `cert.state === "ok"`. It ignores `reachable` and the router result.
- **What's wrong:**
  1. If the wizard gets as far as a certificate but the router mapping fails (no UPnP, or CGNAT), the QR and big-screen address switch to an `https://name.duckdns.org` that nobody can reach, including people in the room. One half-finished wizard run breaks joining for everyone.
  2. Even when remote access works, phones on the room's Wi-Fi follow that HTTPS QR through the router's own public address. Many routers can't do that (hairpin NAT). The spec only mentions hairpin for the self-check, not for joining.
- **Fix:**
  - Only promote the public URL to primary when `reachable === "yes"`, or when the host confirms it.
  - Otherwise lead with the LAN address and list the public one as secondary.
  - When both exist, show two labelled QRs: "In the room (Wi-Fi)" and "Remote or phone mic (HTTPS)".
  - Add a spec note, and a wizard hint: "if phones on this Wi-Fi can't open it, turn on NAT loopback or use cellular".

### S4. major · kind: ux + spec-missing · A25c/d, A18
- **Evidence:**
  - `http.ts:61` serves `/api/pair/code` to the host machine only.
  - The code appears only on the big screen (`/host`), in the tray menu (disabled item), and in the host's `/host` header pill.
  - The code is valid for 30-60 seconds (`auth.ts:73-74`).
  - I found no copy-invite or share-link affordance in `web/src`.
- **What's wrong:** A remote coworker can only join if someone at the host reads the code to them in under a minute. Already-paired remote teammates cannot pass it on. Nothing the host can paste into Slack stays valid. This is the main path for A18's "everyone remote" and "hybrid" rooms.
- **Fix:**
  - Add **Invite someone** to the host's client window and the tray menu. It copies `https://name/join?c=CODE` plus the code.
  - Add an "Invite link (valid 10 minutes, single use)" option. It is a deliberate softening of the 30-second rule, so the owner should decide.
  - Add the new option to the spec.

### S5. major · kind: bug + spec-wrong · §14 Revocation
- **Evidence:**
  - `auth.ts:142` only sets `revoked` and sends `bus.send({type:"revoked"})`.
  - That message goes to every socket in the bus broadcast (`http.ts:124-130`).
  - `web/src/shared/hub.ts handle()` has no `revoked` case.
  - WebSockets are keyed by the client-supplied `?device=` (`http.ts:93`, `:133`). That value is not the paired device id, so the server cannot find a revoked device's sockets.
- **What's wrong:**
  - SPEC §14 says "its open connections close, and its window asks to pair again". In the code, a revoked laptop keeps its open `/ws` and keeps receiving all live state, including transcripts, until its next HTTP call returns 401.
  - A device can also claim another device's id in `?device=`. That spoofs `level` and `rtc` messages and tears down that device's mic and shares on close.
- **Fix:**
  - At upgrade, store the authenticated `paired.id` in `ws.data`.
  - `revoke()` should close those sockets, and the shared device-id check should use the authenticated id, not the query parameter.
  - Add a `revoked` case on the client that goes straight to the unauthorized state.

### S6. major · kind: code-gap + spec-wrong · A26d
- **Evidence:**
  - The `x-jam-queued-at` header is sent (`offline.ts:332`, `hub.ts:400`) but never read in `hub/src`.
  - `idempotent()` (`http.ts:549`) only dedupes.
  - A queued PATCH or DELETE to something that was deleted: `store.patch` returns `undefined` (`store.ts:134`), so `json(undefined)` fails with a 500. The client retries 6 times and silently drops it (`offline.ts:283`).
  - `ob.dropped` is never shown. `ConnectionBanner.tsx` has no dropped-changes text.
- **What's wrong:** SPEC 5.2 promises field-by-field merge against host changes and "dropped and reported in the banner". Neither exists. Replays are last-writer-wins, and a replayed edit to something that changed on the host overwrites it.
- **Fix:**
  - Implement the merge using `queued-at` versus the record's `updated` time, at least for pins, people and layouts.
  - Return a 404/410 JSON body for missing targets so the client drops cleanly.
  - Show a "N changes couldn't be applied" line in the banner.
  - If the owner wants this later, soften the spec to "replays in order, last write wins" for now.

### S7. major · kind: bug (security) · §14
- **Evidence:**
  - `/ws` upgrade (`http.ts:92-95`) and `/mcp` have no `Origin` check.
  - No `Host` allowlist.
  - Loopback requests are fully trusted (`local`, `:42`).
  - The relay (`proxy.rs:132-156`) adds the Mac's token to anything that connects to 127.0.0.1:4790, including upgrades.
  - `/api/net/*` calls `req.json()` regardless of content-type (`net/index.ts:234`), so a `text/plain` cross-site POST is a "simple request" that needs no preflight.
- **What's wrong:**
  - Any website open in a browser on the host Mac or on any joined Mac can open `ws://127.0.0.1:4747/ws` (or `:4790/ws`) and stream live room state, including transcripts.
  - DNS rebinding can also read the HTTP API.
  - JSON-content-type POSTs elsewhere are protected by the missing CORS preflight; the `/api/net/*` routes are not.
- **Fix:**
  - Reject WebSocket upgrades whose `Origin` isn't same-origin or the app's own.
  - Require a Host header that is loopback or a known address (also on the relay).
  - Require `application/json` on `/api/net/*`.

### S8. major · kind: spec-wrong (security overclaim) · A33, §14
- **Evidence:**
  - `http.ts:502` and `:518` allow `isLocal(ip) || paired.kind === "browser"`.
  - Agents on any Mac go through the relay. On a joined Mac the relay adds that Mac's browser-kind token (`proxy.rs:147-155`). On the host Mac the relay and any direct call are loopback and therefore "local".
  - No marker distinguishes relayed agent calls.
- **What's wrong:**
  - SPEC §14 says traffic coming "through a Mac's relay on behalf of an agent is never an approval". An agent with a shell can `curl http://127.0.0.1:4790/api/build-requests/<id>` with `{"approve":true}`, which approves its own host build.
  - A build request carries an arbitrary command run on the host. A prompt-injected agent could therefore get code execution on the host Mac.
  - Only agent-kind tokens used directly are refused.
- **Fix:**
  - Require approvals to come from a window the person is using. Examples: a per-window nonce issued only to the page, or a cookie-authenticated request with a matching `Origin`. Reject `Authorization: Bearer`-only calls and calls that arrive through the relay's header injection.
  - Until that is done, soften the spec to "agent tokens can't approve".

### S9. major · kind: bug · A26e
- **Evidence:**
  - `identity.ts:30-31` keys identity by `location.origin`.
  - The join window always loads `http://127.0.0.1:4790`, whatever the host is (`main.rs:21`, `:186-194`).
  - IndexedDB `jamsesh-offline` (`offline.ts:47`) has no host key.
- **What's wrong:**
  - SPEC 5.3 says identity memory is "per host address". In the Mac app, all hosts share one origin.
  - After joining Host B, the Mac sends Host A's personId, deviceIds and prefs.
  - Unsent outbox items and buffered voice for Host A would replay into Host B, which means pins and decisions land in the wrong session.
  - `leave()` doesn't clear anything.
- **Fix:**
  - Key identity and IDB rows by the real upstream host. The relay could expose it, for example in `/api/pair/info` or a header, or the page could receive it via the Tauri bridge.
  - Clear the outbox on host switch.
  - Alternatively, use a per-host relay port or path prefix.

### S10. major · kind: bug · A24a
- **Evidence:**
  - `hub.ts:95` counts `peopleOnline` (`http.ts:122` skips local sockets) plus active agents.
  - The host's own `/host` and `/client` windows are local, so they don't count.
- **What's wrong:** A room session with nobody paired and no agents joined (everyone speaking into the host's room mic) never triggers `caffeinate`. The Mac mini will sleep, or its display will sleep, while the room is talking. SPEC 4.7 says "while people or agents are connected".
- **Fix:** Count the big-screen socket (or the hub being hosted with an open `/host`) as presence. Or hold awake from hub start until N minutes after the last audio segment.

### S11. major · kind: ux/bug · B3, A22c
- **Evidence:**
  - `proxy.rs:36-44`: a typed address without a scheme becomes `http://host:4747`.
  - `index.html:75` says "type the address on the big screen". The spec 3.1 does not mention the scheme.
  - The Keychain account and `cfg.host_url` are the origin string (`main.rs:62`, `:197`).
  - `discover.rs` ignores the advertised `https` TXT entry.
- **What's wrong:**
  - A remote coworker who types `mycrew.duckdns.org` gets "No JamSesh host answered at http://…:4747".
  - The token and the "Rejoin" row are tied to a LAN IP. If the host's DHCP address changes, "Rejoin" fails and the Mac needs a new code.
- **Fix:**
  - For non-IP and non-`.local` hostnames, try `https://` first, then fall back to `http://:4747`.
  - Key the Keychain entry and Rejoin on the Bonjour service name or hostname, and re-resolve it.
  - Use the advertised `https` TXT.

### S12. minor · kind: bug · A22c
- **UPnP lease.** `router.ts:217-226` always asks for a 3600 s lease. Many routers answer UPnP error 725 "only permanent leases". Retry once with `NewLeaseDuration` 0 before falling back to the manual rule.
- **LAN IP choice.** `lanIpv4()` and `config.lanAddress()` take the first non-internal IPv4. On a Mac with Ethernet plus Wi-Fi, or a VM/Docker bridge, that can be the wrong interface for the mapping, the Bonjour record and the QR. Use the default-route interface, and recompute when the network changes. `config.publicHost` is fixed at boot.
- **ACME retries.** `net/index.ts:98` retries only on the daily timer. A first-attempt failure, such as DNS propagation, leaves HTTPS dead until someone presses the button. Retry after a few minutes with backoff.
- **Mapped port.** NAT-PMP may return a different external port than requested (`router.ts:203`). `status.publicUrl` still uses the configured port.

### S13. minor · kind: bug/ux · A25c
- **Evidence:** `auth.ts:78-84`.
- **What's wrong:**
  - The per-IP lockout (8 wrong codes in a row) locks out a whole office NAT. With rotating codes, a few coworkers mistyping can hit it.
  - 60 wrong codes from anyone pauses pairing for everyone, which a single bad actor can trigger deliberately.
  - Behind a tunnel every client shares one IP (S1).
- **Fix:**
  - Count failures per IP per minute, with a longer pause only for repeated bursts.
  - Make the global pause apply only to unauthenticated attempts that fail while a real session is empty.

### S14. minor · kind: ux · Mac menu bar
- **Evidence:** `main.rs:553-556` rebuilds and replaces the tray menu every 5 s, and `refresh_tray` awaits `proxy::get` with no timeout (`proxy.rs:256-263`).
- **What's wrong:** A menu replaced while it's open can flicker or dismiss. An unreachable host stalls the whole refresh loop for the OS connect timeout (about 75 s).
- **Fix:** Update only the "Join code" and "present" item text in place (`set_text`), and wrap the calls in a 2 s timeout.

### S15. minor · kind: ux/spec-gap · A28a
- **Evidence:** SPEC non-goal §1; `/download/mac` (`http.ts:80`); the Connect page link (`ConnectView.tsx:112`).
- **What's wrong:**
  - The connect page offers the unsigned DMG with no first-open instructions. On recent macOS there is no right-click Open, so coworkers will see "can't be opened" and not know why.
  - The first Bonjour browse triggers a Local Network prompt. With an ad-hoc signature the grant and the microphone/camera approvals can reset on each rebuild.
  - Until granted, the Join list is silently empty.
- **Fix:**
  - Add a 3-line "if macOS blocks it: System Settings, Privacy and Security, Open Anyway" hint next to the download link.
  - Show "Allow Local Network access to see sessions near you" when the Join list stays empty.
  - Document the permission resets.

### S16. minor · kind: bug
- `ConnectView.tsx:28`: `location.replace(next)` with `?next=//evil.example` redirects off-site after pairing. Restrict `next` to a same-origin path starting with a single `/`.

---

## Verified as claimed

I checked the "fixed tonight" claims in my area.

| Claim | Where it holds | What differs |
|---|---|---|
| Rotating code, current plus previous window | `auth.ts:64-75` | Matches SPEC 4.2. |
| Rate limits (8 per IP, 60 global) | `auth.ts:78-97` | Behaviour matches the spec; see S13 for design problems. |
| Token hashed on host | `auth.ts:104` | Matches the spec. |
| `/api/paired` routes | `http.ts:507-513` | Delete is host-only; see S5 for what revocation fails to do. |
| Hub exits with the app | `index.ts:55-66` | Done. |
| Hub tolerates a force-quit | `index.ts:57-65` plus `bonjour.ts:25` | The Bonjour wrapper also dies with the hub. Good. |
| Menu bar mute | `main.rs:435-440` | Dispatches a keydown into the client or big-screen window. It does nothing if that window is closed. Minor. |
| Entitlements and `NSAppleEventsUsageDescription`, `NSLocalNetworkUsageDescription`, `NSBonjourServices` | `Entitlements.plist`, `Info.plist` | Present. |
| Keychain keyed by host origin | `main.rs:62-64` | Present, but see S11 (IP-keyed). |
| Persisted idempotency | `store.ts:151-158`, `http.ts:549-581` | Replays work for 24 h across restarts. |
| Keep-awake via caffeinate stacking | `awake.ts` | Correct and never undoes another assertion; but see S10 for what triggers it. |

## Spec checks by requirement

- **B1-B6:** Roles (A22a), one server per session, no default server (A22b), Mac app (A28), keep-awake (A24), DDNS (A22c) and git-OAuth opinion (A23, §17.1 reasoned and consistent) are all stated in the spec. The gaps are S2, S3, S4.
- **A23:** SPEC 17.1 gives an honest recommendation and fits the code. Nothing to fix.
- **A26:** the spec overstates merge (S6) and per-host identity in the app (S9).
- **A30:** the app's "connect to jamsesh" flow is coherent. `set_up_agents` pulls `/agent/setup.sh?relay=<port>`, and the relay supplies credentials for empty `Bearer` headers. It stays tied to the app and the relay port staying 4790, otherwise the agent's saved URL goes stale.