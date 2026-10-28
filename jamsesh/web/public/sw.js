// JamSesh service worker: keeps the app shell available offline.
//
// - Navigations: network first (2.5 s), falling back to the last good copy of that page
//   or the cached index.html. The hub is usually on the LAN, so fresh beats stale.
// - Hashed /assets/*: cache first (the hash changes when the content does).
// - Fonts, icons, manifest, other shell files: stale-while-revalidate.
// - Everything live (/api, /ws, /mcp, /canvas, /renders, /snapshots, scripts) goes straight
//   to the network and is never cached.
const VERSION = "jamsesh-shell-v1";
const NETWORK_ONLY = /^\/(api|ws|mcp|canvas|renders|snapshots|join\.sh|hook\.sh|skill\.md|healthz|debug)(\/|$)/;
const SHELL = ["/index.html", "/manifest.webmanifest", "/favicon.svg", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      await Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: "reload" })).catch(() => {})));
      // Pull in the hashed bundles index.html points at, so the first offline load works.
      try {
        const html = await (await cache.match("/index.html"))?.text();
        const urls = [...(html || "").matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
        await Promise.all(urls.map((u) => cache.add(u).catch(() => {})));
      } catch {}
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const old = keys.filter((k) => k.startsWith("jamsesh-shell-") && k !== VERSION);
      await Promise.all(old.map((k) => caches.delete(k)));
      await self.clients.claim();
      if (old.length) for (const c of await self.clients.matchAll()) c.postMessage({ type: "sw-updated", version: VERSION });
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));

async function navigation(request, url) {
  const cache = await caches.open(VERSION);
  const key = url.pathname;
  try {
    const res = await Promise.race([fetch(request), timeout(2500)]);
    const type = res.headers.get("content-type") || "";
    if (res.ok && !res.redirected && type.includes("text/html")) cache.put(key, res.clone());
    return res;
  } catch {
    // Slow or unreachable: serve the last good copy of this page, else the shell.
    return (await cache.match(key)) || (await cache.match("/index.html")) || Response.error();
  }
}

async function swr(request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request);
  const fresh = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  if (hit) return hit;
  return (await fresh) || Response.error();
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || NETWORK_ONLY.test(url.pathname)) return;
  if (request.mode === "navigate") return void event.respondWith(navigation(request, url));
  if (url.pathname.startsWith("/assets/")) return void event.respondWith(cacheFirst(request));
  if (/\.(?:woff2?|ttf|svg|png|ico|webmanifest)$/.test(url.pathname)) return void event.respondWith(swr(request));
});
