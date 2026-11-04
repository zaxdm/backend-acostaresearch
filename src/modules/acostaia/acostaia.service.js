'use strict';

const crypto = require('node:crypto');
const logger = require('../../config/logger');
const prisma = require('../../lib/prisma');
const { generateOpaqueToken, hashToken } = require('../../shared/utils/tokens');
const { ValidationError } = require('../../shared/errors/AppError');
const { urlDelConector, contratoDelProducto } = require('../licensing/license.service');
const licenseRepository = require('../licensing/license.repository');

/**
 * Licencias para AcostaIA, el chat propio (sistema aparte, en `acostaia/`).
 *
 * AcostaIA tiene sus propias cuentas y no se enlaza con las de la web. Pero su
 * chat usa las herramientas del conector, y en el conector todo cuelga de una
 * licencia y de un usuario. Así que, por cada usuario de AcostaIA, aquí vive un
 * titular espejo —como el invitado de un conector de prueba— con su licencia
 * de cada producto que use (tesis, informe, artículo…).
 *
 * El titular espejo:
 *   - se reconoce por `User.acostaiaId`;
 *   - no tiene contraseña ni Google, así que nadie puede entrar con él en la web;
 *   - tiene un correo .invalid, y el mailer no manda nada a esas direcciones.
 *
 * Se usan los productos que ya existen, no uno nuevo: del producto depende qué
 * skills recibe, cómo sale el Word y los textos («tu tesis», «tu informe»).
 */

const ORIGEN = 'ACOSTAIA';

function correoEspejo() {
  return `acostaia-${crypto.randomUUID()}@acostaia.invalid`;
}

/** Que el producto exista y se venda como licencia del conector. */
async function exigirProducto(productCode) {
  const contrato = await contratoDelProducto(productCode);
  if (!contrato.planId) {
    throw new ValidationError(`El producto ${productCode} no existe o no está a la venta.`);
  }
  return contrato;
}

/**
 * El titular espejo de ese usuario de AcostaIA; lo crea la primera vez.
 *
 * Si dos altas llegan a la vez, la segunda choca con el índice único de
 * `acostaiaId` y se queda con la que creó la primera.
 */
async function titularDe({ acostaiaId, nombre, apellido }) {
  const existente = await prisma.user.findUnique({
    where: { acostaiaId },
    select: { id: true },
  });
  if (existente) return existente;

  try {
    return await prisma.user.create({
      data: {
        email: correoEspejo(),
        firstName: nombre || 'Usuario',
        lastName: apellido || 'AcostaIA',
        acostaiaId,
      },
      select: { id: true },
    });
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
    return prisma.user.findUnique({ where: { acostaiaId }, select: { id: true } });
  }
}

const acostaiaService = {
  /**
   * Da a un usuario de AcostaIA una licencia nueva de un producto.
   *
   * El token se guarda hasheado y no se puede volver a leer, así que pedirla
   * otra vez no devuelve la misma: corta la que tenía de ese producto y emite
   * otra. El proyecto no se pierde, porque cuelga del titular y del producto,
   * no de la licencia.
   *
   * Sin caducidad: AcostaIA corta el acceso cuando su plan se acaba. Los topes
   * se copian del plan del producto, como a cualquier comprador.
   */
  async crearAcceso({ acostaiaId, productCode, nombre, apellido }) {
    const contrato = await exigirProducto(productCode);
    const titular = await titularDe({ acostaiaId, nombre, apellido });

    const anteriores = await prisma.license.findMany({
      where: { userId: titular.id, productCode, status: 'ACTIVE' },
      select: { id: true },
    });
    for (const { id } of anteriores) {
      await licenseRepository.setStatus(id, {
        status: 'REVOKED',
        revokedReason: 'Reemplazada por una nueva desde AcostaIA.',
        origen: ORIGEN,
      });
    }

    const token = generateOpaqueToken(32);
    const licencia = await prisma.license.create({
      data: {
        userId: titular.id,
        productCode,
        tokenHash: hashToken(token),
        tokenHint: token.slice(0, 8),
        expiresAt: null,
        ...contrato.topes,
      },
      select: { id: true },
    });

    logger.info(
      { acostaiaId, licenseId: licencia.id, producto: productCode, reemplazadas: anteriores.length },
      'Licencia emitida para AcostaIA',
    );

    return { licenseId: licencia.id, connectorUrl: urlDelConector(token), productCode };
  },

  /**
   * Corta las licencias activas de un usuario de AcostaIA: las de un producto
   * o, sin producto, todas. Quedan revocadas (no borradas), con su historial.
   */
  async revocarAcceso({ acostaiaId, productCode, motivo }) {
    const titular = await prisma.user.findUnique({
      where: { acostaiaId },
      select: { id: true },
    });
    if (!titular) return { revocadas: 0 };

    const activas = await prisma.license.findMany({
      where: { userId: titular.id, status: 'ACTIVE', ...(productCode && { productCode }) },
      select: { id: true },
    });
    for (const { id } of activas) {
      await licenseRepository.setStatus(id, {
        status: 'REVOKED',
        revokedReason: motivo || 'Acceso cortado desde AcostaIA.',
        origen: ORIGEN,
      });
    }

    logger.info(
      { acostaiaId, producto: productCode ?? 'todos', revocadas: activas.length },
      'Licencias de AcostaIA revocadas',
    );

    return { revocadas: activas.length };
  },
};

module.exports = acostaiaService;
