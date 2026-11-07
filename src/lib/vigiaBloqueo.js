'use strict';

/**
 * Avisa cuando el servidor se queda parado.
 *
 * Node atiende todo en un solo hilo: si una tarea pesada lo ocupa —armar el
 * Word de una tesis con cientos de citas tardaba 20 segundos—, nadie más es
 * atendido mientras tanto. El conector de Claude y ChatGPT recibe un 502 y el
 * alumno ve un error que no tiene nada que ver con lo que hacía.
 *
 * Esto programa un reloj cada medio segundo y mira cuánto llegó tarde. Si llega
 * más de `umbralMs` tarde, el hilo estuvo ocupado ese tiempo y se anota como
 * error: el vigía de errores (ver `vigiaErrores`) lo manda al programador.
 */

const INTERVALO_MS = 500;
const UMBRAL_MS = 2000;

const MENSAJE = 'El servidor estuvo bloqueado y no atendió peticiones';

function crearVigiaDeBloqueo({ anotar, ahora = () => Date.now(), umbralMs = UMBRAL_MS, intervaloMs = INTERVALO_MS }) {
  let esperado = ahora() + intervaloMs;

  /** Se llama en cada vuelta del reloj. Devuelve los ms de retraso que anotó, o 0. */
  return function comprobar() {
    const momento = ahora();
    const retraso = momento - esperado;
    esperado = momento + intervaloMs;
    if (retraso < umbralMs) return 0;
    anotar(retraso);
    return retraso;
  };
}

/** Pone el reloj en marcha. No impide que el proceso se cierre. */
function vigilarBloqueos(logger, opciones = {}) {
  const intervaloMs = opciones.intervaloMs ?? INTERVALO_MS;
  const comprobar = crearVigiaDeBloqueo({
    ...opciones,
    intervaloMs,
    anotar: (retraso) => logger.error({ bloqueoMs: Math.round(retraso) }, MENSAJE),
  });
  const reloj = setInterval(comprobar, intervaloMs);
  reloj.unref();
  return reloj;
}

module.exports = { crearVigiaDeBloqueo, vigilarBloqueos, MENSAJE, UMBRAL_MS };
