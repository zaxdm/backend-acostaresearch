'use strict';

const prisma = require('./prisma');
const { crearSonda } = require('./sondaBase');

/**
 * La sonda de la base, una sola para todo el proceso.
 *
 * La preguntan `/health/bd` —la pantalla de mantenimiento de la web— y el
 * vigilante del servidor. Al compartirla, sus respuestas guardadas valen para
 * los dos y la base no recibe una consulta por cada uno.
 */
module.exports = crearSonda({ consultar: () => prisma.$queryRaw`SELECT 1` });
