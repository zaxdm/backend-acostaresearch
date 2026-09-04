'use strict';

const logger = require('../../config/logger');
const { ERROR_CODES } = require('../../config/constants');
const billingRepository = require('../billing/billing.repository');
const billingService = require('../billing/billing.service');
const discountService = require('../billing/discount.service');
const licenseService = require('../licensing/license.service');
const licenseRepository = require('../licensing/license.repository');
const paymentRepository = require('./payment.repository');
const { getProvider, enabledProviders } = require('./providers');
const { AppError, NotFoundError } = require('../../shared/errors/AppError');

/** Pasarela pedida, siempre que exista y tenga credenciales. */
function obtenerPasarela(code) {
  const provider = getProvider(code);

  if (!provider || !provider.isEnabled()) {
    throw new AppError('El pago en línea no está disponible ahora mismo.', {
      statusCode: 503,
      code: ERROR_CODES.PAYMENT_UNAVAILABLE,
    });
  }

  return provider;
}

/**
 * Lo que se devuelve tras un cobro correcto, y también al reintentarlo.
 * `entrega` trae la bolsa o la licencia según el plan que se compró.
 */
async function resultadoDeCompra(userId, entrega = {}) {
  return { ...entrega, balance: await billingService.getBalance(userId) };
}

/** Reconstruye lo entregado por un pago ya confirmado, para un reintento. */
async function entregaDeUnPago(payment) {
  if (payment.wordPackId) {
    return { pack: await paymentRepository.findPack(payment.wordPackId) };
  }
  if (payment.licenseId) {
    // La URL no se puede reconstruir: del token solo se guarda el hash. El
    // comprador la vuelve a obtener regenerándola desde su cuenta.
    return { license: await licenseRepository.findById(payment.licenseId), connectorUrl: null };
  }
  return {};
}

const paymentService = {
  /** Pasarelas que el navegador puede ofrecer. Vacío = solo pago manual. */
  listProviders() {
    return enabledProviders().map((provider) => ({
      code: provider.code,
      label: provider.label,
      currency: provider.currency,
    }));
  },

  /**
   * Abre una orden en la pasarela. Todavía no se cobra nada: solo se reserva el
   * importe, que lo calcula el servidor a partir del plan. El navegador manda
   * el código del plan, nunca el precio.
   */
  async createOrder({ userId, planCode, providerCode, discountCode }) {
    const provider = obtenerPasarela(providerCode);

    const plan = await billingRepository.findPlanByCode(planCode);
    if (!plan || !plan.active) {
      throw new NotFoundError(`No existe un plan activo con el código ${planCode}.`);
    }

    const precioBase = provider.priceForPlan(plan);
    if (!precioBase || precioBase <= 0) {
      throw new AppError(`El plan ${plan.name} no se puede pagar con ${provider.label}.`, {
        statusCode: 409,
        code: ERROR_CODES.PLAN_NOT_PURCHASABLE,
      });
    }

    // El descuento lo resuelve el servidor a partir del código: el navegador
    // manda el código, nunca el importe rebajado.
    const descuento = await discountService.resolve({ code: discountCode, plan });
    const rebaja = descuento ? descuento.discountUsdCents : 0;
    const amountCents = precioBase - rebaja;

    let orden;
    try {
      orden = await provider.createOrder({ plan, amountCents, referencia: userId });
    } catch (error) {
      logger.error(
        { err: error, detalle: error.body, userId, plan: plan.code },
        'La pasarela no pudo crear la orden',
      );
      throw new AppError('No pudimos iniciar el pago. Vuelve a intentarlo en un momento.', {
        statusCode: 502,
        code: ERROR_CODES.PAYMENT_FAILED,
      });
    }

    const payment = await paymentRepository.create({
      userId,
      planId: plan.id,
      provider: provider.code,
      providerOrderId: orden.orderId,
      amountCents,
      currency: provider.currency,
      discountCodeId: descuento?.id ?? null,
      discountCents: rebaja,
    });

    logger.info(
      { userId, plan: plan.code, provider: provider.code, orderId: orden.orderId },
      'Orden de pago creada',
    );

    return {
      paymentId: payment.id,
      orderId: orden.orderId,
      approveUrl: orden.approveUrl,
      amountCents,
      currency: provider.currency,
      discount: descuento ? { code: descuento.code, amountCents: rebaja } : null,
      plan: { code: plan.code, name: plan.name, words: plan.words },
    };
  },

  /**
   * Confirma el cobro y entrega la bolsa.
   *
   * Aquí es donde de verdad se mueve el dinero, así que el orden importa: se
   * cobra, se comprueba que lo cobrado coincide con lo que este servidor había
   * calculado, y solo entonces se entrega. Repetir la llamada no duplica nada.
   */
  async captureOrder({ userId, orderId, providerCode }) {
    const provider = obtenerPasarela(providerCode);
    const payment = await paymentRepository.findByOrderId(provider.code, orderId);

    // Comprobar el dueño evita que una orden ajena entregue palabras aquí.
    if (!payment || payment.userId !== userId) {
      throw new NotFoundError('No encontramos ese pago.');
    }

    if (payment.status === 'PAID') {
      const entrega = await entregaDeUnPago(payment);
      return { alreadyProcessed: true, ...(await resultadoDeCompra(userId, entrega)) };
    }

    if (payment.status !== 'PENDING') {
      throw new AppError('Este pago ya no se puede confirmar. Empieza una compra nueva.', {
        statusCode: 409,
        code: ERROR_CODES.PAYMENT_FAILED,
      });
    }

    let captura;
    try {
      captura = await provider.captureOrder(orderId);
    } catch (error) {
      await paymentRepository.fail(payment.id, {
        errorCode: 'GATEWAY_ERROR',
        rawResponse: error.body,
      });
      logger.error(
        { err: error, detalle: error.body, userId, orderId },
        'La pasarela rechazó el cobro',
      );
      throw new AppError('El pago no se pudo completar. No se te ha cobrado nada.', {
        statusCode: 400,
        code: ERROR_CODES.PAYMENT_FAILED,
      });
    }

    if (!captura.captured) {
      await paymentRepository.fail(payment.id, {
        errorCode: captura.status ?? 'NOT_COMPLETED',
        rawResponse: captura.raw,
      });
      throw new AppError('El pago quedó sin completar. Inténtalo de nuevo.', {
        statusCode: 400,
        code: ERROR_CODES.PAYMENT_FAILED,
      });
    }

    // El importe cobrado tiene que ser exactamente el que abrimos. Si no
    // cuadra, no se entrega nada y queda registrado para revisarlo a mano.
    if (captura.amountCents !== payment.amountCents || captura.currency !== payment.currency) {
      await paymentRepository.fail(payment.id, {
        errorCode: 'AMOUNT_MISMATCH',
        rawResponse: captura.raw,
      });
      logger.error(
        {
          userId,
          orderId,
          esperado: `${payment.amountCents} ${payment.currency}`,
          cobrado: `${captura.amountCents} ${captura.currency}`,
        },
        'El importe cobrado no coincide con el de la orden',
      );
      throw new AppError('El importe cobrado no coincide. Escríbenos y lo revisamos.', {
        statusCode: 409,
        code: ERROR_CODES.PAYMENT_FAILED,
      });
    }

    // Un plan de licencia entrega acceso al conector; uno de palabras, una
    // bolsa. La preparación va fuera de la transacción para que el token se
    // genere una sola vez y su URL se pueda devolver al comprador.
    const esLicencia = payment.plan.kind === 'LICENSE';
    const licenciaPreparada = esLicencia
      ? await licenseService.prepareForPurchase({
          userId,
          productCode: payment.plan.productCode ?? payment.plan.code,
          durationDays: payment.plan.durationDays,
        })
      : null;

    const entrega = await paymentRepository.settle({
      paymentId: payment.id,
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
            userId,
            plan: payment.plan,
            paymentMethod: provider.code,
            paymentRef: captura.captureId,
            // Se guarda el precio del plan en soles, como en las activaciones
            // manuales: el importe real en dólares vive en la fila de `payments`.
            note: `Pago en línea con ${provider.label}`,
          }),
        });
        return { enlace: { wordPackId: pack.id }, resultado: { pack } };
      },
    });

    // Sin entrega: otra petición simultánea ya cerró este pago. No es un error.
    if (!entrega) {
      const actual = await paymentRepository.findByOrderId(provider.code, orderId);
      const yaEntregado = actual ? await entregaDeUnPago(actual) : {};
      return { alreadyProcessed: true, ...(await resultadoDeCompra(userId, yaEntregado)) };
    }

    logger.info(
      { userId, orderId, captureId: captura.captureId, plan: payment.plan.code },
      'Cobro confirmado y bolsa entregada',
    );

    return { alreadyProcessed: false, ...(await resultadoDeCompra(userId, entrega)) };
  },

  /** El usuario cerró la ventana de la pasarela sin pagar. */
  async cancelOrder({ userId, orderId, providerCode }) {
    const provider = obtenerPasarela(providerCode);
    const payment = await paymentRepository.findByOrderId(provider.code, orderId);

    if (!payment || payment.userId !== userId) {
      throw new NotFoundError('No encontramos ese pago.');
    }

    await paymentRepository.cancel(payment.id, userId);
  },

  listForUser(userId) {
    return paymentRepository.listForUser(userId);
  },

  listRecent() {
    return paymentRepository.listRecent();
  },
};

module.exports = paymentService;
