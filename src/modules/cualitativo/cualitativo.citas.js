'use strict';

/**
 * Las citas textuales del capítulo, comprobadas contra las transcripciones.
 *
 * El capítulo de resultados cualitativos se apoya en lo que dijeron los
 * entrevistados, entre comillas o en bloque. Antes de armar el Word se busca
 * cada una en las entrevistas subidas: si alguna no está, el Word no se arma y
 * se dice cuál. Es la misma idea que la de las cifras del informe de R, pero
 * más estricta: una cifra redondeada puede ser un despiste, una frase que el
 * entrevistado no dijo no lo es nunca.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 * - Lo que va entre «», “” o "" con cinco palabras o más. Lo más corto suele
 *   ser el nombre de un código o un término, no una cita.
 * - Cada bloque «> …»: la cita larga de APA.
 * - Si la cita coincide con el nombre de un código o una categoría, se salta.
 *
 * Se tolera lo que APA permite tocar: la mayúscula del principio, la puntuación
 * de los extremos y los cortes marcados con «…», «[…]» o «(…)»; cada trozo se
 * busca por separado. Y lo que no se ve: espacios, comillas y guiones de otra
 * forma (ver `cualitativo.codificacion`).
 */

const { esqueletoConPosiciones, claveDe } = require('./cualitativo.codificacion');

const MINIMO_PALABRAS = 5;
/** Un trozo más corto que esto, tras un corte, no dice nada: se salta. */
const MINIMO_TROZO = 8;

const ENTRE_COMILLAS = /«([^»]+)»|“([^”]+)”|"([^"\n]+)"/g;
const CORTE = /\s*(?:\[\s*(?:…|\.{3})\s*\]|\(\s*(?:…|\.{3})\s*\)|…|\.{3})\s*/;

const palabras = (texto) => String(texto).trim().split(/\s+/).filter(Boolean).length;

/** Lo que se compara: sin espacios, sin mayúsculas y sin la puntuación de los extremos. */
function forma(texto) {
  return esqueletoConPosiciones(texto)
    .esqueleto.toLocaleLowerCase('es')
    .replace(/^[.,;:¿?¡!'"()-]+|[.,;:¿?¡!'"()-]+$/g, '');
}

/** Las citas del texto: entre comillas o en bloque, cada una con el texto tal cual. */
function citasDe(texto) {
  const encontradas = [];
  const bloques = String(texto ?? '').split(/\n{2,}/);
  for (const bloque of bloques) {
    const lineas = bloque.split('\n');
    if (lineas.length > 0 && lineas.every((l) => /^\s*>/.test(l))) {
      const cita = lineas.map((l) => l.replace(/^\s*>\s?/, '')).join(' ').trim();
      // La atribución que suele cerrar el bloque, «(E3, ¶12)», no es parte de la cita.
      encontradas.push(cita.replace(/\s*\([^()]*\)\s*\.?\s*$/, ''));
      continue;
    }
    for (const m of bloque.matchAll(ENTRE_COMILLAS)) encontradas.push(m[1] ?? m[2] ?? m[3]);
  }
  return encontradas.map((c) => c.trim()).filter(Boolean);
}

/**
 * Las citas del capítulo que NO están en ninguna entrevista.
 *
 * Devuelve `{ revisadas, faltan }`: cuántas se buscaron y el texto de las que no
 * aparecen.
 */
function comprobar(texto, entrevistas, codificacion) {
  const nombres = new Set();
  for (const c of codificacion?.codigos ?? []) {
    nombres.add(claveDe(c.nombre));
    if (c.categoria) nombres.add(claveDe(c.categoria));
  }

  const parrafos = entrevistas.flatMap((e) => e.parrafos.map((p) => forma(p)));
  const esta = (trozo) => {
    const buscado = forma(trozo);
    return buscado.length < MINIMO_TROZO || parrafos.some((p) => p.includes(buscado));
  };

  let revisadas = 0;
  const faltan = [];
  for (const cita of citasDe(texto)) {
    if (palabras(cita) < MINIMO_PALABRAS || nombres.has(claveDe(cita))) continue;
    revisadas += 1;
    const trozos = cita.split(CORTE).filter((t) => t.trim() !== '');
    if (!trozos.every(esta)) faltan.push(cita);
  }
  return { revisadas, faltan };
}

module.exports = { comprobar, citasDe, MINIMO_PALABRAS };
