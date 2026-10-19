'use strict';

/**
 * Anular una venta registrada por error, desde «Accesos» del panel (20-oct-2026).
 *
 * Deja de contar como venta (ingresos, cierre mensual, declaración) y el cliente
 * CONSERVA su acceso: para quitárselo está «Revocar» en su licencia. Sirve para
 * un código aunque ya esté canjeado y para un pago ya aprobado.
 *  - Código: pasa a VOID.
 *  - Pago: pasa a REJECTED con la nota «Venta anulada desde el panel». El pago
 *    que nació de canjear un código no es la venta: se anula su código.
 *
 * Si la venta ya tenía boleta aceptada, se anula con nota de crédito en el mismo
 * paso. Si después de anular sigue habiendo venta (un carrito al que se le quitó
 * una línea), se vuelve a facturar con lo que queda.
 */

const prisma = require('../../lib/prisma');
const logger = require('../../config/logger');
const { AppError, NotFoundError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');
const sunatService = require('../sunat/sunat.service');
const sunatRepository = require('../sunat/sunat.repository');

const MOTIVO = 'Venta registrada por error: anulada';

function conflicto(mensaje) {
  return new AppError(mensaje, { statusCode: 409, code: ERROR_CODES.VALIDATION_ERROR });
}

/** Marca la venta como anulada y devuelve sus claves de facturación. */
async function marcarAnulada({ canal, id, adminId }) {
  if (canal === 'codigo') {
    const codigo = await prisma.activationCode.findUnique({ where: { id }, select: { status: true } });
    if (!codigo) throw new NotFoundError('Ese código no existe.');
    if (codigo.status === 'VOID') throw conflicto('Ese código ya está anulado.');
    await prisma.activationCode.update({ where: { id }, data: { status: 'VOID' } });
    return [`CODIGO:${id}`];
  }

  const pago = await prisma.payment.findUnique({
    where: { id },
    select: { status: true, cartId: true, providerOrderId: true },
  });
  if (!pago) throw new NotFoundError('Ese pago no existe.');
  // El pago de un canje no es la venta: la venta es el código.
  const delCanje = await prisma.activationCode.findUnique({ where: { id: pago.providerOrderId }, select: { id: true } });
  if (delCanje) return marcarAnulada({ canal: 'codigo', id: delCanje.id, adminId });
  if (pago.status !== 'PAID') throw conflicto('Solo se anula un pago cobrado.');

  const { count } = await prisma.payment.updateMany({
    where: { id, status: 'PAID' },
    data: { status: 'REJECTED', reviewNote: 'Venta anulada desde el panel.', reviewedById: adminId, reviewedAt: new Date() },
  });
  if (count === 0) throw conflicto('Ese pago cambió mientras tanto. Recarga la lista.');
  return [`PAGO:${id}`, pago.cartId ? `CARRITO:${pago.cartId}` : null].filter(Boolean);
}

/**
 * @returns {{ boleta: string|null, nota?: string, estadoNota?: string, refacturada?: boolean, avisoBoleta?: string }}
 */
async function anularVenta({ canal, id, adminId }) {
  const claves = await marcarAnulada({ canal, id, adminId });

  const boleta = await prisma.comprobante.findFirst({
    where: { tipo: '03', origenClave: { in: claves } },
    select: { serie: true, numero: true, estado: true, origenClave: true },
  });
  if (!boleta) return { boleta: null };
  const numero = `${boleta.serie}-${boleta.numero}`;

  if (boleta.estado !== 'ACEPTADO' && boleta.estado !== 'OBSERVADO') {
    return {
      boleta: numero,
      avisoBoleta: `La boleta ${numero} aún no está aceptada por SUNAT: anúlala en Boletas cuando lo esté.`,
    };
  }

  const refacturar = await sunatRepository.sigueSiendoVenta(boleta.origenClave);
  try {
    const r = await sunatService.anular({ serie: boleta.serie, numero: boleta.numero, motivo: MOTIVO, refacturar });
    return { boleta: numero, nota: r.nota, estadoNota: r.estado, refacturada: refacturar };
  } catch (error) {
    // La venta ya quedó anulada; la boleta se anula a mano en Boletas.
    logger.error({ err: error, boleta: numero }, 'No se pudo anular la boleta de una venta anulada');
    return { boleta: numero, avisoBoleta: `La venta se anuló, pero la boleta ${numero} no: ${error.message}` };
  }
}

module.exports = { anularVenta };
