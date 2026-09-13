'use strict';

const logger = require('../config/logger');
const { codigoDe } = require('./dbAlert');

/**
 * El vigilante de la base: la campanita de los cortes.
 *
 * Antes el aviso salía de contar los errores de las peticiones, y eso lo dejaba
 * en manos de las visitas. Sin nadie en la web no sonaba, y desde que existe la
 * pantalla de mantenimiento tampoco sonaba con una sola persona: la pantalla
 * tapa la web y pregunta una vez cada treinta segundos, así que nunca se
 * juntaban tres fallos en un minuto.
 *
 * Ahora es el servidor el que pregunta, cada medio minuto, haya quien haya. Usa
 * la misma sonda que `/health/bd`, que guarda la respuesta unos segundos: a la
 * base, con sus cinco conexiones, le llega como mucho una consulta más cada
 * treinta segundos.
 *
 * Suena una vez por corte, no una por comprobación fallida, y avisa también
 * cuando la base vuelve. Un fallo suelto no avisa: la red parpadea y se recupera
 * sola, y un aviso que suena por eso se silencia a la semana.
 *
 * La comprobación y el aviso entran por parámetro para probarlo sin base, sin
 * red y sin ntfy.
 */

/** Cada cuánto se pregunta. Es el mismo ritmo que el de la pantalla de mantenimiento. */
const INTERVALO_MS = 30 * 1000;

/** Comprobaciones fallidas seguidas que hacen sonar el aviso. */
const FALLOS_PARA_AVISAR = 2;

/**
 * Lo que se espera a la base antes de darla por caída.
 *
 * Una base que no contesta no siempre falla: a veces se queda colgada. Sin este
 * límite el vigilante esperaría con ella y no avisaría nunca.
 */
const TIEMPO_LIMITE_MS = 10 * 1000;

function duracion(ms) {
  const segundos = Math.round(ms / 1000);
  return segundos < 90 ? `${segundos} s` : `${Math.round(segundos / 60)} min`;
}

function conLimite(promesa, ms) {
  let temporizador;
  const limite = new Promise((_resolver, rechazar) => {
    temporizador = setTimeout(() => rechazar(new Error(`La base no contestó en ${ms / 1000} s`)), ms);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador));
}

function crearVigia({
  comprobar,
  avisar,
  fallosParaAvisar = FALLOS_PARA_AVISAR,
  tiempoLimiteMs = TIEMPO_LIMITE_MS,
}) {
  let fallosSeguidos = 0;
  let caidaDesde = null;
  let avisado = false;

  return async function latido(ahora = Date.now()) {
    try {
      await conLimite(comprobar(ahora), tiempoLimiteMs);
    } catch (error) {
      fallosSeguidos += 1;
      caidaDesde ??= ahora;
      if (avisado || fallosSeguidos < fallosParaAvisar) return;

      avisado = true;
      const codigo = codigoDe(error) ?? 'sin respuesta';
      logger.error({ err: error, fallosSeguidos }, 'La base de datos no responde');
      avisar({
        titulo: 'La base de datos no responde',
        mensaje:
          `${fallosSeguidos} comprobaciones seguidas sin respuesta (${codigo}), ` +
          `la primera hace ${duracion(ahora - caidaDesde)}. ` +
          'La web está enseñando la pantalla de mantenimiento.',
        etiquetas: ['rotating_light'],
        prioridad: 5,
      });
      return;
    }

    if (avisado) {
      const caida = duracion(ahora - caidaDesde);
      logger.info({ caida }, 'La base de datos volvió');
      avisar({
        titulo: 'La base de datos volvió',
        mensaje: `Estuvo sin responder unos ${caida}. La web ya funciona.`,
        etiquetas: ['white_check_mark'],
        prioridad: 3,
      });
    }

    fallosSeguidos = 0;
    caidaDesde = null;
    avisado = false;
  };
}

module.exports = { INTERVALO_MS, FALLOS_PARA_AVISAR, TIEMPO_LIMITE_MS, crearVigia };
