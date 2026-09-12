'use strict';

/**
 * Detector de cortes de la base de datos.
 *
 * El 11 de septiembre de 2026, entre las 15:00 y las 15:04 UTC, la base de
 * Clever Cloud dejó de responder y la API devolvió 38 errores, doce de ellos
 * intentos de inicio de sesión. Nadie se enteró hasta el día siguiente, y solo
 * porque alguien fue a mirar los logs. Era el cuarto corte de cinco en siete
 * días. Esto es la campanita para los siguientes.
 *
 * Lo que se vigila NO son errores de consulta —una clave duplicada, una fila
 * que no está— sino los que significan «la base no está al otro lado». Esa
 * distinción es toda la utilidad del aviso: si suena por cualquier error, se
 * silencia a la semana y deja de servir.
 *
 * La decisión de avisar se separa del aviso en sí para poder probarla con un
 * reloj falso, sin red y sin ntfy.
 */

/**
 * Códigos de Prisma que hablan del enlace con la base, no de la consulta.
 *
 * P1001 y P1017 son los dos que aparecieron en el corte, y en ese orden: primero
 * el servidor cierra de golpe las conexiones que ya estaban abiertas (P1017) y
 * después ya no se le puede ni alcanzar (P1001). P1002 es el mismo cuadro con
 * otro final —contesta pero no a tiempo— y P2024 es quedarse sin conexiones
 * libres en el pool, que con `connection_limit=3` contra un plan de cinco no ha
 * pasado nunca, pero es exactamente lo que habría que ver si pasara.
 */
const CODIGOS_DE_CAIDA = Object.freeze(['P1001', 'P1002', 'P1017', 'P2024']);

const CODIGOS = new Set(CODIGOS_DE_CAIDA);

/** Fallos dentro de la ventana que hacen sonar el aviso. */
const UMBRAL = 3;

/** Ventana en la que se cuentan esos fallos. */
const VENTANA_MS = 60 * 1000;

/**
 * Tiempo que se calla después de avisar.
 *
 * Un corte de cuatro minutos dio 38 errores. Sin esto, 38 avisos: el teléfono
 * inservible justo el rato en el que hay que mirarlo.
 */
const SILENCIO_MS = 15 * 60 * 1000;

/** ¿Este error dice que la base no está, o solo que la consulta no cuadra? */
function esCaidaDeBase(error) {
  return typeof error?.code === 'string' && CODIGOS.has(error.code);
}

/**
 * Ventana deslizante con silencio posterior.
 *
 * Devuelve una función que se llama con cada fallo de conexión y responde si
 * toca avisar. El reloj entra por parámetro para que las pruebas no dependan de
 * esperar un minuto de verdad.
 */
function crearDetector({
  umbral = UMBRAL,
  ventanaMs = VENTANA_MS,
  silencioMs = SILENCIO_MS,
} = {}) {
  let fallos = [];
  let ultimoAviso = null;

  return function registrarFallo(ahora = Date.now()) {
    fallos = fallos.filter((momento) => ahora - momento < ventanaMs);
    fallos.push(ahora);

    if (fallos.length < umbral) return false;
    if (ultimoAviso !== null && ahora - ultimoAviso < silencioMs) return false;

    ultimoAviso = ahora;
    // Se vacía el recuento: los fallos que ya dispararon un aviso no deben
    // contar para el siguiente.
    fallos = [];
    return true;
  };
}

module.exports = {
  CODIGOS_DE_CAIDA,
  UMBRAL,
  VENTANA_MS,
  SILENCIO_MS,
  esCaidaDeBase,
  crearDetector,
};
