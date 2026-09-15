'use strict';

/**
 * Una tarea detrás de otra por clave, dentro de este proceso.
 *
 * Claude llama a varias herramientas a la vez. Dos que lean, fusionen y
 * escriban lo mismo —dos partes de un capítulo con `anadir`, dos tandas de
 * citas— leían las dos lo de antes, y la segunda en escribir borraba lo de la
 * primera. Esta respondía «Guardado» y su parte no estaba.
 *
 * En memoria basta porque la API es un único proceso (una unidad de systemd).
 * Si algún día corre en varios, esto deja de proteger y hace falta un cerrojo
 * en la base.
 *
 * Una tarea que falla no bloquea a las siguientes. Y ojo: dentro de una tarea
 * no se puede volver a pedir turno con la MISMA clave, o espera por sí misma.
 */

const colas = new Map();

function enSerie(clave, trabajo) {
  const anterior = colas.get(clave) ?? Promise.resolve();
  const actual = anterior.then(() => trabajo());
  const siguiente = actual.catch(() => {});
  colas.set(clave, siguiente);
  siguiente.then(() => {
    if (colas.get(clave) === siguiente) colas.delete(clave);
  });
  return actual;
}

/** Cuántas claves tienen algo en marcha. Para las pruebas. */
function clavesEnMarcha() {
  return colas.size;
}

module.exports = { enSerie, clavesEnMarcha };
