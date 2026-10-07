'use strict';

const crypto = require('node:crypto');
const env = require('../../config/env');
const logger = require('../../config/logger');
const { avisarAlAdmin } = require('../../lib/notify');
const billingRepository = require('../billing/billing.repository');
const licenseRepository = require('../licensing/license.repository');
const licenseService = require('../licensing/license.service');
const userRepository = require('../users/user.repository');
const paymentRepository = require('./payment.repository');
const { entregarPago } = require('./payment.delivery');
const { hotmartProvider } = require('./providers/hotmart.provider');
const { planDelProducto } = require('./providers/hotmart.productos');

/**
 * El webhook de Hotmart (versión 2.0.0): aquí se confirman los pagos.
 *
 * Hotmart avisa de cada cambio de una compra con un POST firmado con el Hottok
 * en la cabecera `X-HOTMART-HOTTOK`. Si no contestamos 200, lo reintenta; por
 * eso todo lo de aquí se puede repetir sin entregar dos veces, y un fallo al
 * entregar se deja subir para que Hotmart vuelva a llamar.
 *
 * ── Qué fila de `payments` se paga ──────────────────────────────────────────
 *
 *   1. La del `sck`: el comprador salió de nuestra web, que abrió la orden y
 *      puso su referencia en el enlace de pago. Es el caso normal.
 *   2. La que ya tiene esta transacción: un aviso repetido, o el COMPLETE que
 *      llega días después del APPROVED.
 *   3. Ninguna: pagó desde un enlace compartido o desde la página de Hotmart.
 *      Se busca su cuenta por el correo de la compra y, si no tiene, se le
 *      abre una sin contraseña para entregarle lo comprado. El correo de
 *      entrega le lleva el conector, y registrarse con ese correo después la
 *      reclama (`userRepository.findPorReclamar`).
 */

const APROBADA = new Set(['PURCHASE_APPROVED', 'PURCHASE_COMPLETE']);
const DEVUELTA = { PURCHASE_REFUNDED: 'HOTMART_REEMBOLSO', PURCHASE_CHARGEBACK: 'HOTMART_CONTRACARGO' };
const CANCELADA = 'PURCHASE_CANCELED';

/** Estados desde los que un aviso de aprobación puede entregar. */
const SE_PUEDE_ENTREGAR = new Set(['PENDING', 'CANCELLED', 'FAILED']);

/** ¿El aviso viene de Hotmart? Comparación en tiempo constante. */
function firmaValida(recibido) {
  if (!env.HOTMART_HOTTOK || typeof recibido !== 'string') return false;
  const a = Buffer.from(recibido);
  const b = Buffer.from(env.HOTMART_HOTTOK);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Lo que de verdad se cobró, en soles. Con conversión de moneda el comprador
 * extranjero paga en la suya (`price`), pero el precio de la oferta sigue en
 * la moneda del producto. Sin un importe en soles, la fila se queda con el del
 * plan.
 */
function importeEnSoles(compra) {
  const candidato = [compra?.original_offer_price, compra?.price].find(
    (precio) => precio?.currency_value === 'PEN' && Number.isFinite(Number(precio.value)),
  );
  return candidato ? { amountCents: Math.round(Number(candidato.value) * 100), currency: 'PEN' } : null;
}

/** Nombre y apellido del comprador, con lo que traiga Hotmart. */
function nombreDe(comprador) {
  const completo = String(comprador?.name ?? '').trim();
  const [primero = '', ...resto] = completo.split(/\s+/);
  return {
    firstName: (comprador?.first_name || primero || 'Cliente').slice(0, 80),
    lastName: (comprador?.last_name || resto.join(' ') || 'Hotmart').slice(0, 80),
  };
}

/** El aviso sin datos de más para guardarlo en la fila del pago. */
function crudoParaGuardar(aviso) {
  const { hottok: _hottok, ...resto } = aviso ?? {};
  return resto;
}

/** La cuenta del comprador: la que tiene ese correo, o una nueva por reclamar. */
async function cuentaDelComprador(comprador) {
  const email = String(comprador?.email ?? '').trim().toLowerCase();
  if (!email) return null;

  const existente = await userRepository.findByEmail(email);
  if (existente) return existente;

  const nueva = await userRepository.create({ email, ...nombreDe(comprador) });
  logger.info({ userId: nueva.id }, 'Hotmart: cuenta abierta por una compra sin registro');
  return nueva;
}

/** La fila que paga este aviso, creándola si el comprador no salió de la web. */
async function filaDelPago({ sck, transaccion, planCode, comprador }) {
  if (sck) {
    const porReferencia = await paymentRepository.findByOrderId(hotmartProvider.code, sck);
    if (porReferencia && porReferencia.plan.code === planCode) return porReferencia;
  }

  const porTransaccion = await paymentRepository.findByCaptureId(hotmartProvider.code, transaccion);
  if (porTransaccion) return porTransaccion;

  const referenciaPropia = `hm_tx_${transaccion}`;
  const yaAbierta = await paymentRepository.findByOrderId(hotmartProvider.code, referenciaPropia);
  if (yaAbierta) return yaAbierta;

  const plan = await billingRepository.findPlanByCode(planCode);
  if (!plan) return null;

  // Salió de la web con otro producto en el `sck` (raro): se entrega a esa
  // misma cuenta. Si no, a la del correo de la compra.
  const deLaWeb = sck ? await paymentRepository.findByOrderId(hotmartProvider.code, sck) : null;
  const usuario = deLaWeb?.user ?? (await cuentaDelComprador(comprador));
  if (!usuario) return null;

  await paymentRepository.create({
    userId: usuario.id,
    planId: plan.id,
    provider: hotmartProvider.code,
    providerOrderId: referenciaPropia,
    amountCents: plan.priceCents,
    currency: hotmartProvider.currency,
  });
  return paymentRepository.findByOrderId(hotmartProvider.code, referenciaPropia);
}

async function aprobar(aviso) {
  const { product: producto, purchase: compra, buyer: comprador } = aviso.data ?? {};
  const transaccion = compra?.transaction;
  const planCode = planDelProducto(producto?.id);

  if (!transaccion || !planCode) {
    logger.warn(
      { evento: aviso.event, producto: producto?.id, transaccion },
      'Hotmart: compra aprobada de un producto que no está enlazado a ningún plan',
    );
    avisarAlAdmin({
      titulo: 'Hotmart: compra sin plan enlazado',
      mensaje: `Producto ${producto?.id ?? '?'} · ${producto?.name ?? ''} · actívalo a mano`,
      etiquetas: ['warning'],
    });
    return { resultado: 'sin_plan' };
  }

  const pago = await filaDelPago({
    sck: compra.origin?.sck,
    transaccion,
    planCode,
    comprador,
  });

  if (!pago) {
    logger.error({ transaccion, planCode }, 'Hotmart: no se pudo resolver la cuenta del comprador');
    avisarAlAdmin({
      titulo: 'Hotmart: compra sin cuenta',
      mensaje: `Transacción ${transaccion} · ${planCode} · revísala en Hotmart`,
      etiquetas: ['warning'],
    });
    return { resultado: 'sin_cuenta' };
  }

  if (pago.status === 'PAID') return { resultado: 'ya_entregado', paymentId: pago.id };

  if (!SE_PUEDE_ENTREGAR.has(pago.status)) {
    logger.warn({ paymentId: pago.id, status: pago.status }, 'Hotmart: aviso sobre un pago cerrado');
    return { resultado: 'cerrado', paymentId: pago.id };
  }

  const importe = importeEnSoles(compra);
  const entrega = await entregarPago({
    payment: pago,
    captura: {
      captured: true,
      captureId: transaccion,
      payerEmail: comprador?.email ?? null,
      status: compra.status ?? null,
      raw: crudoParaGuardar(aviso),
      ...(importe ? { importeReal: importe } : {}),
    },
    estadoEsperado: pago.status,
    notaBolsa: 'Pago con Hotmart',
  });

  logger.info(
    { paymentId: pago.id, userId: pago.userId, plan: planCode, transaccion, entregado: Boolean(entrega) },
    'Hotmart: pago confirmado',
  );
  avisarAlAdmin({
    titulo: 'Venta por Hotmart',
    mensaje: `${pago.user?.firstName ?? 'Cliente'} · ${pago.plan.name}`,
    etiquetas: ['moneybag'],
  });

  return { resultado: 'entregado', paymentId: pago.id };
}

const DIA_MS = 24 * 60 * 60 * 1000;
/** Margen entre crear la licencia y anotar el pago, que van en la misma transacción. */
const MISMA_COMPRA_MS = 60 * 1000;

/**
 * Quita lo que pagó un cobro devuelto.
 *
 *   · Compra nueva (la licencia nació con este pago): se revoca entera.
 *   · Renovación (la licencia ya existía): se le restan los días de este plan y
 *     conserva lo que había pagado antes. Si con eso ya caducó, se revoca.
 *
 * Solo licencias, que es lo único que se vende en Hotmart. Lo demás se deja
 * para el administrador, que recibe el aviso igual.
 */
async function quitarAcceso(pago, errorCode) {
  if (!pago.licenseId) return 'sin_licencia';

  const licencia = await licenseRepository.findById(pago.licenseId);
  if (!licencia || licencia.status === 'REVOKED') return 'ya_revocada';

  const motivo =
    errorCode === 'HOTMART_CONTRACARGO'
      ? 'Contracargo de la compra en Hotmart'
      : 'Reembolso de la compra en Hotmart';

  const pagadoEn = pago.paidAt ? new Date(pago.paidAt).getTime() : null;
  const esRenovacion =
    pagadoEn !== null && new Date(licencia.createdAt).getTime() < pagadoEn - MISMA_COMPRA_MS;

  if (esRenovacion && licencia.expiresAt && pago.plan.durationDays) {
    const nuevaCaducidad = new Date(
      new Date(licencia.expiresAt).getTime() - pago.plan.durationDays * DIA_MS,
    );
    if (nuevaCaducidad.getTime() > Date.now()) {
      await licenseRepository.acortar(licencia.id, nuevaCaducidad);
      return 'acortada';
    }
  }

  await licenseService.revoke(licencia.id, motivo);
  return 'revocada';
}

const LO_QUE_SE_HIZO = {
  revocada: 'acceso revocado',
  acortada: 'renovación descontada',
  ya_revocada: 'ya estaba revocado',
  sin_licencia: 'revisa el acceso a mano',
};

async function devolver(aviso, errorCode) {
  const compra = aviso.data?.purchase;
  const pago =
    (compra?.transaction &&
      (await paymentRepository.findByCaptureId(hotmartProvider.code, compra.transaction))) ||
    (compra?.origin?.sck && (await paymentRepository.findByOrderId(hotmartProvider.code, compra.origin.sck)));

  if (!pago) {
    logger.warn({ transaccion: compra?.transaction, errorCode }, 'Hotmart: devolución de un pago desconocido');
    return { resultado: 'desconocido' };
  }

  // Hotmart repite avisos, y a un reembolso le puede seguir un contracargo:
  // el acceso se quita una sola vez, con el primero.
  const yaDevuelto = Object.values(DEVUELTA).includes(pago.errorCode);

  await paymentRepository.marcarDevolucion(pago.id, { errorCode, rawResponse: crudoParaGuardar(aviso) });
  if (yaDevuelto) return { resultado: 'ya_devuelto', paymentId: pago.id };

  const acceso = pago.status === 'PAID' ? await quitarAcceso(pago, errorCode) : 'sin_licencia';

  logger.warn({ paymentId: pago.id, userId: pago.userId, errorCode, acceso }, 'Hotmart: dinero devuelto');
  avisarAlAdmin({
    titulo: errorCode === 'HOTMART_CONTRACARGO' ? 'Hotmart: contracargo' : 'Hotmart: reembolso',
    mensaje: `${pago.user?.firstName ?? 'Cliente'} · ${pago.plan.name} · ${LO_QUE_SE_HIZO[acceso]}`,
    etiquetas: ['warning'],
  });
  return { resultado: 'devuelto', acceso, paymentId: pago.id };
}

async function cancelar(aviso) {
  const sck = aviso.data?.purchase?.origin?.sck;
  const pago = sck ? await paymentRepository.findByOrderId(hotmartProvider.code, sck) : null;
  if (!pago || pago.status !== 'PENDING') return { resultado: 'ignorado' };

  await paymentRepository.fail(pago.id, {
    errorCode: 'HOTMART_CANCELADA',
    rawResponse: crudoParaGuardar(aviso),
  });
  return { resultado: 'cancelado', paymentId: pago.id };
}

/**
 * Procesa un aviso ya autenticado. Devuelve qué se hizo, para el log y las
 * pruebas; los eventos que no interesan se contestan sin tocar nada.
 */
async function procesarAviso(aviso) {
  const evento = aviso?.event;
  if (APROBADA.has(evento)) return aprobar(aviso);
  if (DEVUELTA[evento]) return devolver(aviso, DEVUELTA[evento]);
  if (evento === CANCELADA) return cancelar(aviso);
  return { resultado: 'ignorado' };
}

module.exports = { firmaValida, procesarAviso, importeEnSoles, nombreDe };
