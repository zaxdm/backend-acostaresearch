'use strict';

const crypto = require('node:crypto');
const prisma = require('../../lib/prisma');
const logger = require('../../config/logger');
const { ERROR_CODES } = require('../../config/constants');
const { AppError, NotFoundError } = require('../../shared/errors/AppError');

/**
 * Códigos promocionales.
 *
 * Se guardan EN CLARO, al revés que los códigos de activación. No es un
 * descuido: un código de activación es una credencial de un solo uso que da
 * acceso a un producto, y si se filtra la base de datos alguien podría
 * canjearlo. Un código de descuento no da acceso a nada —solo rebaja el
 * precio— y en cambio hay que poder releerlo para reenviárselo a un cliente o
 * anunciarlo en un vídeo.
 *
 * La rebaja se define en céntimos de SOL, que es la moneda en la que se
 * anuncian los precios. Como PayPal cobra en dólares, al aplicarla se traslada
 * la misma PROPORCIÓN al importe en dólares: así «S/50 de descuento» rebaja
 * exactamente una cuarta parte tanto en soles como en dólares, y el comprador
 * no descubre que le descontaron otra cosa.
 */

/** Rebaja mínima que se puede emitir, en céntimos de sol. */
const DESCUENTO_MINIMO_CENTS = 1000;

/** Lo que debe quedar por pagar como mínimo: PayPal no cobra importes de cero. */
const RESTO_MINIMO_CENTS = 100;

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const codigoSelect = {
  id: true,
  code: true,
  amountCents: true,
  planCode: true,
  maxUses: true,
  usedCount: true,
  active: true,
  expiresAt: true,
  note: true,
  createdAt: true,
};

function generarCodigo(largo = 8) {
  let codigo = '';
  for (let i = 0; i < largo; i += 1) codigo += ALFABETO[crypto.randomInt(0, ALFABETO.length)];
  return codigo;
}

function normalizar(codigo) {
  return codigo.trim().toUpperCase().replace(/[\s-]+/g, '');
}

/** Mismo mensaje para inexistente, caducado o agotado: no se filtra cuál. */
function invalido() {
  return new AppError('Ese código de descuento no es válido o ya no está disponible.', {
    statusCode: 400,
    code: ERROR_CODES.DISCOUNT_INVALID,
  });
}

const discountService = {
  DESCUENTO_MINIMO_CENTS,

  /**
   * Crea un código. Si no se indica uno, se inventa: teclearlo es cosa del
   * comprador, así que se usa el alfabeto sin caracteres confundibles.
   */
  async create({ code, amountCents, planCode, maxUses, expiresAt, note, createdById }) {
    if (amountCents < DESCUENTO_MINIMO_CENTS) {
      throw new AppError(
        `El descuento mínimo es de S/ ${(DESCUENTO_MINIMO_CENTS / 100).toFixed(2)}.`,
        { statusCode: 422, code: ERROR_CODES.VALIDATION_ERROR },
      );
    }

    const valor = code ? normalizar(code) : generarCodigo();

    const yaExiste = await prisma.discountCode.findUnique({ where: { code: valor } });
    if (yaExiste) {
      throw new AppError(`El código ${valor} ya existe.`, {
        statusCode: 409,
        code: ERROR_CODES.VALIDATION_ERROR,
      });
    }

    const creado = await prisma.discountCode.create({
      data: {
        code: valor,
        amountCents,
        planCode: planCode ?? null,
        maxUses: maxUses ?? 0,
        expiresAt: expiresAt ?? null,
        note: note ?? null,
        createdById,
      },
      select: codigoSelect,
    });

    logger.info({ code: valor, amountCents, planCode }, 'Código de descuento creado');
    return creado;
  },

  list({ limit = 100 } = {}) {
    return prisma.discountCode.findMany({
      select: codigoSelect,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },

  async setActive(id, active) {
    const existe = await prisma.discountCode.findUnique({ where: { id }, select: { id: true } });
    if (!existe) throw new NotFoundError('No encontramos ese código de descuento.');

    return prisma.discountCode.update({ where: { id }, data: { active }, select: codigoSelect });
  },

  /**
   * Busca un código utilizable para un plan concreto.
   *
   * Devuelve además cuánto rebaja en cada moneda, calculado sobre el plan: el
   * importe nunca lo decide el navegador.
   */
  async resolve({ code, plan }) {
    if (!code) return null;

    const registro = await prisma.discountCode.findUnique({ where: { code: normalizar(code) } });

    if (!registro || !registro.active) throw invalido();
    if (registro.expiresAt && registro.expiresAt <= new Date()) throw invalido();
    if (registro.maxUses > 0 && registro.usedCount >= registro.maxUses) throw invalido();

    if (registro.planCode && registro.planCode !== plan.code) {
      throw new AppError(`Ese código no se puede usar en «${plan.name}».`, {
        statusCode: 400,
        code: ERROR_CODES.DISCOUNT_INVALID,
      });
    }

    // La rebaja no puede dejar el precio a cero: PayPal no cobra importes nulos.
    // Para regalar el producto entero está el código de activación.
    const rebajaSoles = Math.min(registro.amountCents, plan.priceCents - RESTO_MINIMO_CENTS);

    if (rebajaSoles < DESCUENTO_MINIMO_CENTS) {
      throw new AppError(`Ese código no se puede aplicar a «${plan.name}».`, {
        statusCode: 400,
        code: ERROR_CODES.DISCOUNT_INVALID,
      });
    }

    // Misma proporción en dólares, para que lo anunciado y lo cobrado coincidan.
    const proporcion = rebajaSoles / plan.priceCents;
    const rebajaDolares = plan.priceUsdCents
      ? Math.min(
          Math.round(plan.priceUsdCents * proporcion),
          plan.priceUsdCents - RESTO_MINIMO_CENTS,
        )
      : 0;

    return {
      id: registro.id,
      code: registro.code,
      /** Rebaja anunciada, en céntimos de sol. */
      amountCents: rebajaSoles,
      /** Rebaja equivalente en la moneda de la pasarela. */
      discountUsdCents: rebajaDolares,
      finalPriceCents: plan.priceCents - rebajaSoles,
      finalPriceUsdCents: plan.priceUsdCents ? plan.priceUsdCents - rebajaDolares : null,
    };
  },

  /**
   * Suma un canje. Va dentro de la transacción del cobro: si el pago no se
   * confirma, el código no se gasta.
   */
  registrarUso(id, tx = prisma) {
    return tx.discountCode.update({ where: { id }, data: { usedCount: { increment: 1 } } });
  },
};

module.exports = discountService;
