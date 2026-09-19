'use strict';

const logger = require('../../config/logger');
const openalex = require('./openalex.client');
const unpaywall = require('./unpaywall.client');

/**
 * Dónde se lee gratis y legalmente cada artículo de una lista de resultados.
 *
 * QUÉ PROBLEMA RESUELVE
 * ---------------------
 * El buscador enseñaba la etiqueta «Acceso abierto» —Scopus la da— y ahí se
 * quedaba: el tesista sabía que el artículo era gratis pero no dónde estaba.
 * Lo que le quedaba era ir a la editorial, chocarse con el muro de pago y
 * buscar el PDF a mano por su cuenta. Esto le pone el enlace al lado del
 * título.
 *
 * DE DÓNDE SALE, Y POR QUÉ EN ESE ORDEN
 * -------------------------------------
 * 1. **OpenAlex**, en UNA consulta para toda la página. Es el que ya se usa
 *    aquí para todo lo demás, tiene clave nuestra y cubre casi todo.
 * 2. **Unpaywall**, y solo por los DOI que OpenAlex no conoce. Los dos beben
 *    de la misma fuente —OpenAlex ingiere Unpaywall— así que preguntar por
 *    todos sería gastar veinticinco peticiones para confirmar lo ya sabido.
 *    Donde sí discrepan es en lo recién depositado, que tarda semanas en
 *    llegar a OpenAlex y es justo el artículo de este año que el tesista está
 *    buscando.
 *
 * Nada de esto pide permiso a nadie ni toca la cuota de Elsevier: son dos
 * catálogos abiertos, y el enlace que devuelven apunta a la copia que el
 * propio editor o el repositorio pusieron en abierto. No se aloja, no se
 * copia y no se guarda ningún PDF: se enseña a dónde ir.
 *
 * SI FALLA, NO SE NOTA
 * --------------------
 * Todo falla hacia el silencio. Si ninguno de los dos contesta se devuelve un
 * `Map` vacío, los resultados salen como salían antes y en el registro queda
 * por qué. Un enlace de cortesía no puede tumbar una búsqueda que ya costó una
 * petición de la cuota semanal de Scopus.
 */

/**
 * Los enlaces abiertos de unos DOI, de los dos catálogos.
 *
 * Devuelve un `Map` de DOI en minúsculas a `{ url, esPdf, version, licencia,
 * donde, catalogo }`. Los que no tienen copia abierta no están.
 */
async function porDois(dois, { catalogo = openalex, respaldo = unpaywall } = {}) {
  const pedidos = [...new Set(dois.map((d) => String(d ?? '').trim().toLowerCase()).filter(Boolean))];
  if (!pedidos.length) return new Map();

  const deOpenAlex = await preguntar(catalogo, pedidos, 'OpenAlex');

  const enlaces = new Map();
  for (const [doi, enlace] of deOpenAlex) {
    if (enlace) enlaces.set(doi, { ...enlace, catalogo: 'openalex' });
  }

  /**
   * A Unpaywall solo los desconocidos.
   *
   * `deOpenAlex.has(doi)` es la pregunta exacta: si OpenAlex contestó por esa
   * obra —con enlace o sin él— su respuesta vale y no se vuelve a preguntar.
   * Los que faltan son los que ninguno de los dos habría tenido hace un mes y
   * uno de los dos puede tener hoy.
   */
  const desconocidos = pedidos.filter((doi) => !deOpenAlex.has(doi));
  if (!desconocidos.length) return enlaces;

  const deUnpaywall = await preguntar(respaldo, desconocidos, 'Unpaywall');

  for (const [doi, enlace] of deUnpaywall) {
    if (enlace) enlaces.set(doi, { ...enlace, catalogo: 'unpaywall' });
  }

  return enlaces;
}

/**
 * Le pregunta a un catálogo, y se traga lo que pase.
 *
 * El `Promise.resolve().then()` no es adorno: envuelve también el fallo
 * SÍNCRONO —que el catálogo no sea lo que se esperaba y ni siquiera devuelva
 * una promesa—, que un `.catch()` suelto dejaría escapar. Es la diferencia
 * entre una búsqueda sin enlaces y una búsqueda que revienta, y aquí la regla
 * es que esto nunca puede tumbar una búsqueda.
 */
async function preguntar(catalogo, dois, nombre) {
  const respuesta = await Promise.resolve()
    .then(() => catalogo.enlacesAbiertosPorDoi(dois))
    .catch((fallo) => {
      logger.warn({ err: fallo.message }, `Enlace abierto: ${nombre} no contestó`);
      return null;
    });

  // Y si contestó cualquier otra cosa, tampoco: aquí solo se sale con un Map.
  return respuesta instanceof Map ? respuesta : new Map();
}

/**
 * Pega el enlace abierto a cada resultado que tenga DOI.
 *
 * Deja el resultado tal cual si no hay copia abierta: `enlaceAbierto` queda en
 * nulo y la vista no enseña nada. No se inventa un enlace ni se apunta a la
 * editorial haciéndolo pasar por abierto, que es lo mismo que mentirle al
 * tesista sobre si va a poder leerlo.
 *
 * `mismoQueEditorial` marca los casos en que la copia abierta está en la
 * propia página del editor y el enlace coincide con el `https://doi.org/…` que
 * la tabla ya enseña. El dato sigue sirviendo —dice que ahí se lee gratis—
 * pero un segundo botón al mismo sitio sobra, y la vista lo usa para no
 * repetirlo.
 */
async function pegarALosResultados(resultados, opciones = {}) {
  const dois = resultados.map((r) => r?.doi).filter(Boolean);
  /**
   * Sin un solo DOI no hay a quién preguntar, pero el campo se pone igual.
   *
   * Que `enlaceAbierto` sea SIEMPRE `null` o un enlace, y nunca `undefined`,
   * es lo que permite a la vista y a quien lea la respuesta tratar un caso
   * solo: «no hay copia abierta». Distinguir «no hay» de «no se preguntó» no
   * le sirve a nadie aquí y obligaría a comprobar dos cosas en cada sitio.
   */
  const enlaces = dois.length ? await porDois(dois, opciones) : new Map();

  return resultados.map((resultado) => {
    const enlace = resultado.doi ? enlaces.get(String(resultado.doi).toLowerCase()) : null;
    if (!enlace) return { ...resultado, enlaceAbierto: null };

    return {
      ...resultado,
      enlaceAbierto: {
        ...enlace,
        mismoQueEditorial: esLaMismaPaginaQueElDoi(enlace.url, resultado.doi),
      },
    };
  });
}

/** Si ese enlace es el `https://doi.org/<doi>` que la vista ya tiene puesto. */
function esLaMismaPaginaQueElDoi(url, doi) {
  const suelto = String(url ?? '')
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  return suelto.toLowerCase() === String(doi ?? '').trim().toLowerCase();
}

module.exports = { porDois, pegarALosResultados, esLaMismaPaginaQueElDoi };
