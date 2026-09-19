'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const { AppError, ValidationError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');

/**
 * La Scopus Search API de Elsevier.
 *
 * LO ÚNICO QUE SE LLAMA, Y DE DÓNDE SALE
 * --------------------------------------
 * `GET https://api.elsevier.com/content/search/scopus`, con los parámetros que
 * describe el WADL oficial (`dev.elsevier.com/documentation/ScopusSearchAPI.wadl`):
 * `query`, `start`, `count`, `view`, `sort`. No hay nada inventado aquí, y no
 * se raspa ninguna página: si algo no está en esa especificación, no se pide.
 *
 * LAS TRES CREDENCIALES, Y CUÁL MANDA
 * -----------------------------------
 *   · `X-ELS-APIKey`    — siempre. Es la clave de la casa.
 *   · `X-ELS-Insttoken` — si la hay. Es lo que da entitlement de verdad sin
 *     estar dentro de la red de la universidad, y sin él la respuesta llega
 *     recortada a la vista STANDARD, SIN RESUMEN.
 *   · `Authorization: Bearer` — si el tesista tiene tokens propios por OAuth.
 *     Manda sobre el resto para el contenido al que él tenga derecho.
 *
 * Ninguna de las tres viaja jamás en la URL, aunque la API lo permita: una URL
 * acaba en el registro de acceso del proxy, en el historial y en cualquier
 * informe de error. Van en cabeceras, y de aquí no salen.
 */

const BASE = 'https://api.elsevier.com/content/search/scopus';

/** Cuánto se espera como mucho. Esto ocurre mientras alguien mira la pantalla. */
const TIEMPO_LIMITE_MS = 15_000;

/**
 * Cuántos resultados por página.
 *
 * Veinticinco y no más porque es el techo de la vista COMPLETE —la que trae
 * resumen— en la especificación de Elsevier. STANDARD admite más, pero tener
 * dos tamaños de página según la credencial que haya configurada haría que la
 * paginación de la web cambiara de forma sin motivo visible.
 */
const POR_PAGINA = 25;

/**
 * Hasta dónde se puede paginar.
 *
 * La API rechaza desplazamientos de 5.000 en adelante. No se le pide y se le
 * dice al tesista antes: una búsqueda que devuelve más de cinco mil resultados
 * no es una búsqueda, es un tema sin acotar, y lo que necesita no es otra
 * página sino afinar la ecuación.
 */
const TOPE_DE_DESPLAZAMIENTO = 5000;

/**
 * Los órdenes que se ofrecen, con el valor de `sort` que entiende Elsevier.
 *
 * Probados contra la API el 19-sep-2026. «Más citados» es el de siempre: lo
 * que más ha pesado en su campo, que es lo que pide quien busca antecedentes.
 */
const ORDENES = Object.freeze({
  citas: '-citedby-count',
  recientes: '-coverDate',
  antiguos: '+coverDate',
  relevancia: 'relevancy',
});

/**
 * Los fallos de Elsevier, dichos en palabras del tesista.
 *
 * NUNCA se le reenvía el cuerpo del error tal cual. Elsevier contesta cosas
 * como «Requestor configuration settings insufficient for access to this
 * resource», que no le dice nada a quien está buscando artículos y sí le dice
 * bastante a quien esté probando la configuración de este servidor. Lo que se
 * enseña es qué pasó y qué hacer; el detalle va al registro.
 */
function comoFallo(estado) {
  if (estado === 400) {
    return new ValidationError(
      'Scopus no entiende esa ecuación de búsqueda. Revisa los paréntesis y las comillas: ' +
        'por ejemplo TITLE-ABS-KEY("mobile applications" AND education).',
    );
  }

  if (estado === 401) {
    return new AppError(
      'Scopus no aceptó nuestras credenciales. Es cosa nuestra, no tuya, y ya estamos avisados. ' +
        'Mientras tanto puedes subir tu export de Scopus, que funciona igual.',
      { statusCode: 502, code: ERROR_CODES.SERVICE_UNAVAILABLE },
    );
  }

  if (estado === 403) {
    return new AppError(
      'Scopus no nos deja ver esos resultados: el acceso está atado a la suscripción de una ' +
        'institución. Puedes buscar en Scopus con el acceso de tu universidad y subir aquí el ' +
        'archivo que exportes.',
      { statusCode: 403, code: ERROR_CODES.FORBIDDEN },
    );
  }

  if (estado === 429) {
    return new AppError(
      'Scopus limitó las consultas por ahora. Espera unos minutos y vuelve a buscar.',
      { statusCode: 429, code: ERROR_CODES.TOO_MANY_REQUESTS },
    );
  }

  return new AppError('Scopus no contestó bien. Inténtalo de nuevo en un momento.', {
    statusCode: 502,
    code: ERROR_CODES.SERVICE_UNAVAILABLE,
  });
}

/**
 * Las cabeceras. Se arman aquí y en ningún otro sitio.
 *
 * Que el token esté vencido no se decide aquí: esto solo pone lo que le den.
 * De refrescarlo se ocupa el servicio, que es quien puede guardar el nuevo.
 */
function cabeceras(accessToken) {
  const cabecera = {
    Accept: 'application/json',
    'X-ELS-APIKey': env.ELSEVIER_API_KEY,
  };

  if (env.ELSEVIER_INSTTOKEN) cabecera['X-ELS-Insttoken'] = env.ELSEVIER_INSTTOKEN;
  if (accessToken) cabecera.Authorization = `Bearer ${accessToken}`;

  return cabecera;
}

/**
 * Una página de resultados.
 *
 * Devuelve las fichas EN CRUDO, tal como las manda Elsevier. Traducirlas al
 * modelo de la casa es cosa de `scopus.mapper`: este archivo habla con
 * Elsevier y aquel habla con la base, y mezclarlos obligaría a cambiar los dos
 * cada vez que cambie uno.
 */
async function buscar({
  ecuacion,
  desde = 0,
  cuantas = POR_PAGINA,
  orden = 'citas',
  accessToken = null,
}) {
  if (!env.scopusApiEnabled) {
    throw new AppError('La búsqueda en Scopus no está activada en este servidor.', {
      statusCode: 503,
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
    });
  }

  if (desde >= TOPE_DE_DESPLAZAMIENTO) {
    throw new ValidationError(
      `Scopus no sirve más allá del resultado ${TOPE_DE_DESPLAZAMIENTO}. Acota la búsqueda ` +
        'por años o añade términos: lo que hay más abajo casi nunca es lo que buscabas.',
    );
  }

  const url = new URL(BASE);
  url.searchParams.set('query', ecuacion);
  url.searchParams.set('start', String(desde));
  url.searchParams.set('count', String(Math.min(cuantas, POR_PAGINA)));
  url.searchParams.set('view', env.scopusView);
  // Lo más citado primero si no se pide otra cosa. Un orden desconocido cae
  // también ahí: nunca llega a Elsevier nada que no esté en la lista.
  url.searchParams.set('sort', Object.hasOwn(ORDENES, orden) ? ORDENES[orden] : ORDENES.citas);

  let respuesta;
  try {
    respuesta = await fetch(url, {
      headers: cabeceras(accessToken),
      signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
    });
  } catch (fallo) {
    logger.warn({ err: fallo }, 'Scopus: la petición no llegó a completarse');
    throw new AppError('Scopus tardó demasiado en contestar. Inténtalo otra vez.', {
      statusCode: 504,
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
    });
  }

  const cuerpo = await respuesta.json().catch(() => null);

  if (!respuesta.ok) {
    // El registro lleva el detalle de Elsevier y NUNCA la clave ni el token: no
    // van en la URL —van en cabeceras— así que esto es seguro de anotar.
    logger.warn(
      {
        estado: respuesta.status,
        elsevier: cuerpo?.['service-error'] ?? cuerpo?.['error-response'] ?? null,
        conInsttoken: Boolean(env.ELSEVIER_INSTTOKEN),
        conToken: Boolean(accessToken),
        vista: env.scopusView,
      },
      'Scopus rechazó la búsqueda',
    );
    throw comoFallo(respuesta.status);
  }

  const resultados = cuerpo?.['search-results'] ?? {};
  const fichas = Array.isArray(resultados.entry) ? resultados.entry : [];

  /**
   * Cero resultados no es una lista vacía.
   *
   * Elsevier devuelve UNA ficha con la clave `error` dentro —«Result set was
   * empty»— en vez de una lista sin elementos. Sin esto, una búsqueda sin
   * resultados llegaría a la web como un artículo titulado «undefined».
   */
  const vacio = fichas.length === 1 && fichas[0]?.error;

  return {
    total: Number(resultados['opensearch:totalResults'] ?? 0),
    desde: Number(resultados['opensearch:startIndex'] ?? desde),
    fichas: vacio ? [] : fichas,
  };
}

module.exports = { buscar, POR_PAGINA, TOPE_DE_DESPLAZAMIENTO, ORDENES };
