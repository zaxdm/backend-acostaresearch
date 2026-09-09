'use strict';

/**
 * Qué sostiene cada afirmación.
 *
 * El texto de los capítulos ya lleva las claves de cita dentro, así que el mapa
 * de afirmación → fuente no hay que guardarlo aparte: se lee del propio
 * capítulo. Lo que hace este módulo es leerlo y, sobre todo, señalar los dos
 * casos en que no hay respaldo:
 *
 *   SIN RESPALDO   — la frase afirma algo que pide fuente y no cita ninguna.
 *   CITA A MANO    — la frase lleva algo con forma de cita, «(García, 2024)»,
 *                    pero no una clave. Es la más grave de las dos: parece
 *                    respaldada y no lo está. Una cita escrita de memoria por
 *                    un modelo de lenguaje es exactamente el problema que todo
 *                    este módulo bibliográfico existe para evitar, y aquí es
 *                    donde se ve.
 *
 * LO QUE NO HACE
 * --------------
 * No comprueba que la fuente diga lo que la frase afirma. Eso no lo puede hacer
 * un programa, y fingir que sí sería peor que no intentarlo: el tesista dejaría
 * de mirar. Aquí se responde a «¿esto tiene de dónde agarrarse?», no a «¿es
 * verdad?».
 */

const { MARCA } = require('./project.citas');

/**
 * Algo con forma de cita en APA escrito a mano.
 *
 * Un apellido —o dos, o «et al.»— seguido de coma y un año. Se exige mayúscula
 * inicial para no confundirlo con un paréntesis cualquiera que lleve un número.
 */
const CITA_A_MANO = /\([A-ZÁÉÍÓÚÑ][^()]{1,60},\s*(?:19|20)\d{2}[a-z]?\)/;

/**
 * Frases que piden fuente.
 *
 * La lista es corta y deliberadamente conservadora. Un detector que señala de
 * más acaba ignorándose entero, y entonces tampoco señala lo que importa.
 */
const PIDE_FUENTE = [
  // Verbos de reporte: se está atribuyendo algo a alguien.
  /\b(demuestran?|evidencian?|revelan?|indican?|señalan?|sostienen?|concluyen?|afirman?)\b/i,
  /\b(seg[úu]n|de acuerdo con|tal como|estudios?|investigaciones?|autores?|la literatura)\b/i,
  /\bse ha (demostrado|encontrado|observado|reportado|documentado)\b/i,
  // Cifras: un porcentaje o una proporción sin fuente es lo primero que se mira.
  /\d+(?:[.,]\d+)?\s*%/,
  /\b(la mayor[íi]a|un tercio|la mitad|dos de cada|uno de cada)\b/i,
];

/** Encabezados y líneas sueltas: no son afirmaciones. */
function esProsa(frase) {
  if (/^\s*#{1,6}\s/.test(frase)) return false;
  // Menos de cuarenta caracteres no da para afirmar nada con datos; es un
  // título, un pie o una entrada de lista.
  return frase.trim().length >= 40;
}

/**
 * Parte el capítulo en frases.
 *
 * Se corta por punto seguido de espacio y mayúscula. No es un analizador de
 * lenguaje y no pretende serlo: basta con acertar en la inmensa mayoría, porque
 * el resultado que importa —«esta frase no tiene de dónde agarrarse»— lo lee
 * una persona que está mirando su propio texto y lo reconoce.
 */
function frasesDe(texto) {
  return texto
    .split(/\n+/)
    .flatMap((linea) => linea.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡«"])/))
    .map((frase) => frase.trim())
    .filter(Boolean);
}

function pideFuente(frase) {
  return PIDE_FUENTE.some((patron) => patron.test(frase));
}

/** Recorta una frase larga para enseñarla sin llenar la pantalla. */
function recortar(frase, largo = 200) {
  return frase.length <= largo ? frase : `${frase.slice(0, largo).trimEnd()}…`;
}

/**
 * Revisa un capítulo.
 *
 * `porClave` trae las fuentes ya buscadas, para poder decir CUÁL respalda cada
 * afirmación y no solo que hay una.
 */
function revisarCapitulo({ titulo, texto }, porClave = new Map()) {
  const conRespaldo = [];
  const sinRespaldo = [];
  const citasAMano = [];

  for (const frase of frasesDe(texto)) {
    if (!esProsa(frase)) continue;

    const claves = [...frase.matchAll(MARCA)].map((m) => m[1]);

    if (claves.length > 0) {
      conRespaldo.push({
        frase: recortar(frase),
        fuentes: claves.map((clave) => ({
          clave,
          titulo: porClave.get(clave)?.title ?? null,
          existe: porClave.has(clave),
        })),
      });
      continue;
    }

    // Sin clave, pero con algo que aparenta serlo. Es lo más grave.
    if (CITA_A_MANO.test(frase)) {
      citasAMano.push({ frase: recortar(frase) });
      continue;
    }

    if (pideFuente(frase)) sinRespaldo.push({ frase: recortar(frase) });
  }

  return { titulo, conRespaldo, sinRespaldo, citasAMano };
}

/** Lo mismo para varios capítulos, con el recuento junto. */
function revisar(capitulos, porClave = new Map()) {
  const porCapitulo = capitulos.map((c) => revisarCapitulo(c, porClave));

  const suma = (campo) => porCapitulo.reduce((n, c) => n + c[campo].length, 0);

  return {
    capitulos: porCapitulo,
    total: {
      conRespaldo: suma('conRespaldo'),
      sinRespaldo: suma('sinRespaldo'),
      citasAMano: suma('citasAMano'),
    },
  };
}

module.exports = { revisar, revisarCapitulo, frasesDe, pideFuente, esProsa, CITA_A_MANO };
