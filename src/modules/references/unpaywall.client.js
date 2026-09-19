'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');

const BASE = 'https://api.unpaywall.org/v2';

/**
 * Unpaywall: el refuerzo de OpenAlex para saber dónde se lee un artículo gratis.
 *
 * POR QUÉ HAY UN SEGUNDO SITIO AL QUE PREGUNTAR
 * --------------------------------------------
 * OpenAlex ingiere los datos de Unpaywall, así que casi siempre saben lo mismo
 * y preguntar dos veces sería tonto. Casi. Lo que OpenAlex no tiene todavía es
 * lo recién depositado: entre que un repositorio sube el PDF y que OpenAlex lo
 * refleja pasan semanas, y Unpaywall lo sabe antes. Para un artículo de este
 * año —que es justo el que el tesista está buscando— esa diferencia decide
 * entre leerlo o no.
 *
 * POR QUÉ SE PREGUNTA POR TAN POCOS
 * ---------------------------------
 * Unpaywall NO tiene consulta por lotes en su API abierta: es un DOI, una
 * petición. Una página de resultados son veinticinco, y preguntar por los
 * veinticinco convertiría cada búsqueda en veinticinco peticiones a un
 * servicio ajeno y gratuito, que es justo como se pierde el acceso a un
 * servicio ajeno y gratuito.
 *
 * Por eso solo se le pregunta por los que OpenAlex NO CONOCE —no por los que
 * conoce sin copia abierta, donde ya dio su respuesta— y como mucho por
 * `TOPE_POR_BUSQUEDA`. El resto se queda sin enlace, que es exactamente lo que
 * pasaba antes de todo esto.
 *
 * SI NO CONTESTA, NO PASA NADA
 * ----------------------------
 * Todo lo de aquí falla hacia el silencio: si Unpaywall no responde, responde
 * mal o tarda, se devuelve un `Map` vacío y la búsqueda sigue su camino. Un
 * enlace de cortesía no puede tumbar un buscador.
 */

/** Cuánto se espera. Corto a propósito: esto pasa dentro de una búsqueda. */
const TIEMPO_LIMITE_MS = 5_000;

/**
 * Cuántos DOI se le preguntan como mucho en una búsqueda.
 *
 * Diez y no veinticinco. Son peticiones sueltas contra un servicio gratuito, y
 * los que llegan aquí ya son los que OpenAlex no conoce: en una página normal
 * son dos o tres, y el tope solo se nota en las búsquedas raras.
 */
const TOPE_POR_BUSQUEDA = 10;

/**
 * Unpaywall exige un correo en cada petición y lo dice en su documentación.
 * Es el mismo trato que OpenAlex: identifícate y te atiendo bien.
 */
function contacto() {
  return env.UNPAYWALL_MAILTO || env.OPENALEX_MAILTO || env.MAIL_FROM;
}

/** Un DOI limpio, venga como identificador o como enlace. */
function limpiarDoi(crudo) {
  const valor = String(crudo ?? '').trim();
  if (!valor) return null;
  const limpio = valor.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  return /^10\.\d{4,9}\/\S+$/.test(limpio) ? limpio : null;
}

/**
 * La copia abierta de un DOI, o nulo.
 *
 * Misma forma que la de `openalex.enlacesAbiertosPorDoi`, a propósito: quien
 * las junta no tiene que saber de cuál de los dos vino cada una.
 */
async function porDoi(doi) {
  const url = new URL(`${BASE}/${encodeURIComponent(doi)}`);
  url.searchParams.set('email', contacto());

  const res = await fetch(url, { signal: AbortSignal.timeout(TIEMPO_LIMITE_MS) }).catch(() => null);
  // El 404 es una respuesta, no un fallo: significa que ese DOI no lo conoce.
  if (!res || !res.ok) return null;

  const datos = await res.json().catch(() => null);
  const mejor = datos?.best_oa_location;
  if (!datos?.is_oa || !mejor) return null;

  const enlace = mejor.url_for_pdf || mejor.url || null;
  if (!enlace) return null;

  return {
    url: enlace,
    esPdf: Boolean(mejor.url_for_pdf) && enlace === mejor.url_for_pdf,
    version: mejor.version ?? null,
    licencia: mejor.license ?? null,
    donde: mejor.repository_institution || datos.journal_name || null,
  };
}

/**
 * Las copias abiertas de unos cuantos DOI, en peticiones sueltas y a la vez.
 *
 * Devuelve un `Map` de DOI en minúsculas a su enlace. Los que no tienen, o los
 * que no se pudieron preguntar porque se pasó el tope, no están.
 */
async function enlacesAbiertosPorDoi(dois) {
  const limpios = [...new Set(dois.map(limpiarDoi).filter(Boolean))].slice(0, TOPE_POR_BUSQUEDA);
  if (!limpios.length) return new Map();

  const enlaces = new Map();
  const respuestas = await Promise.all(
    limpios.map((doi) =>
      porDoi(doi).catch((fallo) => {
        logger.debug({ doi, err: fallo.message }, 'Unpaywall no contestó por este DOI');
        return null;
      }),
    ),
  );

  limpios.forEach((doi, i) => {
    if (respuestas[i]) enlaces.set(doi.toLowerCase(), respuestas[i]);
  });

  return enlaces;
}

module.exports = { enlacesAbiertosPorDoi, porDoi, limpiarDoi, TOPE_POR_BUSQUEDA };
