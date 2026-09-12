'use strict';

/**
 * Trae de noche la colección de Zotero de cada tesista que la conectó.
 *
 * Es el hermano de `sincronizar-zotero.js`, y las diferencias importan:
 *
 *   · Aquel sincroniza UNA biblioteca —la de la casa, 24.000 fuentes— y puede
 *     tardar minutos. Este recorre N colecciones de doscientas, y cada una son
 *     dos o tres peticiones.
 *   · Aquel usa la clave del `.env`. Este usa la clave de cada tesista,
 *     descifrada en memoria para su pasada y nada más.
 *   · El cerrojo de aquel es único; el de aquí es por persona, así que una
 *     pasada atascada no bloquea a los demás.
 *
 * DE UNO EN UNO, A PROPÓSITO
 * --------------------------
 * En paralelo sería más rápido y sería un error: la base da CINCO conexiones y
 * este proceso corre a la misma hora que otras tareas. Un `Promise.all` sobre
 * treinta bibliotecas agota el grupo, y lo que se cae entonces no es esta tarea
 * —es el sitio, para los compradores que estén dentro.
 *
 * Y NO SE PARA POR UNO QUE FALLE
 * ------------------------------
 * Que un tesista haya revocado su clave no tiene nada que ver con el siguiente.
 * Cada fallo se anota en su propia fila, se cuenta, y la vuelta sigue.
 *
 * Uso:  npm run bibliotecas:sincronizar
 */

require('dotenv').config({ path: require('node:path').resolve(__dirname, '..', '.env') });

if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('connection_limit')) {
  const separador = process.env.DATABASE_URL.includes('?') ? '&' : '?';
  process.env.DATABASE_URL = `${process.env.DATABASE_URL}${separador}connection_limit=2`;
}

const env = require('../src/config/env');
const prisma = require('../src/lib/prisma');
const repositorio = require('../src/modules/zotero/biblioteca.repository');
const servicio = require('../src/modules/zotero/biblioteca.service');

/** Un respiro entre personas, para no encadenar ráfagas contra Zotero. */
const PAUSA_MS = 1_000;

const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function principal() {
  if (!env.zoteroOauthEnabled) {
    console.log('Conectar Zotero no está configurado: no hay bibliotecas que traer.');
    return;
  }

  // Los intercambios que nadie terminó no tienen por qué seguir aquí mañana.
  const { count: barridos } = await repositorio.limpiarPeticionesViejas();

  const cuentas = await repositorio.conColeccion();
  if (cuentas.length === 0) {
    console.log(`Ninguna biblioteca conectada con colección elegida. ${barridos} pagarés barridos.`);
    return;
  }

  let bien = 0;
  let mal = 0;
  let fuentes = 0;
  const empezado = Date.now();

  for (const { userId } of cuentas) {
    try {
      const resultado = await servicio.sincronizar(userId);
      fuentes += resultado.guardadas;
      bien += 1;
    } catch (error) {
      // El servicio ya lo anotó en la fila de esa persona y lo registró en el
      // log. Aquí solo se cuenta para el resumen de la tarea.
      mal += 1;
      console.error(`  ${userId}: ${error.message}`);
    }

    await espera(PAUSA_MS);
  }

  const minutos = ((Date.now() - empezado) / 60_000).toFixed(1);
  console.log(
    `${new Date().toISOString().slice(0, 19)}  ${bien} bibliotecas al día, ${mal} con fallo, ` +
      `${fuentes} fuentes nuevas, en ${minutos} min`,
  );

  if (mal > 0) process.exitCode = 1;
}

principal()
  .catch((error) => {
    console.error('No se pudieron sincronizar las bibliotecas:', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
