'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');

const BASE = 'https://api.openalex.org/works';

/**
 * Búsqueda en vivo en OpenAlex.
 *
 * POR QUÉ ESTO Y NO LA API DE SCOPUS
 * ----------------------------------
 * Porque la de Scopus no se puede usar desde aquí. Elsevier ata el acceso de
 * verdad a la RED de una institución suscrita: la clave se registra gratis, pero
 * desde la IP de un servidor en Hetzner no hay suscripción que valga y lo que
 * devuelve es metadato recortado o nada. Es el mismo muro que obliga a entrar
 * por la VPN de la universidad para leer un artículo.
 *
 * OpenAlex cubre el mismo terreno —327 millones de trabajos— sin clave y sin
 * cuota institucional, e indexa Scielo, Redalyc y repositorios latinoamericanos
 * que Scopus ni siquiera tiene. Para un tesista peruano que necesita
 * antecedentes nacionales, eso no es un consuelo: es mejor.
 *
 * Lo que sí pierde: sus palabras clave las asigna un clasificador, no un autor.
 * Da igual aquí —se busca sobre título y resumen— pero importa en el análisis
 * bibliométrico, y por eso allí se declara.
 */

/** Cuánto se espera como mucho. Va dentro de un turno de conversación. */
const TIEMPO_LIMITE_MS = 12_000;

/**
 * El correo identifica la petición y da acceso al grupo de tráfico rápido.
 *
 * No es cortesía: sin él, OpenAlex sirve por la cola lenta y la búsqueda tarda
 * lo bastante como para que el tesista crea que el conector se colgó.
 */
function contacto() {
  return env.OPENALEX_MAILTO || env.MAIL_FROM;
}

/**
 * Rehace el resumen desde el índice invertido.
 *
 * OpenAlex no guarda el resumen como texto seguido: guarda cada palabra con las
 * posiciones donde aparece, por cómo están licenciados los resúmenes. Deshacerlo
 * es contar hasta la posición más alta y colocar cada palabra en su sitio.
 *
 * Sin esto, el tesista recibiría una ficha sin resumen, que es media ficha: por
 * el resumen es por donde decide si la fuente le sirve.
 */
function resumenDelIndice(indice) {
  if (!indice || typeof indice !== 'object') return null;

  const palabras = [];
  for (const [palabra, posiciones] of Object.entries(indice)) {
    for (const posicion of posiciones) palabras[posicion] = palabra;
  }

  const texto = palabras.filter(Boolean).join(' ').trim();
  return texto || null;
}

/** Autores en formato de cita, igual que los del fondo de la casa. */
function autores(authorships = []) {
  return authorships
    .slice(0, 8)
    .map((a) => {
      const nombre = a?.author?.display_name;
      if (!nombre) return null;
      // «Christian Díaz Peralta» → «Díaz Peralta, C.»
      const partes = nombre.trim().split(/\s+/);
      if (partes.length === 1) return partes[0];
      const inicial = `${partes[0].charAt(0)}.`;
      return `${partes.slice(1).join(' ')}, ${inicial}`;
    })
    .filter(Boolean)
    .join('; ');
}

/**
 * Busca y devuelve fichas ya listas para citar.
 *
 * `idioma` y `pais` son lo que hace útil esto para una tesis peruana: los
 * antecedentes nacionales se piden acotando por país, que es exactamente la
 * pregunta del jurado —«¿y qué se ha estudiado sobre esto en el Perú?»— y la
 * que el fondo de la casa no puede responder porque es casi todo en inglés.
 */
async function buscar({ tema, idioma = null, pais = null, desdeAnio = null, cuantas = 6 }) {
  const url = new URL(BASE);
  url.searchParams.set('search', tema);
  url.searchParams.set('per_page', String(Math.min(Math.max(cuantas, 1), 25)));
  url.searchParams.set('mailto', contacto());

  const filtros = ['type:article'];
  if (idioma) filtros.push(`language:${idioma}`);
  if (pais) filtros.push(`authorships.institutions.country_code:${pais.toLowerCase()}`);
  if (desdeAnio) filtros.push(`from_publication_date:${desdeAnio}-01-01`);
  url.searchParams.set('filter', filtros.join(','));

  const corte = AbortSignal.timeout(TIEMPO_LIMITE_MS);
  const res = await fetch(url, { signal: corte }).catch((error) => {
    logger.warn({ err: error, tema }, 'OpenAlex no respondió a tiempo');
    return null;
  });

  if (!res) return { fuentes: [], total: 0, caida: true };

  if (!res.ok) {
    const detalle = await res.text().catch(() => '');
    // La búsqueda anónima de OpenAlex se pausa a veces mientras su servidor se
    // recupera; los filtros siguen funcionando. No es culpa de nadie y no debe
    // parecer un fallo del conector.
    logger.warn({ estado: res.status, detalle: detalle.slice(0, 160) }, 'OpenAlex rechazó la búsqueda');
    return { fuentes: [], total: 0, caida: true };
  }

  const datos = await res.json();

  const fuentes = (datos.results ?? []).map((w) => ({
    titulo: w.title ?? '(sin título)',
    autores: autores(w.authorships) || '(Autor no consignado)',
    anio: w.publication_year ?? null,
    revista: w.primary_location?.source?.display_name ?? null,
    doi: w.doi ? String(w.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') : null,
    citas: w.cited_by_count ?? 0,
    idioma: w.language ?? null,
    /** Si hay PDF libre. El tesista puede leerlo entero, no solo el resumen. */
    pdfLibre: w.best_oa_location?.pdf_url ?? null,
    resumen: resumenDelIndice(w.abstract_inverted_index),
  }));

  return { fuentes, total: datos.meta?.count ?? fuentes.length, caida: false };
}

module.exports = { buscar, resumenDelIndice };
