#!/usr/bin/env node
/* Enviador de avisos de exámenes del Planificador.
 *
 * Corre una vez por día desde GitHub Actions. Lee las suscripciones guardadas
 * en Firestore y le manda un aviso a quien tenga un examen a 5, 2 o 1 día.
 *
 * No necesita servidor propio ni servicios de terceros: Web Push es un estándar
 * del navegador y el envío va directo a Google, Apple o Mozilla según el caso.
 *
 * Variables de entorno (se cargan como secretos del repositorio):
 *   VAPID_PUBLICA    la misma clave que está en index.html
 *   VAPID_PRIVADA    su par secreto — nunca se publica
 *   VAPID_CONTACTO   un mailto: de contacto, lo exige el estándar
 *   FIREBASE_CUENTA  el JSON de la cuenta de servicio de Firebase
 */
const webpush = require("web-push");
const { initializeApp, cert, deleteApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const AVISOS = [5, 2, 1];          // días antes del examen
const SECO = process.argv.includes("--seco");   // prueba: calcula pero no envía

function hoyISO(){
  // los exámenes se anotan en hora local argentina; el runner corre en UTC
  const f = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return f.toISOString().slice(0, 10);
}
function diasHasta(fecha){
  const a = new Date(hoyISO() + "T00:00:00Z"), b = new Date(fecha + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}
const textoDias = d => d === 1 ? "Mañana" : `En ${d} días`;

const fechaLarga = f => new Date(f + "T00:00:00Z")
  .toLocaleDateString("es-AR", { weekday:"long", day:"numeric", month:"long", timeZone:"UTC" });

/* Un aviso por examen y por hito, para que el navegador no apile repetidos si
   la tarea llega a correr dos veces el mismo día. */
function armarAviso(ex, dias){
  return {
    titulo: `${textoDias(dias)}: ${ex.tipo}`,
    cuerpo: `${ex.materia} — ${fechaLarga(ex.fecha)}`,
    url: "./?v=agenda",
    tag: `ex-${ex.id}-${dias}`,
  };
}

/* Los del calendario compartido se distinguen a simple vista: dicen de qué
   grupo son y quién los cargó, y abren esa pestaña en vez de la agenda. */
function armarAvisoGrupo(ev, dias, grupo){
  return {
    titulo: `${textoDias(dias)}: ${ev.titulo}`,
    cuerpo: `${grupo} · ${fechaLarga(ev.fecha)}${ev.autorNombre ? " — lo cargó " + ev.autorNombre : ""}`,
    url: "./?v=compartido",
    tag: `gr-${ev.id}-${dias}`,
  };
}

/* Eventos de un grupo que caen en alguno de los hitos. Se leen una sola vez por
   grupo aunque lo compartan varias personas: son las lecturas más caras del
   proceso y no tiene sentido repetirlas. */
async function eventosDeGrupo(db, gid, cache){
  if (cache.has(gid)) return cache.get(gid);
  let datos = { nombre: "", eventos: [] };
  try {
    const g = await db.collection("grupos").doc(gid).get();
    if (g.exists){
      datos.nombre = g.data().nombre || "un grupo";
      const evs = await db.collection("grupos").doc(gid).collection("eventos").get();
      datos.eventos = evs.docs.map(d => ({ id: d.id, ...d.data() }));
    }
  } catch(e){ console.error(`  no se pudo leer el grupo ${gid.slice(0,6)}…:`, e.message); }
  cache.set(gid, datos);
  return datos;
}

/* Ningún envío puede colgar el proceso: si una dirección de push deja de
   responder, sin esto la tarea se queda esperando para siempre. */
const TIEMPO_MAX = Number(process.env.AVISOS_TIMEOUT_MS) || 20000;
function conLimite(promesa, ms, queEs){
  return Promise.race([promesa, new Promise((_, no) =>
    setTimeout(() => no(Object.assign(new Error(`${queEs}: no respondió en ${ms/1000}s`),
                                      { esDemora: true })), ms))]);
}

let app = null;

async function main(){
  const faltan = ["VAPID_PUBLICA","VAPID_PRIVADA","VAPID_CONTACTO","FIREBASE_CUENTA"]
    .filter(k => !process.env[k]);
  if (faltan.length){
    console.error("Faltan variables de entorno:", faltan.join(", "));
    process.exit(1);
  }

  webpush.setVapidDetails(
    process.env.VAPID_CONTACTO,
    process.env.VAPID_PUBLICA,
    process.env.VAPID_PRIVADA);

  app = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_CUENTA)) });
  const db = getFirestore();

  const snap = await db.collection("avisos").get();
  console.log(`Hoy es ${hoyISO()} · ${snap.size} suscripción(es) registrada(s)`);

  let enviados = 0, limpiados = 0, fallidos = 0, deGrupo = 0;
  const cacheGrupos = new Map();

  for (const doc of snap.docs){
    const d = doc.data();

    const pendientes = [];

    // exámenes propios
    for (const ex of (d.examenes || [])){
      if (!ex || typeof ex.fecha !== "string") continue;
      const dias = diasHasta(ex.fecha);
      if (AVISOS.includes(dias)) pendientes.push(armarAviso(ex, dias));
    }

    /* Exámenes de sus calendarios compartidos. Se avisa aunque el mismo examen
       esté en la agenda personal: son dos anotaciones distintas y quien las
       hizo puede querer las dos. */
    for (const gid of (d.grupos || []).slice(0, 10)){
      const g = await eventosDeGrupo(db, String(gid), cacheGrupos);
      for (const ev of g.eventos){
        if (!ev || typeof ev.fecha !== "string") continue;
        const dias = diasHasta(ev.fecha);
        if (AVISOS.includes(dias)){ pendientes.push(armarAvisoGrupo(ev, dias, g.nombre)); deGrupo++; }
      }
    }
    if (!pendientes.length) continue;

    /* Una persona puede tener los avisos puestos en varios aparatos —el celular
       y la computadora, por ejemplo—, y el mismo aviso va a todos. Cada uno vive
       en su propio documento para que activarlos en uno no pise al otro. */
    const aparatos = (await doc.ref.collection("dispositivos").get().catch(() => null));
    const destinos = aparatos ? aparatos.docs.map(a => ({
      ref: a.ref,
      sub: { endpoint: a.data().endpoint, keys: { p256dh: a.data().p256dh, auth: a.data().auth } },
    })) : [];

    /* Forma anterior: la dirección estaba en el documento de la persona. Se
       sigue atendiendo para quien todavía no abrió la versión nueva; en cuanto
       la abre, su documento se reescribe sin estos campos y pasa a la lista de
       arriba. */
    if (d.endpoint && !destinos.length)
      destinos.push({ ref: doc.ref, sub: { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, viejo: true });

    if (!destinos.length) continue;      // dio de baja todos sus aparatos

    for (const destino of destinos){
      for (const aviso of pendientes){
        if (SECO){ console.log(`  [seco] ${doc.id.slice(0,6)}…/${destino.ref.id.slice(0,6)}… → ${aviso.titulo} · ${aviso.cuerpo}`); enviados++; continue; }
        try {
          await conLimite(webpush.sendNotification(destino.sub, JSON.stringify(aviso)),
                          TIEMPO_MAX, "el servicio de notificaciones");
          enviados++;
        } catch(e){
          /* 404 y 410 significan que esa suscripción ya no existe: el navegador
             la dio de baja o la persona desinstaló la app. Se borra ese aparato
             —no los otros— para no seguir intentando todos los días. */
          if (e.statusCode === 404 || e.statusCode === 410){
            await destino.ref.delete().catch(()=>{});
            limpiados++;
            break;                        // el resto de los avisos de ESTE aparato sobra
          }
          // una demora no es una suscripción muerta: se deja para mañana
          console.error(`  ${e.esDemora?"demora":"error"} con ${doc.id.slice(0,6)}…:`,
                        e.statusCode || e.message);
          fallidos++;
        }
      }
    }
  }

  console.log(`Enviados: ${enviados} (${deGrupo} de calendarios compartidos) · aparatos dados de baja: ${limpiados} · fallos: ${fallidos}`);
}

/* ---- por qué hace falta cerrar a mano ----
   firebase-admin deja abiertas sus conexiones gRPC, así que cuando main()
   termina el proceso NO se muere: queda vivo sin hacer nada. En GitHub Actions
   eso significa que la tarea sigue corriendo hasta agotar el tiempo máximo y la
   plataforma la cancela: el run aparece como "cancelled" aunque los avisos se
   hayan mandado todos. Cerrar la app libera esas conexiones y el proceso
   termina solo. */
async function cerrar(codigo){
  try { if (app) await conLimite(deleteApp(app), 10000, "el cierre de Firebase"); }
  catch(e){ console.error("No se pudo cerrar Firebase:", e.message); }
  process.exit(codigo);
}

main().then(() => cerrar(0))
      .catch(e => { console.error("Falló el envío:", e); cerrar(1); });
