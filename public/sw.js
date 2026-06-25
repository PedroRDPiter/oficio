const CACHE_NAME = "oficios-dpdu-v17";
const ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/supabase-config.js",
  "/manifest.webmanifest",
  "/icon.svg"
];
const FALLBACK_MANIFEST = {
  name: "Control de Oficios DPDU",
  short_name: "Oficios DPDU",
  id: "/",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#f3f5f4",
  theme_color: "#164439",
  icons: [
    {
      src: "/icon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any maskable"
    }
  ]
};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => Promise.all(
      ASSETS.map((asset) => cache.add(asset).catch(() => null))
    ))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/documentos/")) return;
  if (url.pathname === "/manifest.webmanifest") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (!response.ok || response.redirected) throw new Error("Manifest no disponible");
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || new Response(
          JSON.stringify(FALLBACK_MANIFEST),
          { headers: { "Content-Type": "application/manifest+json; charset=utf-8" } }
        )))
    );
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && !response.redirected && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/index.html")))
  );
});
