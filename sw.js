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
const VERSION = "2026.08.23";
const CACHE = "planificador-industrial-" + VERSION;

const ESENCIALES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-notif.png",
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
/* ================= AVISOS DE EXÁMENES =================
   El navegador entrega el aviso al service worker aunque la app esté cerrada:
   por eso esto vive acá y no en la página. */
self.addEventListener("push", ev => {
  let d = {};
  try { d = ev.data ? ev.data.json() : {}; } catch(_){ d = { cuerpo: ev.data && ev.data.text() }; }
  const titulo = d.titulo || "Planificador UTN";
  ev.waitUntil(self.registration.showNotification(titulo, {
    body: d.cuerpo || "Tenés un examen cerca.",
    icon: "./icon-192.png",          // el grande, a color, dentro del aviso
    /* El chico de la barra de estado NO puede tener fondo: Android ignora el
       color y arma la silueta con la transparencia, así que un ícono con fondo
       sólido sale como un cuadrado blanco. Este es el isotipo recortado. */
    badge: "./icon-notif.png",
    tag: d.tag || "examen",          // un aviso por examen: no se apilan repetidos
    renotify: false,
    data: { url: d.url || "./?v=agenda" },
  }));
});

/* Al tocar el aviso: si la app ya está abierta se la trae al frente en vez de
   abrir otra pestaña. */
self.addEventListener("notificationclick", ev => {
  ev.notification.close();
  const destino = (ev.notification.data && ev.notification.data.url) || "./?v=agenda";
  ev.waitUntil((async () => {
    const abiertas = await self.clients.matchAll({ type:"window", includeUncontrolled:true });
    for (const c of abiertas)
      if (c.url.includes(self.registration.scope) && "focus" in c) return c.focus();
    if (self.clients.openWindow) return self.clients.openWindow(destino);
  })());
});

self.addEventListener("message", ev => {
  if (ev.data === "actualizar-ya") self.skipWaiting();
});
