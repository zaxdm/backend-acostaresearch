'use strict';

/**
 * Una sección de un capítulo guardado: leerla, cambiarla o meter una nueva.
 *
 * POR QUÉ EXISTE
 * --------------
 * Las sesiones de aprendizaje (`sesiones-fase2-sesiones`) se guardan todas en
 * el mismo capítulo, una detrás de otra, cada una bajo su `## Sesión N · …`.
 * Un ciclo son de 16 a 54 sesiones: de 100 000 a 300 000 caracteres. Corregir
 * la sesión 11 obligaba a reenviar el capítulo entero por partes, y si la
 * conversación se cortaba a mitad, la primera parte ya había sustituido el
 * capítulo y las sesiones de detrás se perdían. `reescribir_parrafos` no sirve:
 * no acepta tablas y rechaza el cambio si cambian las cifras, y una sesión es
 * casi toda tabla con tiempos.
 *
 * Aquí se trabaja con el bloque que empieza en su `##` y llega hasta el
 * siguiente `##`. Lo que va antes del primero (el párrafo de entrada, si lo
 * hay) no es de ninguna sección y no se toca.
 *
 * Es puro: recibe el texto y devuelve el texto. Leer y escribir es de quien lo
 * llama (`project.service.guardarCapitulo`).
 */

const TITULO_RE = /^##\s+(.*)$/;
const VALLA_RE = /^\s*(```|~~~)/;

/** «Sesión 11» y «sesion  11» son la misma: sin tildes, sin mayúsculas, sin espacios dobles. */
function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ¿Este título es el de la sección que se pide?
 *
 * Por el principio: «Sesión 11» vale para «Sesión 11 · Calculamos…». Pero
 * detrás tiene que venir algo que no sea letra ni número, para que «Sesión 1»
 * no se lleve la 11 ni «Sesión 12» la «12-A»… salvo que se pida «Sesión 12-A».
 */
function coincide(titulo, seccion) {
  const t = normalizar(titulo);
  const s = normalizar(seccion).replace(/^#+\s*/, '');
  if (!s || !t.startsWith(s)) return false;
  const siguiente = t.charAt(s.length);
  return siguiente === '' || !/[a-z0-9-]/.test(siguiente);
}

/**
 * Parte el texto en lo de antes del primer `##` y las secciones.
 *
 * Un `##` dentro de un bloque de código no abre sección.
 */
function partir(texto) {
  const lineas = String(texto ?? '').split('\n');
  const antes = [];
  const secciones = [];
  let enValla = false;

  for (const linea of lineas) {
    if (VALLA_RE.test(linea)) enValla = !enValla;
    const titulo = enValla ? null : linea.match(TITULO_RE);
    if (titulo) {
      secciones.push({ titulo: titulo[1].trim(), lineas: [linea] });
    } else if (secciones.length === 0) {
      antes.push(linea);
    } else {
      secciones[secciones.length - 1].lineas.push(linea);
    }
  }

  return { antes, secciones };
}

const textoDe = (seccion) => seccion.lineas.join('\n').trim();

function juntar({ antes, secciones }) {
  const cabeza = antes.join('\n').trim();
  return [cabeza, ...secciones.map(textoDe)].filter(Boolean).join('\n\n');
}

/** Los títulos de las secciones, en orden. */
function titulos(texto) {
  return partir(texto).secciones.map((s) => s.titulo);
}

/** Un error con el formato que ya leen las herramientas (`error.issues[0].message`). */
function errorDe(mensaje) {
  const error = new Error(mensaje);
  error.issues = [{ message: mensaje }];
  return error;
}

function lista(secciones) {
  if (secciones.length === 0) return 'el capítulo no tiene ninguna sección «##» todavía';
  return `las que hay son: ${secciones.map((s) => `«${s.titulo}»`).join(', ')}`;
}

/** La única sección que coincide, o un error que dice cuáles hay. */
function unica(secciones, seccion) {
  const indices = secciones.map((s, i) => (coincide(s.titulo, seccion) ? i : -1)).filter((i) => i >= 0);
  if (indices.length === 1) return indices[0];
  if (indices.length === 0) {
    throw errorDe(`No hay ninguna sección «${seccion}»: ${lista(secciones)}. No se ha guardado nada.`);
  }
  throw errorDe(
    `«${seccion}» coincide con ${indices.length} secciones (` +
      `${indices.map((i) => `«${secciones[i].titulo}»`).join(', ')}). Pide la sección con el título más ` +
      'completo. No se ha guardado nada.',
  );
}

/**
 * Cambia una sección, o mete una nueva detrás de otra.
 *
 * - `seccion`: sustituye esa sección por `nuevo`.
 * - `despuesDe`: mete `nuevo` justo detrás de esa sección (la que faltó entre la
 *   12 y la 13), sin tocar las demás.
 *
 * `nuevo` tiene que empezar por su propio `##`: es una sección entera, y sin su
 * título la siguiente vez no se podría encontrar.
 */
function cambiar(texto, nuevo, { seccion, despuesDe } = {}) {
  if (seccion && despuesDe) {
    throw errorDe('Manda «seccion» para cambiar una sección o «despuesDe» para meter una nueva, no las dos.');
  }
  const limpio = String(nuevo ?? '').trim();
  if (!TITULO_RE.test(limpio.split('\n')[0])) {
    throw errorDe(
      'El texto tiene que empezar por el título de la sección, con dos almohadillas ' +
        '(«## Sesión 11 · …»). No se ha guardado nada.',
    );
  }

  const partes = partir(texto);
  const nuevas = partir(limpio).secciones;

  if (seccion) {
    const i = unica(partes.secciones, seccion);
    partes.secciones.splice(i, 1, ...nuevas);
  } else {
    const i = unica(partes.secciones, despuesDe);
    partes.secciones.splice(i + 1, 0, ...nuevas);
  }

  return juntar(partes);
}

/** El texto de una sección, o null si no está. Si coincide con varias, la primera. */
function leer(texto, seccion) {
  const { secciones } = partir(texto);
  const encontrada = secciones.find((s) => coincide(s.titulo, seccion));
  return encontrada ? textoDe(encontrada) : null;
}

module.exports = { cambiar, leer, titulos, coincide };
