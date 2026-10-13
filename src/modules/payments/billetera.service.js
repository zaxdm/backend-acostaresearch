'use strict';

const prisma = require('../../lib/prisma');
const logger = require('../../config/logger');
const { ERROR_CODES } = require('../../config/constants');
const { AppError, NotFoundError } = require('../../shared/errors/AppError');
const proofStorage = require('./proof.storage');

/**
 * Billeteras digitales de país.
 *
 * Deuna en Ecuador, Nequi en Colombia: lo que Yape es en Perú. El dueño las da
 * de alta desde el panel y le asigna a cada una su país; el comprador la elige
 * al pagar, sube su comprobante y el pago queda esperando a que lo apruebe el
 * administrador de ese país, que es quien puede mirar si el dinero entró.
 *
 * Todo lo demás —guardar la captura, la bandeja, aprobar, entregar— es el flujo
 * de Yape, en `manual.service`. Aquí solo vive el catálogo y la traducción de
 * una billetera al «medio» que ese flujo entiende.
 */

/** El proveedor con el que queda apuntado en `payments` cualquier pago por billetera. */
const PROVEEDOR = 'BILLETERA';

const MONEDAS = ['PEN', 'USD'];

const billeteraSelect = {
  id: true,
  nombre: true,
  pais: true,
  moneda: true,
  titular: true,
  numero: true,
  instrucciones: true,
  active: true,
  createdAt: true,
  qrPath: true,
  updatedAt: true,
};

/**
 * Hacia fuera no sale la ruta del QR en el disco, solo si lo tiene y desde
 * cuándo: con esa fecha la web le cambia la dirección a la imagen cuando se
 * sube otra, y el navegador no enseña la vieja.
 */
function presentar(billetera) {
  if (!billetera) return billetera;
  const { qrPath, updatedAt, ...resto } = billetera;
  return { ...resto, tieneQr: Boolean(qrPath), qrVersion: qrPath ? new Date(updatedAt).getTime() : null };
}

/** Lo que ve quien va a pagar: lo justo para hacer el pago. */
const publicaSelect = {
  id: true,
  nombre: true,
  pais: true,
  moneda: true,
  titular: true,
  numero: true,
  instrucciones: true,
  qrPath: true,
  updatedAt: true,
};

/**
 * La billetera como «medio de pago manual», con la misma forma que Yape y
 * Western Union en `manual.service`: de qué columna del plan sale el precio y
 * de cuál la rebaja del descuento, según cobre en soles o en dólares.
 */
function comoMedio(billetera) {
  const enDolares = billetera.moneda === 'USD';
  return {
    proveedor: PROVEEDOR,
    nombre: billetera.nombre,
    moneda: billetera.moneda,
    prefijo: 'BW',
    precio: (plan) => (enDolares ? plan.priceUsdCents : plan.priceCents),
    rebaja: (descuento) => (enDolares ? descuento.discountUsdCents : descuento.amountCents),
    billeteraId: billetera.id,
    pais: billetera.pais,
  };
}

const billeteraService = {
  PROVEEDOR,
  MONEDAS,
  comoMedio,

  /** Las que se ofrecen al pagar: activas, agrupadas por país en la web. */
  async publicas() {
    const billeteras = await prisma.billetera.findMany({
      where: { active: true },
      select: publicaSelect,
      orderBy: [{ pais: 'asc' }, { nombre: 'asc' }],
    });
    return billeteras.map(presentar);
  },

  /** Todas, para el panel del dueño. */
  async listar() {
    const billeteras = await prisma.billetera.findMany({
      select: billeteraSelect,
      orderBy: [{ pais: 'asc' }, { createdAt: 'asc' }],
    });
    return billeteras.map(presentar);
  },

  /**
   * Guarda la imagen del QR de una billetera, o la cambia por otra.
   *
   * Va a la misma carpeta que los comprobantes, por lo mismo que ellos: pesa,
   * hay que conservarla y no debe vivir en la base. La anterior se borra
   * después de apuntar la nueva, para que un fallo a medias no deje a la
   * billetera sin ninguna.
   */
  async guardarQr(id, buffer, adminId) {
    const actual = await prisma.billetera.findUnique({
      where: { id },
      select: { id: true, qrPath: true },
    });
    if (!actual) throw new NotFoundError('Esa billetera no existe.');

    const guardado = await proofStorage.guardar(buffer, { paymentId: `qr-${id}` });
    const billetera = await prisma.billetera.update({
      where: { id },
      data: { qrPath: guardado.path, qrMime: guardado.mime },
      select: billeteraSelect,
    });
    if (actual.qrPath) await proofStorage.borrar(actual.qrPath);

    logger.warn({ billeteraId: id, adminId, bytes: guardado.bytes }, 'QR de una billetera de país guardado');
    return presentar(billetera);
  },

  /** La imagen del QR, para enseñarla al pagar. Es pública, como el de Yape. */
  async qr(id) {
    const billetera = await prisma.billetera.findUnique({
      where: { id },
      select: { qrPath: true, qrMime: true },
    });
    if (!billetera?.qrPath) throw new NotFoundError('Esa billetera no tiene QR.');
    return { buffer: await proofStorage.leer(billetera.qrPath), mime: billetera.qrMime };
  },

  async crear({ nombre, pais, moneda, titular, numero, instrucciones, createdById }) {
    const creada = await prisma.billetera.create({
      data: { nombre, pais, moneda, titular, numero, instrucciones: instrucciones || null, createdById },
      select: billeteraSelect,
    });
    logger.warn({ billeteraId: creada.id, nombre, pais, moneda, createdById }, 'Billetera de país creada');
    return presentar(creada);
  },

  /**
   * Cambia sus datos o la apaga. Cada campo solo se toca si viene.
   *
   * El país y la moneda NO se cambian: de ellos cuelga a quién le llegan sus
   * comprobantes y en qué moneda quedó cada pago ya hecho. Si se eligió mal, se
   * apaga y se crea otra.
   */
  async cambiar(id, { nombre, titular, numero, instrucciones, active }, adminId) {
    const existe = await prisma.billetera.findUnique({ where: { id }, select: { id: true } });
    if (!existe) throw new NotFoundError('Esa billetera no existe.');

    const cambiada = await prisma.billetera.update({
      where: { id },
      data: {
        ...(nombre === undefined ? {} : { nombre }),
        ...(titular === undefined ? {} : { titular }),
        ...(numero === undefined ? {} : { numero }),
        ...(instrucciones === undefined ? {} : { instrucciones: instrucciones || null }),
        ...(active === undefined ? {} : { active }),
      },
      select: billeteraSelect,
    });
    logger.warn({ billeteraId: id, adminId, active: cambiada.active }, 'Billetera de país cambiada');
    return presentar(cambiada);
  },

  /** El medio con el que se registra un pago por esa billetera. Tiene que estar activa. */
  async medioDe(id) {
    const billetera = await prisma.billetera.findUnique({ where: { id }, select: billeteraSelect });
    if (!billetera || !billetera.active) {
      throw new AppError('Esa billetera ya no está disponible. Elige otra forma de pago.', {
        statusCode: 409,
        code: ERROR_CODES.PAYMENT_FAILED,
      });
    }
    return comoMedio(billetera);
  },

  /**
   * A quién avisar de un comprobante de esa billetera: los administradores
   * activos de su país. Puede no haber ninguno; entonces no se avisa por correo
   * y el pago espera en la bandeja de ese país.
   */
  async correosDelPais(pais) {
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN_PAIS', pais, status: 'ACTIVE' },
      select: { email: true },
    });
    return admins.map((admin) => admin.email);
  },
};

module.exports = billeteraService;
