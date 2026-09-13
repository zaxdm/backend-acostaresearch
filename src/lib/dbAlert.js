'use strict';

const { Prisma } = require('@prisma/client');

/**
 * ¿Este error dice que la base no está, o solo que la consulta no cuadra?
 *
 * El 11 de septiembre de 2026, entre las 15:00 y las 15:04 UTC, la base de
 * Clever Cloud dejó de responder y la API devolvió 38 errores, doce de ellos
 * intentos de inicio de sesión. Nadie se enteró hasta el día siguiente, y solo
 * porque alguien fue a mirar los logs. Era el cuarto corte de cinco en siete
 * días.
 *
 * Lo que se distingue aquí NO son errores de consulta —una clave duplicada, una
 * fila que no está— sino los que significan «la base no está al otro lado». De
 * eso depende que la API conteste 503, y la web saque la pantalla de
 * mantenimiento, en vez de un 500.
 *
 * El aviso al móvil ya no sale de contar estos errores: lo manda el vigilante
 * (`vigiaBase.js`), que pregunta él mismo a la base. Contarlos dejaba el aviso en
 * manos de las visitas, y con la pantalla de mantenimiento puesta cada pestaña
 * pregunta una vez cada treinta segundos: con una sola, nunca se llegaba a tres
 * fallos en un minuto.
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

/**
 * El código de Prisma, esté donde esté.
 *
 * No viene siempre en el mismo sitio: PrismaClientKnownRequestError lo trae en
 * `code`, y PrismaClientInitializationError —el que sale si el corte pilla al
 * cliente sin conectar— en `errorCode`. Mirando solo `code`, esa variante salía
 * como 500 y la web no se enteraba de que era una caída.
 */
function codigoDe(error) {
  return error?.code ?? error?.errorCode;
}

/**
 * Un error de inicialización es caída aunque no traiga código.
 *
 * Probado contra un MySQL inalcanzable: Prisma 6.19 lanza
 * PrismaClientInitializationError con «Can't reach database server» y sin nada
 * ni en `code` ni en `errorCode`. Ese error solo sale cuando el cliente no llega
 * a la base, que es justo lo que aquí se pregunta.
 */
function esCaidaDeBase(error) {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;

  const codigo = codigoDe(error);
  return typeof codigo === 'string' && CODIGOS.has(codigo);
}

module.exports = { CODIGOS_DE_CAIDA, codigoDe, esCaidaDeBase };
