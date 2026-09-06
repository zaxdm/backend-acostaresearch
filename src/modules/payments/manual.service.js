'use strict';

const crypto = require('node:crypto');
const prisma = require('../../lib/prisma');
const env = require('../../config/env');
const logger = require('../../config/logger');
const { ERROR_CODES } = require('../../config/constants');
const { sendMail } = require('../../lib/mailer');
const plantillas = require('../../lib/emailTemplates');
const { avisarAlAdmin } = require('../../lib/notify');
const billingRepository = require('../billing/billing.repository');
const discountService = require('../billing/discount.service');
const paymentRepository = require('./payment.repository');
const proofStorage = require('./proof.storage');
const { entregarPago } = require('./payment.delivery');
const { AppError, NotFoundError } = require('../../shared/errors/AppError');

/**
 * Pago manual por Yape.
 *
 * El comprador paga con el QR, sube la captura y espera; un administrador la
 * mira y aprueba o rechaza. Solo al aprobar se crea la licencia, y con ella la
 * URL del conector.
 *
 * POR QUÉ HAY UNA PERSONA EN MEDIO
 * ---------------------------------
 * Una captura de pantalla no prueba nada: se falsifica en dos minutos y no hay
 * ninguna API de Yape con la que comprobarla. La revisión a mano no es una
 * carencia del sistema, es el único control que existe. Por eso el aviso al
 * administrador lleva el número de operación: lo que se coteja es el extracto
 * real, no la imagen.
 *
 * LA URL SÍ VIAJA POR CORREO, PERO NO SALE DE AQUÍ
 * -------------------------------------------------
 * Al aprobar se crea la licencia y su URL se le manda al comprador por correo.
 * Antes no: se le mandaba al panel a generarla él. Se cambió porque quien paga
 * por Yape no está mirando la pantalla cuando aprobamos —han pasado horas—, y
 * el correo es la única superficie que le alcanza en ese momento.
 *
 * El envío NO se hace en este archivo, sino en `payment.delivery`, que es el
 * mismo punto por el que pasa un cobro de pasarela: lo que recibe el comprador
 * no puede depender de por dónde pagó.
 *
 * Al administrador se le sigue sin enseñar esa URL: quien mira esta pantalla no
 * es el dueño de la licencia.
 */

const PROVEEDOR = 'YAPE';
/** Yape cobra en soles, que es la moneda en la que se anuncian los precios. */
const MONEDA = 'PEN';

/** Sin O/0 ni I/1: la referencia se dicta por WhatsApp cuando algo se tuerce. */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generarReferencia() {
  let cuerpo = '';
  for (let i = 0; i < 8; i += 1) cuerpo += ALFABETO[crypto.randomInt(0, ALFABETO.length)];
  return `YP-${cuerpo}`;
}

/** El comprador, con lo justo para escribirle y para que el admin lo reconozca. */
const COMPRADOR = { id: true, email: true, firstName: true, lastName: true };

/**
 * Avisa sin bloquear.
 *
 * Un fallo del correo no puede tumbar la operación: el comprobante ya está
 * guardado y el pago ya está aprobado. Se registra y se sigue.
 */
function avisar(destinatario, mensaje, contexto) {
  if (!destinatario) return;

  sendMail({ to: destinatario, ...mensaje }).catch((error) => {
    logger.error({ err: error, ...contexto }, 'No se pudo enviar el aviso del pago manual');
  });
}

/**
 * A quién avisar de que hay un comprobante esperando.
 *
 * Si no está configurado en el .env se busca un administrador activo: es
 * preferible mirar en la base de datos a que el aviso se pierda porque nadie
 * rellenó una variable.
 */
async function correoDelAdministrador() {
  if (env.ADMIN_NOTIFY_EMAIL) return env.ADMIN_NOTIFY_EMAIL;

  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN', status: 'ACTIVE' },
    select: { email: true },
    orderBy: { createdAt: 'asc' },
  });

  if (!admin) {
    logger.warn('No hay ningún administrador al que avisar de los comprobantes de Yape');
    return null;
  }

  return admin.email;
}

const manualService = {
  /** Datos del cobro que la web enseña junto al QR. */
  datosDePago() {
    return { titular: env.yape.titular, numero: env.yape.numero, currency: MONEDA };
  },

  /**
   * Registra el pago y guarda el comprobante, en una sola operación.
   *
   * Van juntos a propósito: si fueran dos pasos, cada intento fallido de subir
   * la imagen dejaría una fila de pago huérfana que nadie va a mirar nunca.
   *
   * El importe lo calcula el servidor a partir del plan, igual que en PayPal.
   * Lo que diga el comprador que pagó es un dato del comprobante, no el precio.
   */
  async registrar({ userId, planCode, discountCode, operationCode, buffer }) {
    const plan = await billingRepository.findPlanByCode(planCode);
    if (!plan || !plan.active) {
      throw new NotFoundError(`No existe un plan activo con el código ${planCode}.`);
    }

    if (!plan.priceCents || plan.priceCents <= 0) {
      throw new AppError(`El plan ${plan.name} no se vende por Yape.`, {
        statusCode: 409,
        code: ERROR_CODES.PLAN_NOT_PURCHASABLE,
      });
    }

    const descuento = await discountService.resolve({ code: discountCode, plan });
    const amountCents = plan.priceCents - (descuento ? descuento.amountCents : 0);

    const payment = await paymentRepository.create({
      userId,
      planId: plan.id,
      provider: PROVEEDOR,
      providerOrderId: generarReferencia(),
      amountCents,
      currency: MONEDA,
      discountCodeId: descuento ? descuento.id : null,
      discountCents: descuento ? descuento.amountCents : 0,
      operationCode: operationCode || null,
    });

    let comprobante;
    try {
      comprobante = await proofStorage.guardar(buffer, { paymentId: payment.id });
    } catch (error) {
      // Sin captura no hay nada que revisar: la fila se cierra en vez de
      // quedarse pendiente para siempre.
      await paymentRepository.fail(payment.id, { errorCode: 'PROOF_REJECTED' });
      throw error;
    }

    const enganchado = await paymentRepository.attachProof(payment.id, {
      userId,
      proofPath: comprobante.path,
      proofMime: comprobante.mime,
    });

    if (!enganchado) {
      await proofStorage.borrar(comprobante.path);
      throw new AppError('No pudimos registrar tu comprobante. Vuelve a intentarlo.', {
        statusCode: 409,
        code: ERROR_CODES.PAYMENT_FAILED,
      });
    }

    const comprador = await prisma.user.findUnique({ where: { id: userId }, select: COMPRADOR });

    logger.info(
      { userId, paymentId: payment.id, plan: plan.code, amountCents },
      'Comprobante de Yape recibido, pendiente de revisión',
    );

    avisar(
      await correoDelAdministrador(),
      plantillas.manualPaymentReceived({
        buyer: comprador,
        planName: plan.name,
        amountCents,
        operationCode: operationCode || null,
        paymentId: payment.id,
      }),
      { paymentId: payment.id },
    );

    // Y un empujón al móvil, porque el correo se lee cuando uno abre el correo
    // y esto espera a que alguien lo mire. Va sin el correo del comprador a
    // propósito: ver quién es y su comprobante exige entrar al panel.
    avisarAlAdmin({
      titulo: `Yape por revisar · S/ ${(amountCents / 100).toFixed(2)}`,
      mensaje: `${comprador.firstName} ${(comprador.lastName || '').charAt(0)}. · ${plan.name}`,
      etiquetas: ['moneybag'],
      enlace: `${env.APP_URL}/admin?seccion=yape`,
    });

    return {
      paymentId: payment.id,
      reference: payment.providerOrderId,
      amountCents,
      currency: MONEDA,
      status: 'IN_REVIEW',
      plan: { code: plan.code, name: plan.name },
    };
  },

  /** Comprobantes esperando revisión. Es la bandeja del administrador. */
  pendientes() {
    return paymentRepository.listInReview();
  },

  /**
   * Historial: los comprobantes que ya pasaron por la bandeja.
   *
   * Se devuelve la tanda entera —las últimas doscientas— y el panel busca y
   * filtra dentro. Con este volumen, paginar contra el servidor solo añadiría
   * una espera por cada letra escrita en el buscador.
   *
   * La ruta del comprobante NO sale de aquí: es una ruta de disco y no le sirve
   * de nada a quien mira el panel. Se cambia por un booleano, que es la única
   * pregunta que hace la pantalla: ¿hay imagen que abrir?
   */
  async historial({ limit } = {}) {
    const pagos = await paymentRepository.listReviewed({ provider: PROVEEDOR, limit });

    return pagos.map(({ proofPath, ...pago }) => ({ ...pago, tieneComprobante: Boolean(proofPath) }));
  },

  contarPendientes() {
    return paymentRepository.countInReview();
  },

  /** La imagen del comprobante, para verla en el panel. */
  async comprobante(paymentId) {
    const payment = await paymentRepository.findByIdWithPlan(paymentId);
    if (!payment || !payment.proofPath) {
      throw new NotFoundError('Ese pago no tiene comprobante.');
    }

    return { buffer: await proofStorage.leer(payment.proofPath), mime: payment.proofMime };
  },

  /**
   * Da el pago por bueno y entrega lo comprado.
   *
   * Recorre el mismo camino que un cobro de PayPal —`entregarPago`—, así que una
   * licencia comprada por Yape sale idéntica a una comprada con tarjeta: mismos
   * topes, mismo modo de entrega, misma caducidad.
   *
   * Lo que devuelve NO incluye la URL del conector aunque la entrega la genere:
   * quien está mirando esta pantalla es el administrador, no el dueño de la
   * licencia.
   */
  async aprobar({ paymentId, adminId }) {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { plan: true, user: { select: COMPRADOR } },
    });

    if (!payment) throw new NotFoundError('No encontramos ese pago.');

    if (payment.status === 'PAID') {
      return { alreadyProcessed: true, payment: { id: payment.id, status: payment.status } };
    }

    if (payment.status !== 'IN_REVIEW') {
      throw new AppError(`Este pago está en estado ${payment.status}: no hay nada que aprobar.`, {
        statusCode: 409,
        code: ERROR_CODES.PAYMENT_FAILED,
      });
    }

    const entrega = await entregarPago({
      payment,
      estadoEsperado: 'IN_REVIEW',
      captura: {
        // El número de operación es lo que permite cuadrarlo con el extracto;
        // si el comprador no lo puso, queda nuestra referencia.
        captureId: payment.operationCode || payment.providerOrderId,
        payerEmail: payment.user.email,
        raw: { metodo: PROVEEDOR, aprobadoPor: adminId, aprobadoEn: new Date().toISOString() },
      },
      notaBolsa: 'Pago por Yape confirmado a mano',
    });

    // Sin entrega: otro administrador lo aprobó un instante antes.
    if (!entrega) {
      return { alreadyProcessed: true, payment: { id: paymentId, status: 'PAID' } };
    }

    await paymentRepository.markReviewed(paymentId, adminId);

    const esLicencia = payment.plan.kind === 'LICENSE';

    logger.info(
      { paymentId, adminId, plan: payment.plan.code, userId: payment.userId },
      'Pago por Yape aprobado y producto entregado',
    );

    // El correo al comprador NO se manda aquí: lo manda `entregarPago`, que es
    // el mismo punto por el que pasa un cobro de pasarela. Antes salía desde
    // aquí y decía «entra al panel y pulsa Nueva URL»; ahora lleva la URL
    // dentro, y tenía que hacerlo igual viniera de Yape o de PayPal. Dos envíos
    // en dos sitios distintos era la forma segura de que un día dijeran cosas
    // distintas.

    return {
      alreadyProcessed: false,
      payment: { id: paymentId, status: 'PAID' },
      // Solo lo que el administrador necesita ver.
      entregado: esLicencia
        ? {
            tipo: 'LICENSE',
            licenseId: entrega.license.id,
            productCode: entrega.license.productCode,
          }
        : { tipo: 'WORDS', packId: entrega.pack.id, words: entrega.pack.wordsTotal },
    };
  },

  /** Rechaza el comprobante. El motivo se le enseña al comprador tal cual. */
  async rechazar({ paymentId, adminId, motivo }) {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { plan: { select: { name: true } }, user: { select: COMPRADOR } },
    });

    if (!payment) throw new NotFoundError('No encontramos ese pago.');

    const rechazado = await paymentRepository.reject(paymentId, {
      reviewedById: adminId,
      reviewNote: motivo,
    });

    if (!rechazado) {
      throw new AppError(
        `Este pago está en estado ${payment.status}: ya no se puede rechazar.`,
        { statusCode: 409, code: ERROR_CODES.PAYMENT_FAILED },
      );
    }

    logger.warn({ paymentId, adminId, motivo }, 'Comprobante de Yape rechazado');

    avisar(
      payment.user.email,
      plantillas.manualPaymentRejected({
        firstName: payment.user.firstName,
        planName: payment.plan.name,
        motivo,
      }),
      { paymentId },
    );

    return { payment: { id: paymentId, status: 'REJECTED', reviewNote: motivo } };
  },
};

module.exports = manualService;
