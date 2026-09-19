'use strict';

/**
 * Lo que el asistente «Crear mapa» ya leyó, guardado unos minutos.
 *
 * El asistente pide tres veces sobre los mismos artículos: el umbral (cuántos
 * lo cumplen), la lista para verificar y el mapa final. Sin esto, cada paso
 * volvería a traer mil obras de OpenAlex —diez segundos y presupuesto de la
 * casa— y a etiquetar mil resúmenes. Con esto, el primer paso tarda y los
 * siguientes responden al momento, como en VOSviewer de escritorio, que lee
 * los archivos una vez.
 *
 * En memoria y no en la base: son datos de paso, del mismo proceso que los
 * pide, y si el servidor se reinicia basta con volver a leerlos.
 */

/** Cuánto vive una entrada: lo que dura, de sobra, pasar por el asistente. */
const VIDA_MS = 20 * 60 * 1000;

/** Cuántas entradas como mucho. Mil obras con referencias son unos megas. */
const MAXIMO = 40;

const entradas = new Map();

function limpiar() {
  const ahora = Date.now();
  for (const [clave, e] of entradas) if (e.vence < ahora) entradas.delete(clave);
  while (entradas.size > MAXIMO) entradas.delete(entradas.keys().next().value);
}

/**
 * Lo guardado con esa clave, o lo que dé `calcular` (que se guarda). Si dos
 * peticiones piden lo mismo a la vez, la segunda espera a la primera en vez de
 * repetir la consulta: por eso se guarda la promesa y no el resultado.
 */
async function recordar(clave, calcular) {
  limpiar();
  const guardada = entradas.get(clave);
  if (guardada) return guardada.valor;

  const valor = Promise.resolve().then(calcular);
  entradas.set(clave, { valor, vence: Date.now() + VIDA_MS });
  // Un fallo no se guarda: el siguiente intento tiene que volver a probar.
  valor.catch(() => entradas.delete(clave));
  return valor;
}

/** Para las pruebas. */
function vaciar() {
  entradas.clear();
}

module.exports = { recordar, vaciar };
