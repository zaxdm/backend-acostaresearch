'use strict';

/**
 * Lo que comparten las bases externas del buscador del panel (Semantic Scholar,
 * PubMed, ERIC, CORE…). Cada una vive en su archivo de esta carpeta y cumple el
 * mismo contrato, que está en `index.js`.
 */

const logger = require('../../config/logger');
const openalex = require('../references/openalex.client');

/** Ninguna base externa puede colgar la búsqueda del tesista más que esto. */
const TIEMPO_LIMITE_MS = 10_000;

/**
 * La clave opcional de una base, del `.env`.
 *
 * Se lee aquí y no en `config/env.js` a propósito: todas son opcionales (sin
 * clave la base funciona con su cupo gratuito, o se apaga sola si la exige) y
 * así añadir una base no obliga a tocar la validación del arranque.
 */
function clave(nombre) {
  const valor = String(process.env[nombre] ?? '').trim();
  return valor || null;
}

/** El correo con el que nos identificamos ante las bases que lo piden. */
function contacto() {
  return clave('OPENALEX_MAILTO') || clave('MAIL_FROM') || 'contacto@acostaresearch.com';
}

/**
 * GET con tope de tiempo. Devuelve `{ ok, status, json | texto }` o `null` si
 * no contestó. Nunca lanza: una base caída no puede tumbar la búsqueda.
 */
async function pedir(url, { base, headers = {}, comoTexto = false, tiempoMs = TIEMPO_LIMITE_MS } = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': `AcostaResearch/1.0 (mailto:${contacto()})`, ...headers },
      signal: AbortSignal.timeout(tiempoMs),
    });
  } catch (error) {
    logger.warn({ err: error, base }, `${base} no respondió`);
    return null;
  }
  if (!res.ok) {
    const detalle = await res.text().catch(() => '');
    logger.warn({ base, estado: res.status, detalle: detalle.slice(0, 160) }, `${base} rechazó la búsqueda`);
    return { ok: false, status: res.status };
  }
  if (comoTexto) return { ok: true, status: res.status, texto: await res.text().catch(() => '') };
  const json = await res.json().catch(() => null);
  return json ? { ok: true, status: res.status, json } : null;
}

/** «Reason, Beth Anne» → «Reason, B. A.»; «Smith, J.» se queda igual. */
function conComa(nombre) {
  const [apellido, ...resto] = nombre.split(',');
  const nombres = resto.join(' ').trim();
  if (!nombres) return apellido.trim();
  const iniciales = nombres
    .split(/[\s.]+/)
    .filter(Boolean)
    .map((p) => (p.includes('-') ? p.split('-').map((q) => `${q[0]}.`).join('-') : `${p[0]}.`))
    .join(' ');
  return `${apellido.trim()}, ${iniciales.toUpperCase()}`;
}

/** «Rosa Isabel Tecocha Portocarrero» → «Tecocha Portocarrero, R. I.», hasta ocho, con «; ». */
function autoresApa(nombres = []) {
  return (
    nombres
      .map((n) => String(n ?? '').trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((n) => (n.includes(',') ? conComa(n) : openalex.nombreApa(n)))
      .filter(Boolean)
      .join('; ') || '(Autor no consignado)'
  );
}

/** Un DOI limpio («10.x/y») o null. */
function limpiarDoi(crudo) {
  return openalex.limpiarDoi(crudo);
}

/** Quita etiquetas HTML/XML y espacios de más de un resumen o título. */
function textoLimpio(crudo) {
  const texto = String(crudo ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    // «patients <i>x</i>.» dejaba «patients x .»: sin espacio antes del signo.
    .replace(/\s+([.,;:!?)])/g, '$1')
    .trim();
  return texto || null;
}

/** El año de «2021», «2021-05-03» o un número; null si no hay. */
function anioDe(valor) {
  const m = String(valor ?? '').match(/(1[89]\d\d|20\d\d)/);
  return m ? Number(m[1]) : null;
}

/** Una búsqueda sin resultados por fallo: la web la dice «no respondió». */
const CAIDA = Object.freeze({ resultados: [], total: 0, caida: true });

module.exports = { TIEMPO_LIMITE_MS, clave, contacto, pedir, autoresApa, limpiarDoi, textoLimpio, anioDe, CAIDA };
