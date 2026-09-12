'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');

const BASE = 'https://api.zotero.org';
/** La versión del formato. Sin esta cabecera, Zotero sirve un esquema antiguo. */
const API_VERSION = '3';
/** El máximo que acepta la API por página. */
const POR_PAGINA = 100;

/**
 * Cliente de lectura de la API web de Zotero.
 *
 * Solo hace GET. No es una limitación de este archivo, es el diseño: la clave
 * que usa se crea sin permiso de escritura, así que un POST devolvería 403
 * aunque alguien lo escribiera aquí por error.
 */

function cabeceras() {
  return {
    'Zotero-API-Key': env.ZOTERO_API_KEY,
    'Zotero-API-Version': API_VERSION,
  };
}

/**
 * Espera lo que pida Zotero antes de seguir.
 *
 * `Backoff` es una petición de que bajemos el ritmo; `Retry-After` acompaña a un
 * 429 o un 503 y es obligatorio. Ignorarlos hace que Zotero bloquee la cuenta
 * entera, y la cuenta es una para todos los clientes: no es un fallo que se
 * pueda reintentar a ciegas. Con una biblioteca de 24.000 fuentes, la primera
 * sincronización son cientos de peticiones seguidas y esto SÍ se dispara.
 */
async function respetarEspera(res) {
  const segundos = Number(res.headers.get('backoff') ?? res.headers.get('retry-after') ?? 0);
  if (!Number.isFinite(segundos) || segundos <= 0) return false;

  logger.warn({ segundos }, 'Zotero pide esperar antes de la siguiente petición');
  await new Promise((cumplir) => setTimeout(cumplir, Math.min(segundos, 60) * 1000));
  return true;
}

async function pedir(ruta, params = {}) {
  const url = new URL(`${BASE}/${env.zoteroLibrary}${ruta}`);
  for (const [clave, valor] of Object.entries(params)) {
    if (valor !== undefined && valor !== null && valor !== '') {
      url.searchParams.set(clave, String(valor));
    }
  }

  let res = await fetch(url, { headers: cabeceras() });

  // Un solo reintento: si tras esperar lo que pidió sigue diciendo que no, es
  // un problema de verdad y conviene que la sincronización falle a la vista.
  if (res.status === 429 || res.status === 503) {
    if (await respetarEspera(res)) res = await fetch(url, { headers: cabeceras() });
  } else {
    await respetarEspera(res);
  }

  if (!res.ok) {
    const detalle = await res.text().catch(() => '');
    throw new Error(`Zotero respondió ${res.status}: ${detalle.slice(0, 200)}`);
  }

  return {
    datos: await res.json(),
    versionBiblioteca: Number(res.headers.get('last-modified-version') ?? 0),
    total: Number(res.headers.get('total-results') ?? 0),
  };
}

/**
 * Recorre una consulta de ítems PÁGINA A PÁGINA, sin juntarlas.
 *
 * Antes esto devolvía un array con todo dentro, y con una biblioteca de prueba
 * daba igual. Con la de verdad no: 48.000 ítems de Zotero en memoria a la vez
 * son cientos de megas de objetos en un VPS pequeño, y el proceso se muere
 * antes de escribir la primera fila. Cediendo cada página, la memoria que se
 * usa es siempre la de cien ítems.
 *
 * `filtro.itemType` acepta la sintaxis de Zotero, negaciones incluidas:
 * `-attachment || note` deja fuera lo que no es una fuente.
 *
 * OJO CON EL MENOS: niega la expresión ENTERA, no cada término. Se lee «ni
 * attachment ni note». Este comentario decía `-attachment || -note`, que es lo
 * que parece que habría que escribir y devuelve 400 «Invalid itemType '-note'»
 * — y un módulo nuevo lo copió de aquí y se estrenó en producción con ese 400.
 */
async function* paginasDeItems({ desdeVersion = 0, itemType = '', alAvanzar } = {}) {
  let inicio = 0;
  let total = null;

  for (;;) {
    const respuesta = await pedir('/items', {
      format: 'json',
      limit: POR_PAGINA,
      start: inicio,
      since: desdeVersion || undefined,
      itemType,
    });

    if (total === null) total = respuesta.total;
    if (respuesta.datos.length === 0) break;

    yield { items: respuesta.datos, versionBiblioteca: respuesta.versionBiblioteca, total };

    inicio += POR_PAGINA;
    if (typeof alAvanzar === 'function') alAvanzar(Math.min(inicio, total), total);
    if (respuesta.datos.length < POR_PAGINA || inicio >= total) break;
  }
}

/** Cuántos ítems devolvería una consulta, sin traérselos. */
async function contar(itemType = '') {
  const { total, versionBiblioteca } = await pedir('/items', { format: 'json', limit: 1, itemType });
  return { total, versionBiblioteca };
}

/**
 * Las claves de lo borrado desde una versión.
 *
 * Sin esto, una fuente retirada de Zotero seguiría citándose desde el conector
 * para siempre: la lista de modificados no menciona lo que ya no existe.
 */
async function listarBorrados(desdeVersion) {
  if (!desdeVersion) return [];
  const { datos } = await pedir('/deleted', { since: desdeVersion });
  return Array.isArray(datos?.items) ? datos.items : [];
}

module.exports = { paginasDeItems, contar, listarBorrados, POR_PAGINA };
