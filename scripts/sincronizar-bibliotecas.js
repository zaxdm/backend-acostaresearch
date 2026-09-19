'use strict';

/**
 * Trae de noche la colección de Zotero —y la carpeta de Mendeley— de cada
 * tesista que la conectó.
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
const scopus = require('../src/modules/scopus/scopus.repository');
const mendeleyRepositorio = require('../src/modules/mendeley/mendeley.repository');
const mendeleyServicio = require('../src/modules/mendeley/mendeley.service');

/** Un respiro entre personas, para no encadenar ráfagas contra Zotero. */
const PAUSA_MS = 1_000;

const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function principal() {
  /**
   * Los intercambios de Scopus que nadie terminó, de paso.
   *
   * No hay nada que sincronizar de Scopus —conectar, buscar e importar es a
   * mano, y la sincronización automática es otra decisión que no está tomada—
   * pero sus pagarés a medias se acumulan igual que los de Zotero, y esta es
   * la única tarea que pasa cada noche por aquí. Va ANTES del corte de abajo:
   * si Zotero está apagado y Scopus no, alguien tiene que barrerlos.
   */
  if (env.scopusOauthEnabled) {
    const { count } = await scopus.limpiarEstadosViejos();
    if (count > 0) console.log(`${count} autorizaciones de Scopus a medias, barridas.`);
  }

  // Zotero y Mendeley van uno detrás de otro y cada uno con su interruptor:
  // que uno esté apagado no puede dejar sin pasada al otro.
  let mal = 0;
  if (env.zoteroOauthEnabled) {
    mal += await recorrer('Zotero', repositorio.limpiarPeticionesViejas, repositorio.conColeccion, servicio.sincronizar);
  } else {
    console.log('Conectar Zotero no está configurado: no hay bibliotecas de Zotero que traer.');
  }

  if (env.mendeleyOauthEnabled) {
    mal += await recorrer(
      'Mendeley',
      mendeleyRepositorio.limpiarEstadosViejos,
      mendeleyRepositorio.conCarpeta,
      mendeleyServicio.sincronizar,
    );
  } else {
    console.log('Conectar Mendeley no está configurado: no hay bibliotecas de Mendeley que traer.');
  }

  if (mal > 0) process.exitCode = 1;
}

/** Una vuelta por las cuentas de un servicio. Devuelve cuántas fallaron. */
async function recorrer(nombre, barrer, cuentasDe, sincronizar) {
  // Los intercambios que nadie terminó no tienen por qué seguir aquí mañana.
  const { count: barridos } = await barrer();

  const cuentas = await cuentasDe();
  if (cuentas.length === 0) {
    console.log(`${nombre}: ninguna biblioteca con qué traer elegido. ${barridos} pagarés barridos.`);
    return 0;
  }

  let bien = 0;
  let mal = 0;
  let fuentes = 0;
  const empezado = Date.now();

  for (const { userId } of cuentas) {
    try {
      const resultado = await sincronizar(userId);
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
    `${new Date().toISOString().slice(0, 19)}  ${nombre}: ${bien} bibliotecas al día, ${mal} con fallo, ` +
      `${fuentes} fuentes nuevas, en ${minutos} min`,
  );

  return mal;
}

principal()
  .catch((error) => {
    console.error('No se pudieron sincronizar las bibliotecas:', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
