'use strict';

const billingService = require('../billing/billing.service');
const discountService = require('../billing/discount.service');
const licenseService = require('../licensing/license.service');
const licenseRepository = require('../licensing/license.repository');
const paymentRepository = require('./payment.repository');

/**
 * Lo que se entrega cuando un pago se da por bueno.
 *
 * Vive aparte porque ahora hay DOS caminos que llegan aquí —el cobro de PayPal
 * y la aprobación a mano de un Yape— y tienen que entregar exactamente lo
 * mismo. Duplicar este bloque era la forma segura de que dentro de un mes una
 * licencia comprada por Yape saliera con topes distintos que la misma comprada
 * con tarjeta.
 *
 * Todo lo que toca la base de datos va dentro de la transacción de `settle`:
 * o el pago queda cobrado y lo comprado entregado, o no ocurre ninguna de las
 * dos cosas. Lo único que se hace fuera es preparar la licencia, porque su
 * token tiene que generarse una sola vez para poder devolver la URL.
 */
async function entregarPago({ payment, captura, estadoEsperado = 'PENDING', notaBolsa }) {
  const esLicencia = payment.plan.kind === 'LICENSE';

  const licenciaPreparada = esLicencia
    ? await licenseService.prepareForPurchase({
        userId: payment.userId,
        productCode: payment.plan.productCode ?? payment.plan.code,
        durationDays: payment.plan.durationDays,
      })
    : null;

  return paymentRepository.settle({
    paymentId: payment.id,
    estadoEsperado,
    captura,
    entregar: async (tx) => {
      // El código solo se gasta si el pago llegó a confirmarse.
      if (payment.discountCodeId) {
        await discountService.registrarUso(payment.discountCodeId, tx);
      }

      if (esLicencia) {
        const license = await licenseRepository.create(licenciaPreparada.data, tx);
        return {
          enlace: { licenseId: license.id },
          resultado: { license, connectorUrl: licenciaPreparada.connectorUrl },
        };
      }

      const pack = await tx.wordPack.create({
        data: billingService.packDataForPlan({
          userId: payment.userId,
          plan: payment.plan,
          paymentMethod: payment.provider,
          paymentRef: captura.captureId,
          note: notaBolsa,
        }),
      });

      return { enlace: { wordPackId: pack.id }, resultado: { pack } };
    },
  });
}

module.exports = { entregarPago };
