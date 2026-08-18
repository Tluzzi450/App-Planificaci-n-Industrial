/* Service worker del Planificador Académico.
 *
 * Estrategia, y por qué:
 *  - El HTML va por RED PRIMERO, con la caché como red de contención. Toda la app
 *    (datos del plan, horarios, calendario) vive dentro de ese único archivo, así
 *    que si sirviéramos la caché primero, un estudiante podría quedarse meses con
 *    los horarios del cuatrimestre pasado sin enterarse.
 *  - El resto (íconos, manifest) va por CACHÉ PRIMERO: no cambia casi nunca.
 *  - Lo de otros dominios (SDK de Firebase, tipografía de Google) no se toca: que
 *    lo maneje el navegador. Guardar respuestas opacas acá sólo trae problemas.
 *
 * Al publicar una versión nueva: cambiá VERSION. Eso descarta la caché vieja.
 */
const VERSION = "2026.08.19";
const CACHE = "planificador-industrial-" + VERSION;

const ESENCIALES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", ev => {
  ev.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // addAll falla entero si un solo pedido falla; se agregan de a uno para que
    // un recurso ausente no deje la app sin service worker.
    await Promise.all(ESENCIALES.map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", ev => {
  ev.waitUntil((async () => {
    const nombres = await caches.keys();
    await Promise.all(nombres.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", ev => {
  const req = ev.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;   // Firebase, Google Fonts: sin intervenir

  // navegación (abrir la app) -> red primero
  const esNavegacion = req.mode === "navigate" ||
    (req.headers.get("accept") || "").includes("text/html");

  if (esNavegacion) {
    ev.respondWith((async () => {
      try {
        const fresca = await fetch(req);
        const c = await caches.open(CACHE);
        c.put("./index.html", fresca.clone());
        return fresca;
      } catch (e) {
        // sin conexión: lo último que se haya guardado
        const c = await caches.open(CACHE);
        return (await c.match("./index.html")) || (await c.match("./")) ||
          new Response("<h1>Sin conexión</h1><p>Abrí la app una vez con internet para poder usarla offline.</p>",
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 503 });
      }
    })());
    return;
  }

  // el resto -> caché primero, y se refresca por atrás
  ev.respondWith((async () => {
    const c = await caches.open(CACHE);
    const guardada = await c.match(req);
    const enRed = fetch(req).then(r => {
      if (r && r.ok) c.put(req, r.clone());
      return r;
    }).catch(() => null);
    return guardada || (await enRed) || new Response("", { status: 504 });
  })());
});

// permite que la página fuerce la actualización sin esperar a que se cierren las pestañas
self.addEventListener("message", ev => {
  if (ev.data === "actualizar-ya") self.skipWaiting();
});
