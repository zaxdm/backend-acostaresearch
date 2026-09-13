'use strict';

/**
 * ¿La base está al otro lado?
 *
 * La pregunta la hace la pantalla de mantenimiento de la web. Cuando la base se
 * cae, cada pestaña abierta se queda preguntando cada medio minuto si ya volvió,
 * y sin freno eso serían N consultas contra un plan de cinco conexiones justo
 * cuando intenta levantarse. Por eso la respuesta se guarda unos segundos: da
 * igual cuántas pestañas pregunten, a la base le llega una consulta por ventana.
 *
 * Se guarda también el fallo, no solo el acierto. Es el fallo el que se repite
 * durante un corte, y es el que no hay que ir a buscar a la base otra vez.
 *
 * La consulta y el reloj entran por parámetro para probarlo sin base y sin
 * esperar de verdad.
 */

/** Lo que dura una respuesta guardada. */
const VIGENCIA_MS = 10 * 1000;

function crearSonda({ consultar, vigenciaMs = VIGENCIA_MS }) {
  let ultima = null;
  let enCurso = null;

  return async function comprobar(ahora = Date.now()) {
    if (!ultima || ahora - ultima.momento >= vigenciaMs) {
      // Si llegan varias a la vez con la respuesta caducada, esperan todas a la
      // misma consulta en vez de lanzar una cada una.
      enCurso ??= consultar()
        .then(
          () => null,
          (error) => error,
        )
        .then((error) => {
          ultima = { momento: ahora, error };
          enCurso = null;
        });
      await enCurso;
    }

    if (ultima.error) throw ultima.error;
  };
}

module.exports = { VIGENCIA_MS, crearSonda };
