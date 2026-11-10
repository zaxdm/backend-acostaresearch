'use strict';

const prisma = require('../../lib/prisma');
const logger = require('../../config/logger');
const { avisarAlAdmin } = require('../../lib/notify');
const { NotFoundError, AppError } = require('../../shared/errors/AppError');
const paymentRepository = require('../payments/payment.repository');
const culqiRecurrente = require('./culqi.recurrente');

/**
 * Cobro mensual automático con Culqi (10-nov-2026): la IA (Epicuro + Huella IA)
 * a S/99,90 o S/115 al mes, y la oferta de S/159 que después sigue con la IA.
 *
 * El recorrido:
 *   1. En el checkout, con tarjeta (no Yape), el cliente acepta el cobro
 *      mensual. Con su token se guarda la tarjeta en Culqi (`prepararTarjeta`)
 *      y se abre la fila PENDIENTE.
 *   2. El primer cobro es un cargo normal con esa tarjeta guardada: pasa por
 *      `payments` y se entrega como cualquier compra.
 *   3. Entregado, se crea la suscripción en Culqi (`activar`): cobra a los 30
 *      días y cada mes, el plan `renuevaCon` del plan comprado.
 *   4. Cada cuota que Culqi cobra llega por el webhook y se anota como un pago
 *      nuevo de ese plan, que alarga la IA 30 días (`registrarCobro`). El
 *      correo y la constancia salen solos, como en cualquier pago.
 *   5. Cancelar corta los cobros; lo ya pagado dura hasta su fecha.
 */

/** Prefijo de nuestra referencia para las cuotas: una por cargo de Culqi. */
const REF_CUOTA = 'cq_sxn_';

const SELECT_SUSCRIPCION = {
  id: true,
  estado: true,
  tarjeta: true,
  proximoCobro: true,
  canceladaEn: true,
  createdAt: true,
  plan: { select: { code: true, name: true, priceCents: true, currency: true } },
};

/** ¿Este cobro abre una suscripción? Solo tarjeta de Culqi y plan que se renueva. */
function aplica({ provider, payment, datosDelCobro }) {
  return (
    provider?.code === 'CULQI' &&
    !payment?.cartId &&
    Boolean(payment?.plan?.renuevaCon) &&
    String(datosDelCobro?.token ?? '').startsWith('tkn_') &&
    datosDelCobro?.suscripcion?.acepta === true
  );
}

/** Todos los `chr_…` que aparezcan en un objeto de Culqi, a cualquier profundidad. */
function idsDeCargos(objeto, encontrados = new Set()) {
  if (typeof objeto === 'string') {
    for (const m of objeto.matchAll(/chr_(?:test|live)_[A-Za-z0-9]+/g)) encontrados.add(m[0]);
  } else if (objeto && typeof objeto === 'object') {
    for (const valor of Object.values(objeto)) idsDeCargos(valor, encontrados);
  }
  return encontrados;
}

/** El primer id con ese prefijo (`sxn_`, `crd_`) que aparezca en el objeto. */
function primerId(objeto, prefijo) {
  const texto = typeof objeto === 'string' ? objeto : JSON.stringify(objeto ?? '');
  return texto.match(new RegExp(`${prefijo}_(?:test|live)_[A-Za-z0-9]+`))?.[0] ?? null;
}

const suscripcionService = {
  aplica,

  /**
   * Guarda la tarjeta del token en Culqi y abre la fila PENDIENTE.
   *
   * Se puede llamar dos veces con el mismo pago: si el primer cargo pidió
   * 3-D Secure, el navegador vuelve con la verificación y aquí se reutiliza la
   * tarjeta ya guardada (el token ya se gastó al guardarla).
   */
  async prepararTarjeta({ payment, token, email, authentication3DS, suscripcion }) {
    const existente = await prisma.suscripcion.findUnique({ where: { primerPagoId: payment.id } });
    if (existente) return { cardId: existente.culqiCardId };

    const correo = payment.user?.email ?? email;
    const customerId = await culqiRecurrente.clienteDe({
      email: correo,
      nombre: suscripcion.nombre ?? payment.user?.firstName,
      apellido: suscripcion.apellido ?? payment.user?.lastName,
      telefono: suscripcion.telefono,
      ciudad: suscripcion.ciudad,
      direccion: suscripcion.direccion,
    });
    const tarjeta = await culqiRecurrente.guardarTarjeta({ customerId, token, authentication3DS });
    if (tarjeta.requiresAuthentication) return { requiresAuthentication: true };

    const plan = await prisma.plan.findUnique({ where: { code: payment.plan.renuevaCon } });
    if (!plan) {
      throw new AppError('El plan mensual de este producto no existe. Escríbenos por WhatsApp.', {
        statusCode: 409,
      });
    }
    await prisma.suscripcion.create({
      data: {
        userId: payment.userId,
        planId: plan.id,
        primerPagoId: payment.id,
        culqiCustomerId: customerId,
        culqiCardId: tarjeta.cardId,
        tarjeta: tarjeta.etiqueta,
      },
    });
    return { cardId: tarjeta.cardId };
  },

  /**
   * Crea la suscripción en Culqi después de entregar el primer cobro. Nunca
   * lanza: el cliente ya pagó y ya tiene lo suyo; si Culqi falla, la fila queda
   * FALLIDA con el motivo y se avisa al administrador para reintentar.
   */
  async activar(paymentId) {
    const fila = await prisma.suscripcion.findUnique({
      where: { primerPagoId: paymentId },
      include: { plan: true, user: { select: { email: true } } },
    });
    if (!fila || fila.culqiSubscriptionId) return fila;

    try {
      let { culqiPlanId } = fila.plan;
      if (!culqiPlanId) {
        culqiPlanId = await culqiRecurrente.crearPlanMensual(fila.plan);
        await prisma.plan.update({ where: { id: fila.plan.id }, data: { culqiPlanId } });
      }
      const sub = await culqiRecurrente.suscribir({
        cardId: fila.culqiCardId,
        culqiPlanId,
        metadata: { suscripcion: fila.id, usuario: fila.userId },
      });
      const activa = await prisma.suscripcion.update({
        where: { id: fila.id },
        data: {
          estado: 'ACTIVA',
          culqiSubscriptionId: sub.id,
          proximoCobro: sub.proximoCobro,
          ultimoError: null,
        },
      });
      logger.info({ suscripcion: fila.id, culqi: sub.id }, 'Suscripción creada en Culqi');
      return activa;
    } catch (error) {
      const motivo = String(error?.body?.merchant_message ?? error?.message ?? error).slice(0, 500);
      logger.error({ err: error, suscripcion: fila.id }, 'No se pudo crear la suscripción en Culqi');
      avisarAlAdmin({
        titulo: 'Suscripción sin crear',
        mensaje: `${fila.user?.email ?? fila.userId} · ${fila.plan.code} · ${motivo}`,
        etiquetas: ['warning'],
      });
      return prisma.suscripcion.update({
        where: { id: fila.id },
        data: { estado: 'FALLIDA', ultimoError: motivo },
      });
    }
  },

  /**
   * Crea en Culqi, ya, el plan mensual de cada plan que se cobra cada mes (los
   * que nombra algún `renuevaCon`), para que se vean en el panel de Culqi sin
   * esperar a la primera venta. Los que ya tienen `culqiPlanId` no se tocan.
   */
  async planesEnCulqi() {
    const codigos = await prisma.plan.findMany({
      where: { renuevaCon: { not: null } },
      select: { renuevaCon: true },
    });
    const unicos = [...new Set(codigos.map((p) => p.renuevaCon))];
    const planes = await prisma.plan.findMany({ where: { code: { in: unicos } } });
    const resultado = [];
    for (const plan of planes) {
      if (plan.culqiPlanId) {
        resultado.push({ code: plan.code, culqiPlanId: plan.culqiPlanId, nuevo: false });
        continue;
      }
      const culqiPlanId = await culqiRecurrente.crearPlanMensual(plan);
      await prisma.plan.update({ where: { id: plan.id }, data: { culqiPlanId } });
      resultado.push({ code: plan.code, culqiPlanId, nuevo: true });
    }
    return resultado;
  },

  /**
   * Anota una cuota cobrada por Culqi y alarga el servicio. Se puede repetir:
   * la referencia es el id del cargo, así que el mismo cargo no se entrega dos
   * veces. Solo cuenta lo que Culqi confirma como venta exitosa.
   */
  async registrarCobro(fila, chargeId) {
    const { entregarPago } = require('../payments/payment.delivery');
    const referencia = `${REF_CUOTA}${chargeId}`;
    const ya = await paymentRepository.findByOrderId('CULQI', referencia);
    if (ya?.status === 'PAID') return { resultado: 'ya_entregado' };

    const cargo = await culqiRecurrente.cargo(chargeId);
    if (!cargo || cargo.outcome?.type !== 'venta_exitosa') return { resultado: 'no_cobrado' };

    if (!ya) {
      await paymentRepository.create({
        userId: fila.userId,
        planId: fila.planId,
        provider: 'CULQI',
        providerOrderId: referencia,
        amountCents: cargo.amount ?? fila.plan.priceCents,
        currency: cargo.currency_code ?? 'PEN',
      });
    }
    const pago = await paymentRepository.findByOrderId('CULQI', referencia);
    const entrega = await entregarPago({
      payment: pago,
      captura: {
        captured: true,
        captureId: chargeId,
        amountCents: cargo.amount,
        currency: cargo.currency_code,
        payerEmail: cargo.email ?? pago.user?.email ?? null,
        status: cargo.outcome?.type ?? null,
        raw: { id: cargo.id, amount: cargo.amount, outcome: cargo.outcome },
      },
      estadoEsperado: pago.status,
      notaBolsa: 'Cobro mensual con Culqi',
    });
    await prisma.suscripcion.update({
      where: { id: fila.id },
      data: { estado: 'ACTIVA', ultimoError: null },
    });
    logger.info({ suscripcion: fila.id, chargeId, entregado: Boolean(entrega) }, 'Cuota mensual cobrada');
    avisarAlAdmin({
      titulo: 'Cobro mensual',
      mensaje: `${pago.user?.firstName ?? 'Cliente'} · ${pago.plan.name}`,
      etiquetas: ['moneybag'],
    });
    return { resultado: 'entregado', paymentId: pago.id };
  },

  /**
   * Revisa en Culqi una suscripción y anota las cuotas que falten. Es la red de
   * seguridad del webhook: si un aviso se perdió, aquí se recupera.
   */
  async conciliar(fila) {
    if (!fila.culqiSubscriptionId) return { resultado: 'sin_suscripcion' };
    const detalle = await culqiRecurrente.verSuscripcion(fila.culqiSubscriptionId);
    const cargos = [...idsDeCargos(detalle.periodos)];
    const resultados = [];
    for (const chargeId of cargos) resultados.push(await this.registrarCobro(fila, chargeId));
    if (detalle.proximoCobro) {
      await prisma.suscripcion.update({ where: { id: fila.id }, data: { proximoCobro: detalle.proximoCobro } });
    }
    return { resultado: 'conciliada', cargos: resultados.length };
  },

  /** Concilia todas las activas (lo llama la tarea diaria). */
  async conciliarTodas() {
    const filas = await prisma.suscripcion.findMany({
      where: { estado: { in: ['ACTIVA', 'FALLIDA'] }, culqiSubscriptionId: { not: null } },
      include: { plan: true },
    });
    let revisadas = 0;
    for (const fila of filas) {
      try {
        await this.conciliar(fila);
        revisadas += 1;
      } catch (error) {
        logger.error({ err: error, suscripcion: fila.id }, 'No se pudo conciliar la suscripción');
      }
    }
    return { revisadas };
  },

  /**
   * El webhook de Culqi. Lo recibido solo dice qué evento leer: el evento se
   * pide a Culqi con la llave secreta y se cree lo que dice Culqi.
   */
  async webhook(cuerpo) {
    const eventoId = primerId(cuerpo?.id ?? cuerpo, 'evt') ?? (typeof cuerpo?.id === 'string' ? cuerpo.id : null);
    if (!eventoId) return { resultado: 'sin_evento' };
    const evento = await culqiRecurrente.evento(eventoId);
    const tipo = evento?.type ?? '';
    if (!tipo.startsWith('subscription.')) return { resultado: 'ignorado', tipo };

    const datos = typeof evento.data === 'string' ? safeJson(evento.data) : evento.data;
    const subId = primerId(datos, 'sxn');
    const fila = subId
      ? await prisma.suscripcion.findUnique({ where: { culqiSubscriptionId: subId }, include: { plan: true } })
      : null;
    if (!fila) {
      logger.warn({ tipo, subId, eventoId }, 'Culqi: aviso de una suscripción que no es nuestra');
      return { resultado: 'sin_suscripcion', tipo };
    }

    if (tipo === 'subscription.charge.succeeded') {
      const cargos = [...idsDeCargos(datos)];
      if (!cargos.length) return this.conciliar(fila);
      for (const chargeId of cargos) await this.registrarCobro(fila, chargeId);
      return { resultado: 'cobrado', tipo };
    }
    if (tipo === 'subscription.charge.failed') {
      const motivo = String(datos?.user_message ?? datos?.merchant_message ?? 'La tarjeta no pasó el cobro mensual.');
      await prisma.suscripcion.update({ where: { id: fila.id }, data: { ultimoError: motivo.slice(0, 500) } });
      avisarAlAdmin({
        titulo: 'Cobro mensual rechazado',
        mensaje: `${fila.plan.code} · ${motivo}`.slice(0, 200),
        etiquetas: ['warning'],
      });
      return { resultado: 'fallo_anotado', tipo };
    }
    if (tipo === 'subscription.cancel.succeeded') {
      await prisma.suscripcion.update({
        where: { id: fila.id },
        data: { estado: 'CANCELADA', canceladaEn: fila.canceladaEn ?? new Date() },
      });
      return { resultado: 'cancelada', tipo };
    }
    return { resultado: 'ignorado', tipo };
  },

  /** Las suscripciones del usuario, para «Mis compras». */
  mias(userId) {
    return prisma.suscripcion.findMany({
      where: { userId, estado: { not: 'PENDIENTE' } },
      select: SELECT_SUSCRIPCION,
      orderBy: { createdAt: 'desc' },
    });
  },

  /** El cliente corta el cobro mensual. Lo ya pagado sigue hasta su fecha. */
  async cancelar({ userId, id, porAdmin = false }) {
    const fila = await prisma.suscripcion.findUnique({ where: { id } });
    if (!fila || (!porAdmin && fila.userId !== userId)) throw new NotFoundError('No encontramos esa suscripción.');
    if (fila.estado === 'CANCELADA') return prisma.suscripcion.findUnique({ where: { id }, select: SELECT_SUSCRIPCION });
    if (fila.culqiSubscriptionId) await culqiRecurrente.cancelar(fila.culqiSubscriptionId);
    await prisma.suscripcion.update({
      where: { id },
      data: { estado: 'CANCELADA', canceladaEn: new Date(), proximoCobro: null },
    });
    logger.info({ suscripcion: id, porAdmin }, 'Suscripción cancelada');
    return prisma.suscripcion.findUnique({ where: { id }, select: SELECT_SUSCRIPCION });
  },
};

function safeJson(texto) {
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

module.exports = suscripcionService;
module.exports._internos = { idsDeCargos, primerId, REF_CUOTA };
