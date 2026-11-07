'use strict';

const logger = require('../../config/logger');
const prisma = require('../../lib/prisma');
const { AppError, NotFoundError } = require('../../shared/errors/AppError');
const paymentService = require('../payments/payment.service');

/**
 * Comprar un método desde Epicuro (AcostaIA), sin salir de su página (7-nov-2026).
 *
 * No hay un cobro nuevo: se usan `paymentService.createOrder` y `captureOrder`
 * con Culqi, los mismos de /planes. Mismo precio (el del plan, nunca el que
 * diga el navegador), descuentos, renovación, correo con el conector, boleta
 * y protección contra cobros dobles.
 *
 * La compra queda a nombre de la cuenta de acostaresearch.com con el correo
 * VERIFICADO del usuario de Epicuro (lo garantiza el servidor de Epicuro, que
 * es el único que llega aquí, con la clave interna). Si no tiene cuenta, se le
 * crea sin contraseña: entra después con Google o con «olvidé mi contraseña».
 * Así le llega su correo con el conector, la boleta sale a su nombre y la
 * compra le sirve también en Claude, ChatGPT y Grok.
 */

const PASARELA = 'CULQI';

/** Su cuenta de acostaresearch.com por el correo; `crear` la hace si no existe. */
async function compradorDe({ email, nombre, apellido }, { crear }) {
  const correo = email.trim().toLowerCase();
  const usuario = await prisma.user.findUnique({
    where: { email: correo },
    select: { id: true, status: true, deletedAt: true, acostaiaId: true },
  });
  if (usuario) {
    if (usuario.deletedAt || usuario.status !== 'ACTIVE') {
      throw new AppError('La cuenta de acostaresearch.com con tu correo no está activa. Escríbenos para ayudarte.', {
        statusCode: 409,
        code: 'CUENTA_INACTIVA',
      });
    }
    return usuario;
  }
  if (!crear) throw new NotFoundError('No encontramos ese pago.');

  try {
    const nuevo = await prisma.user.create({
      data: {
        email: correo,
        firstName: (nombre || 'Usuario').slice(0, 80),
        lastName: (apellido || '').slice(0, 80),
        // El correo lo verificó Epicuro antes de dejarle comprar.
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    // Un registro a medias con ese correo chocaría con esta cuenta al verificarse.
    await prisma.pendingRegistration.deleteMany({ where: { email: correo } }).catch(() => undefined);
    logger.info({ userId: nuevo.id }, 'Cuenta creada al comprar desde Epicuro');
    return nuevo;
  } catch (error) {
    // Dos compras a la vez: la segunda se queda con la cuenta que creó la primera.
    if (error?.code !== 'P2002') throw error;
    return prisma.user.findUnique({ where: { email: correo }, select: { id: true } });
  }
}

const acostaiaCompras = {
  /** Abre la orden: el importe lo calcula el servidor a partir del plan. */
  async orden({ email, nombre, apellido, planCode, discountCode }) {
    const comprador = await compradorDe({ email, nombre, apellido }, { crear: true });
    const orden = await paymentService.createOrder({
      userId: comprador.id,
      planCode,
      providerCode: PASARELA,
      discountCode,
    });
    return {
      orderId: orden.orderId,
      amountCents: orden.amountCents,
      currency: orden.currency,
      discount: orden.discount,
      plan: orden.plan,
    };
  },

  /**
   * Cobra con el token de Culqi (o vuelve tras la verificación 3-D Secure) y
   * entrega lo de siempre. Devuelve la licencia comprada, para que Epicuro la
   * vincule al momento.
   */
  async cobrar({ email, orderId, token, deviceFingerprint, authentication3DS }) {
    const comprador = await compradorDe({ email }, { crear: false });
    const resultado = await paymentService.captureOrder({
      userId: comprador.id,
      orderId,
      providerCode: PASARELA,
      datosDelCobro: {
        token,
        email: email.trim().toLowerCase().slice(0, 50),
        ...(deviceFingerprint && { deviceFingerprint }),
        ...(authentication3DS && { authentication3DS }),
      },
    });
    if (resultado.requiresAuthentication) return { requiresAuthentication: true };
    return {
      requiresAuthentication: false,
      alreadyProcessed: Boolean(resultado.alreadyProcessed),
      licenseId: resultado.license?.id ?? null,
      productCode: resultado.license?.productCode ?? null,
    };
  },

  /** La llave pública de Culqi (no protege nada por sí sola), o null si no está activo. */
  pasarela() {
    const culqi = paymentService.listProviders().find((p) => p.code === PASARELA);
    return culqi?.publicKey ? { publicKey: culqi.publicKey } : null;
  },
};

module.exports = acostaiaCompras;
