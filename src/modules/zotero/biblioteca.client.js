'use strict';

const logger = require('../../config/logger');

/**
 * Lectura de la biblioteca de UN tesista.
 *
 * Vive aparte de `references/zotero.client` por la misma razón por la que
 * `propias.repository` vive aparte de `reference.repository`: aquel cliente lee
 * LA biblioteca —una sola, la de la casa, con la clave del `.env`— y este lee la
 * de una persona cualquiera, con la clave que ella autorizó. Fundirlos dejaba un
 * parámetro opcional «y si no, la de la casa» en cada función, que es
 * exactamente el que un día se olvida y hace que un tesista lea el corpus ajeno
 * o, peor, que el corpus se escriba con lo de un tesista.
 *
 * Lo que sí se repite a propósito es la disciplina de esperas: `Backoff` y
 * `Retry-After` no son opcionales. La cuenta que se frena es la del tesista,
 * pero la reputación de la aplicación registrada es una sola y es nuestra.
 */

const BASE = 'https://api.zotero.org';
const API_VERSION = '3';
const POR_PAGINA = 100;

/** Ni adjuntos ni notas: no son fuentes y no se citan. */
const SOLO_FUENTES = '-attachment || -note';

async function respetarEspera(res) {
  const segundos = Number(res.headers.get('backoff') ?? res.headers.get('retry-after') ?? 0);
  if (!Number.isFinite(segundos) || segundos <= 0) return false;

  logger.warn({ segundos }, 'Zotero pide esperar antes de la siguiente petición');
  await new Promise((cumplir) => setTimeout(cumplir, Math.min(segundos, 60) * 1000));
  return true;
}

/**
 * Una petición a la biblioteca de este tesista.
 *
 * El 403 se traduce aquí y no arriba: es el único error de Zotero que significa
 * algo concreto para el tesista —revocó la clave desde su cuenta— y el que hay
 * que saber distinguir para poder decirle «vuelve a conectar» en vez de «error
 * 403».
 */
async function pedir(contexto, ruta, params = {}) {
  const url = new URL(`${BASE}/users/${contexto.zoteroUserId}${ruta}`);
  for (const [clave, valor] of Object.entries(params)) {
    if (valor !== undefined && valor !== null && valor !== '') {
      url.searchParams.set(clave, String(valor));
    }
  }

  const cabeceras = {
    'Zotero-API-Key': contexto.apiKey,
    'Zotero-API-Version': API_VERSION,
  };

  let res = await fetch(url, { headers: cabeceras });

  if (res.status === 429 || res.status === 503) {
    if (await respetarEspera(res)) res = await fetch(url, { headers: cabeceras });
  } else {
    await respetarEspera(res);
  }

  if (res.status === 403) {
    const fallo = new Error('Zotero ya no acepta esta conexión.');
    fallo.revocada = true;
    throw fallo;
  }

  if (!res.ok) {
    const detalle = await res.text().catch(() => '');
    throw new Error(`Zotero respondió ${res.status}: ${detalle.slice(0, 200)}`);
  }

  return {
    res,
    datos: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text(),
    versionBiblioteca: Number(res.headers.get('last-modified-version') ?? 0),
    total: Number(res.headers.get('total-results') ?? 0),
  };
}

/**
 * Sus colecciones, para que elija una.
 *
 * Se devuelven TODAS y en plano, con el nombre del padre delante cuando la
 * colección está anidada: «Tesis › Antecedentes». Un árbol quedaría más bonito
 * y obligaría a pintar un árbol en el panel para elegir una sola cosa.
 */
async function colecciones(contexto) {
  const todas = [];
  let inicio = 0;

  for (;;) {
    const { datos, total } = await pedir(contexto, '/collections', {
      format: 'json',
      limit: POR_PAGINA,
      start: inicio,
    });

    if (!Array.isArray(datos) || datos.length === 0) break;

    for (const fila of datos) {
      todas.push({
        clave: fila.key,
        nombre: String(fila.data?.name ?? '').slice(0, 200),
        padre: fila.data?.parentCollection || null,
        cuantas: Number(fila.meta?.numItems ?? 0),
      });
    }

    inicio += POR_PAGINA;
    if (datos.length < POR_PAGINA || inicio >= total) break;
  }

  const porClave = new Map(todas.map((c) => [c.clave, c]));
  const conCamino = todas.map((coleccion) => {
    const camino = [coleccion.nombre];
    let padre = coleccion.padre;
    // Tope de profundidad: una colección que se tenga a sí misma por antepasado
    // —no debería pasar, pero es la base de datos de otro— colgaría el bucle.
    for (let saltos = 0; padre && saltos < 10; saltos += 1) {
      const arriba = porClave.get(padre);
      if (!arriba) break;
      camino.unshift(arriba.nombre);
      padre = arriba.padre;
    }
    return { clave: coleccion.clave, nombre: camino.join(' › '), cuantas: coleccion.cuantas };
  });

  return conCamino.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

/**
 * Los ítems de una colección, página a página.
 *
 * Se cede cada página en vez de juntarlas: la biblioteca de un tesista es
 * pequeña, pero este mismo código corre para todos y de noche, y acumular en
 * memoria «porque son pocos» es cómo se muere un VPS pequeño el día que alguien
 * conecta una colección de diez mil.
 */
async function* paginasDeItems(contexto, { collectionKey, desdeVersion = 0 }) {
  let inicio = 0;
  let total = null;

  for (;;) {
    const respuesta = await pedir(contexto, `/collections/${collectionKey}/items`, {
      format: 'json',
      limit: POR_PAGINA,
      start: inicio,
      since: desdeVersion || undefined,
      itemType: SOLO_FUENTES,
    });

    if (total === null) total = respuesta.total;
    if (!Array.isArray(respuesta.datos) || respuesta.datos.length === 0) break;

    yield { items: respuesta.datos, versionBiblioteca: respuesta.versionBiblioteca, total };

    inicio += POR_PAGINA;
    if (respuesta.datos.length < POR_PAGINA || inicio >= total) break;
  }
}

/**
 * Las claves que hay AHORA MISMO en la colección, en una sola petición.
 *
 * POR QUÉ ESTO Y NO `/deleted`
 * ----------------------------
 * El corpus de la casa se limpia preguntando por lo borrado desde tal versión, y
 * ahí es correcto: lo que sale de la biblioteca es porque se borró.
 *
 * En una colección no. El tesista SACA una fuente de su colección de tesis
 * mucho más a menudo de lo que la borra de Zotero —la descarta, la mueve a
 * «descartadas»— y para `/deleted` eso no ha ocurrido: el ítem sigue vivo en su
 * biblioteca. Sincronizando por `/deleted`, esa fuente se quedaría citable aquí
 * para siempre, y el tesista la vería aparecer en su bibliografía después de
 * haberla quitado a propósito.
 *
 * `format=keys` devuelve la lista entera como texto, una clave por línea: para
 * doscientas fuentes es una petición y cuatro kilobytes. Comparar contra eso
 * cubre a la vez lo borrado, lo sacado de la colección y cualquier desajuste que
 * hubiera dejado una pasada anterior a medias.
 */
async function clavesDeLaColeccion(contexto, collectionKey) {
  const { datos } = await pedir(contexto, `/collections/${collectionKey}/items`, {
    format: 'keys',
    itemType: SOLO_FUENTES,
  });

  return String(datos)
    .split('\n')
    .map((linea) => linea.trim())
    .filter(Boolean);
}

module.exports = { colecciones, paginasDeItems, clavesDeLaColeccion, POR_PAGINA };
