'use strict';

/**
 * Trae de Zotero lo que haya cambiado desde la última pasada.
 *
 * Hasta ahora esto se lanzaba a mano desde el panel, lo que significa que el
 * corpus estaba al día solo cuando alguien se acordaba. Una fuente retirada en
 * Zotero —porque resultó ser de una revista depredadora— seguía citándose aquí
 * mientras tanto.
 *
 * Va de noche y es incremental: a Zotero se le pide solo lo posterior a la
 * versión que ya tenemos, así que una pasada normal son unas pocas peticiones y
 * segundos, no los minutos de la primera.
 *
 * SOBRE LAS CONEXIONES
 * --------------------
 * El plan de la base da CINCO. Este proceso abre su propio grupo de conexiones,
 * y Prisma por defecto lo dimensiona por número de núcleos, no por lo que
 * permite el servidor: así se agotaron una vez. Por eso se fuerza a dos, que es
 * de sobra para un trabajo que escribe por lotes de uno en uno.
 *
 * El turno se pide en la base, no aquí: si el administrador está sincronizando
 * desde el panel en este momento, este proceso se retira sin tocar nada.
 *
 * Uso:  npm run corpus:sincronizar
 */

// El .env se lee aquí a mano y antes que nada. Normalmente lo carga
// `src/config/env.js`, pero eso ocurre demasiado tarde: para cuando se ejecuta,
// Prisma ya está a punto de construirse con la cadena original, y la cadena solo
// se puede tocar antes. Volver a cargarlo dentro de env.js no pisa lo que ya
// esté puesto, así que el límite de abajo sobrevive.
require('dotenv').config({ path: require('node:path').resolve(__dirname, '..', '.env') });

if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('connection_limit')) {
  const separador = process.env.DATABASE_URL.includes('?') ? '&' : '?';
  process.env.DATABASE_URL = `${process.env.DATABASE_URL}${separador}connection_limit=2`;
}

const env = require('../src/config/env');
const prisma = require('../src/lib/prisma');
const referenceService = require('../src/modules/references/reference.service');

/** Cada cuánto se mira si terminó, y cuánto se espera como mucho. */
const SONDEO_MS = 5000;
const LIMITE_MINUTOS = 45;

const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function principal() {
  if (!env.zoteroEnabled) {
    console.log('El corpus no está configurado: falta ZOTERO_API_KEY o la biblioteca. No hay nada que hacer.');
    return;
  }

  const empezado = Date.now();

  try {
    await referenceService.sincronizar({ completa: false });
  } catch (error) {
    // Que el panel esté sincronizando no es un fallo de esta tarea: es
    // exactamente lo que el turno tiene que evitar. Se sale en silencio.
    console.log(`No se arrancó: ${error.message}`);
    return;
  }

  // `sincronizar` vuelve enseguida y deja el trabajo corriendo por detrás. Si el
  // proceso terminase aquí, se cortaría a media pasada.
  while (Date.now() - empezado < LIMITE_MINUTOS * 60_000) {
    await espera(SONDEO_MS);
    const { trabajo } = await referenceService.estado();
    if (!trabajo.activo) {
      const minutos = ((Date.now() - empezado) / 60_000).toFixed(1);

      if (trabajo.error) {
        console.error(`Falló tras ${minutos} min: ${trabajo.error}`);
        process.exitCode = 1;
        return;
      }

      console.log(
        `${new Date().toISOString().slice(0, 19)}  ok en ${minutos} min  ` +
          `${trabajo.guardadas} fuentes, ${trabajo.notas} notas, ${trabajo.retiradas} retiradas`,
      );
      return;
    }
  }

  // No se mata el trabajo: sigue en marcha y el turno se soltará cuando acabe.
  // Lo que se corta es la espera, para que la tarea no se quede colgada.
  console.error(`Sigue corriendo tras ${LIMITE_MINUTOS} min; se deja de esperar.`);
  process.exitCode = 1;
}

principal()
  .catch((error) => {
    console.error('No se pudo sincronizar:', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
