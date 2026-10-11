'use strict';

const { createHash } = require('node:crypto');
const prisma = require('../../lib/prisma');
const logger = require('../../config/logger');
const hash = (clave) => createHash('sha256').update(clave).digest('hex');

// Compartida entre procesos y conservada después de reiniciar el servidor.
async function leer(clave) {
  try {
    const filas = await prisma.$queryRaw`
      SELECT respuesta, en FROM AliciaCache WHERE clave = ${hash(clave)}
      AND en > DATE_SUB(NOW(), INTERVAL 7 DAY)`;
    if (!filas.length) return null;
    const respuesta = typeof filas[0].respuesta === 'string'
      ? JSON.parse(filas[0].respuesta) : filas[0].respuesta;
    return { respuesta, en: new Date(filas[0].en).getTime() };
  } catch (fallo) {
    logger.warn({ err: fallo.message }, 'No se pudo leer la caché de ALICIA');
    return null;
  }
}

async function guardar(clave, respuesta, en) {
  try {
    await prisma.$executeRaw`
      INSERT INTO AliciaCache (clave, respuesta, en)
      VALUES (${hash(clave)}, ${JSON.stringify(respuesta)}, ${new Date(en)})
      ON DUPLICATE KEY UPDATE respuesta = VALUES(respuesta), en = VALUES(en)`;
    await prisma.$executeRaw`DELETE FROM AliciaCache WHERE en < DATE_SUB(NOW(), INTERVAL 7 DAY)`;
  } catch (fallo) {
    logger.warn({ err: fallo.message }, 'No se pudo guardar la caché de ALICIA');
  }
}

module.exports = { leer, guardar };
