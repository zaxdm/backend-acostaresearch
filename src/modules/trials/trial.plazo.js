'use strict';

const { addMinutes } = require('../../shared/utils/tokens');

/**
 * Cuándo termina un enlace de prueba.
 *
 * El tiempo de acceso corre desde que se crea el enlace, no desde que cada
 * invitado recoge su conector: la prueba de un taller termina a la misma hora
 * para todo el grupo, recoja cada uno el suyo cuando lo recoja. Nulo con 0
 * minutos: sin límite, y se corta apagando el enlace.
 *
 * Va en su propio archivo porque lo usan el servicio de pruebas y la puerta de
 * las licencias, y el primero ya depende del segundo.
 */
function finDelEnlace({ createdAt, accessMinutes }) {
  const minutos = Number(accessMinutes) || 0;
  return minutos > 0 && createdAt ? addMinutes(new Date(createdAt), minutos) : null;
}

/** Si el enlace ya pasó su hora de fin. Sin límite no termina nunca. */
function enlaceTerminado(enlace, ahora = new Date()) {
  const fin = finDelEnlace(enlace);
  return fin !== null && fin <= ahora;
}

module.exports = { finDelEnlace, enlaceTerminado };
