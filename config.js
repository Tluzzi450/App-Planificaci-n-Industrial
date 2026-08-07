/* ============================================================================
   CONFIGURACIÓN DE LAS CUENTAS  (opcional)
   ============================================================================
   Copiá este archivo como  config.js  y pegá adentro los datos de TU proyecto
   de Firebase. Sin este archivo la app funciona igual, pero cada estudiante
   guarda su progreso sólo en el navegador de ese dispositivo.

   Los pasos para conseguir estos valores están en el README.

   ¿Es seguro que estas claves estén en un repositorio público?
   Sí. La "apiKey" de Firebase para web NO es una contraseña: identifica al
   proyecto, no autoriza nada por sí sola. Google la publica en su propia
   documentación. Lo que realmente protege los datos son dos cosas:
     1. las reglas de Firestore (archivo firestore.rules), que impiden que
        alguien lea el progreso de otro;
     2. la lista de dominios autorizados en Authentication, que impide que
        otro sitio use tu proyecto para iniciar sesión.
   Configurá las dos cosas y recién ahí publicá.
   ========================================================================== */

window.FB_CONFIG = {
 apiKey: "AIzaSyBD28JJo9I2YalwZTJ41tLV_6NLUx1ymeA",
  authDomain: "app-planificacion-industrial.firebaseapp.com",
  projectId: "app-planificacion-industrial",
  storageBucket: "app-planificacion-industrial.firebasestorage.app",
  messagingSenderId: "675416913545",
  appId: "1:675416913545:web:c679295febe97ad38c7858",
  measurementId: "G-HJ477WDKVP"
};
