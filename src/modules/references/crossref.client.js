'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');

const BASE = 'https://api.crossref.org/works';

/**
 * Crossref, y solo para lo que Crossref hace mejor que nadie.
 *
 * QUÉ ES Y QUÉ NO ES
 * ------------------
 * Es el registro donde el EDITOR deposita el DOI, así que es la autoridad sobre
 * los datos de la cita: revista, volumen, número y páginas. Lo que no es, es un
 * buscador: casi no tiene resúmenes, y sin resumen una fuente aquí vale poco
 * porque el asistente solo podría encontrarla por el título. Para buscar está
 * OpenAlex, que además está construido encima de esto mismo.
 *
 * Por eso este cliente tiene UNA función y consulta POR DOI. No hay `buscar`.
 *
 * PARA QUÉ SE USA, EN CONCRETO
 * ----------------------------
 * Para completar lo que llega cojo. Una fuente que entra solo con su DOI —las
 * de los PDF— o cuyo export no traía volumen y páginas sale sin ellos, y una
 * referencia de revista sin volumen, número y páginas NO está completa en APA.
 * Es de lo primero que mira un asesor.
 *
 * Y de paso es la red de seguridad de OpenAlex: lo recién publicado tarda días
 * en aparecer allí y el DOI existe en Crossref desde el primer minuto.
 *
 * SIN CLAVE Y SIN CUENTA. Solo pide identificarse con un correo para entrar en
 * el grupo de tráfico educado, igual que OpenAlex.
 */

const TIEMPO_LIMITE_MS = 8_000;

function contacto() {
  return env.OPENALEX_MAILTO || env.MAIL_FROM;
}

/** «10.1234/abc» a partir de un DOI escrito de cualquiera de sus formas. */
function limpiarDoi(crudo) {
  const texto = String(crudo ?? '').trim();
  if (!texto) return null;
  const sinPrefijo = texto
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim();
  return /^10\.\d{4,9}\//.test(sinPrefijo) ? sinPrefijo : null;
}

/**
 * El resumen viene en JATS, que es XML con etiquetas dentro.
 *
 * Se quitan las etiquetas y se deja el texto. No se intenta nada más fino:
 * Crossref lo trae pocas veces y cuando lo trae es un párrafo suelto.
 */
function textoDelResumen(jats) {
  if (!jats) return null;
  const limpio = String(jats)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return limpio || null;
}

/** «Hernández, R.; Fernández, C.», que es como lo espera el resto del código. */
function autores(lista = []) {
  return lista
    .map((persona) => {
      const apellido = String(persona.family ?? '').trim();
      const nombre = String(persona.given ?? '').trim();
      if (!apellido) return String(persona.name ?? '').trim();
      return nombre ? `${apellido}, ${nombre.charAt(0)}.` : apellido;
    })
    .filter(Boolean)
    .join('; ');
}

function anio(mensaje) {
  const partes =
    mensaje.issued?.['date-parts']?.[0] ??
    mensaje['published-print']?.['date-parts']?.[0] ??
    mensaje['published-online']?.['date-parts']?.[0] ??
    [];
  const valor = Number(partes[0]);
  return Number.isInteger(valor) ? valor : null;
}

/**
 * La ficha de un DOI, o nulo.
 *
 * El 404 es información y no un fallo: ese DOI no está registrado en Crossref
 * —pasa con los de DataCite, por ejemplo— y no lo va a estar por reintentar.
 */
async function porDoi(crudo) {
  const doi = limpiarDoi(crudo);
  if (!doi) return null;

  const url = new URL(`${BASE}/${encodeURIComponent(doi)}`);
  const correo = contacto();
  if (correo) url.searchParams.set('mailto', correo);

  const corte = AbortSignal.timeout(TIEMPO_LIMITE_MS);
  const res = await fetch(url, {
    signal: corte,
    headers: correo
      ? { 'User-Agent': `AcostaResearch/1.0 (mailto:${correo})` }
      : {},
  }).catch((error) => {
    logger.warn({ err: error, doi }, 'Crossref no respondió a tiempo');
    return null;
  });

  if (!res || res.status === 404) return null;

  if (!res.ok) {
    logger.warn({ estado: res.status, doi }, 'Crossref rechazó la consulta por DOI');
    return null;
  }

  const cuerpo = await res.json().catch(() => null);
  const m = cuerpo?.message;
  if (!m) return null;

  const titulo = Array.isArray(m.title) ? m.title[0] : m.title;
  if (!titulo) return null;

  return {
    doi,
    title: String(titulo).trim(),
    authors: autores(m.author),
    year: anio(m),
    // `container-title` es el nombre de la revista o del libro que la contiene.
    source: (Array.isArray(m['container-title']) ? m['container-title'][0] : null) ?? null,
    volume: m.volume ? String(m.volume) : null,
    issue: m.issue ? String(m.issue) : null,
    // Crossref lo llama `page` y ya viene como rango: «45-62».
    pages: m.page ? String(m.page).replace(/\s*[-–—]+\s*/, '-') : null,
    abstract: textoDelResumen(m.abstract),
    url: m.URL ?? null,
    itemType: m.type ?? 'journal-article',
  };
}

/**
 * Rellena los huecos de una ficha, sin pisar nada de lo que ya tenía.
 *
 * Ese «sin pisar» es la regla y no un detalle: lo que ya está vino del export
 * del tesista o de su Zotero, donde alguien lo revisó, y Crossref se equivoca
 * a veces con los nombres de las revistas abreviadas. Aquí solo se completa.
 *
 * No se llama si no falta nada: son unos cientos de milisegundos y una petición
 * a un servicio ajeno por cada fuente.
 */
async function completar(ficha) {
  const faltan = !ficha.volume || !ficha.pages || !ficha.source;
  if (!faltan || !ficha.doi) return ficha;

  const suyo = await porDoi(ficha.doi);
  if (!suyo) return ficha;

  return {
    ...ficha,
    source: ficha.source || suyo.source,
    volume: ficha.volume || suyo.volume,
    issue: ficha.issue || suyo.issue,
    pages: ficha.pages || suyo.pages,
    abstract: ficha.abstract || suyo.abstract,
  };
}

module.exports = { porDoi, completar, limpiarDoi };
