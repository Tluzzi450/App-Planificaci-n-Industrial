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
const { initializeApp, cert } = require("firebase-admin/app");
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

/* Un aviso por examen y por hito, para que el navegador no apile repetidos si
   la tarea llega a correr dos veces el mismo día. */
function armarAviso(ex, dias){
  return {
    titulo: `${textoDias(dias)}: ${ex.tipo}`,
    cuerpo: `${ex.materia} — ${new Date(ex.fecha + "T00:00:00Z")
      .toLocaleDateString("es-AR", { weekday:"long", day:"numeric", month:"long", timeZone:"UTC" })}`,
    url: "./?v=agenda",
    tag: `ex-${ex.id}-${dias}`,
  };
}

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

  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_CUENTA)) });
  const db = getFirestore();

  const snap = await db.collection("avisos").get();
  console.log(`Hoy es ${hoyISO()} · ${snap.size} suscripción(es) registrada(s)`);

  let enviados = 0, limpiados = 0, fallidos = 0;

  for (const doc of snap.docs){
    const d = doc.data();
    if (!d.endpoint || !Array.isArray(d.examenes)) continue;

    const pendientes = [];
    for (const ex of d.examenes){
      if (!ex || typeof ex.fecha !== "string") continue;
      const dias = diasHasta(ex.fecha);
      if (AVISOS.includes(dias)) pendientes.push(armarAviso(ex, dias));
    }
    if (!pendientes.length) continue;

    const sub = { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } };
    for (const aviso of pendientes){
      if (SECO){ console.log(`  [seco] ${doc.id.slice(0,6)}… → ${aviso.titulo} · ${aviso.cuerpo}`); enviados++; continue; }
      try {
        await webpush.sendNotification(sub, JSON.stringify(aviso));
        enviados++;
      } catch(e){
        /* 404 y 410 significan que esa suscripción ya no existe: el navegador
           la dio de baja o la persona desinstaló la app. Se borra para no
           seguir intentando todos los días. */
        if (e.statusCode === 404 || e.statusCode === 410){
          await doc.ref.delete().catch(()=>{});
          limpiados++;
          break;
        }
        console.error(`  error con ${doc.id.slice(0,6)}…:`, e.statusCode || e.message);
        fallidos++;
      }
    }
  }

  console.log(`Enviados: ${enviados} · suscripciones vencidas borradas: ${limpiados} · fallos: ${fallidos}`);
}

main().catch(e => { console.error("Falló el envío:", e); process.exit(1); });
