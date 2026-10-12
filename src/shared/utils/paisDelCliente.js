'use strict';

const prisma = require('../../lib/prisma');
const logger = require('../../config/logger');

/**
 * Deja al cliente con la etiqueta del país que lo consiguió.
 *
 * Solo la primera vez: quien ya tiene país se queda con él, para que un cliente
 * no cambie de manos por canjear después un código de otro. Y solo a clientes:
 * la etiqueta de un administrador dice otra cosa (qué país administra).
 *
 * No lanza: es un apunte para el panel, y que falle no puede tumbar el canje o
 * el cobro que lo llamó.
 */
async function etiquetarCliente(userId, pais, cliente = prisma) {
  if (!pais) return;
  try {
    await cliente.user.updateMany({ where: { id: userId, pais: null, role: 'USER' }, data: { pais } });
  } catch (error) {
    logger.warn({ err: error, userId, pais }, 'No se pudo etiquetar al cliente con su país');
  }
}

module.exports = { etiquetarCliente };
