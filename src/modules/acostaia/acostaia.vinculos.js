'use strict';

const logger = require('../../config/logger');
const prisma = require('../../lib/prisma');
const { generateOpaqueToken, hashToken } = require('../../shared/utils/tokens');
const { ValidationError, NotFoundError } = require('../../shared/errors/AppError');
const licenseRepository = require('../licensing/license.repository');

/**
 * AcostaIA con la licencia que el usuario ya compró (7-nov-2026).
 *
 * Por defecto AcostaIA trabaja con un titular espejo y un proyecto vacío (ver
 * `acostaia.service`). Si el usuario tiene una licencia comprada en
 * acostaresearch.com, puede vincularla: pegando su enlace del conector o
 * buscándola por el correo de su cuenta de AcostaIA (que está verificado).
 *
 * Su enlace NO se usa desde AcostaIA. AcostaIA abre una sesión del conector
 * por mensaje, y en un enlace comprado eso es la señal de «muchas sesiones»
 * del detector: acabaría revocándole el que usa en Claude. En su lugar se
 * emite otra licencia, del mismo comprador y producto (ve su misma tesis),
 * marcada con `acostaiaDeId`:
 *   - vale mientras la comprada valga (lo mira `authenticate` en cada llamada);
 *   - gasta del cupo de la comprada (`license.limits.claveDelCupo`);
 *   - el detector la vigila con la regla de AcostaIA;
 *   - no sale en el panel del comprador ni cuenta para renovar.
 * Una compra tiene a lo sumo un conector de AcostaIA activo: vincularla otra
 * vez (u otra persona con el mismo enlace) corta el anterior.
 */

const ORIGEN = 'ACOSTAIA';

/** El token de un enlace del conector («https://…/mcp/<token>»), o null. */
function tokenDelEnlace(enlace) {
  const texto = String(enlace ?? '').trim();
  const m =
    texto.match(/\/mcp\/([A-Za-z0-9_-]{20,})\/?(?:[?#].*)?$/) ?? texto.match(/^([A-Za-z0-9_-]{20,})$/);
  return m ? m[1] : null;
}

const conUsuario = {
  id: true,
  userId: true,
  productCode: true,
  status: true,
  expiresAt: true,
  acostaiaDeId: true,
  callsPerDay: true,
  callsPerMonth: true,
  costCentsPerMonth: true,
  callsLimitTotal: true,
  costCentsLimitTotal: true,
  delivery: true,
  variasTesis: true,
  tokenHint: true,
  user: { select: { email: true, status: true, trialLinkId: true, acostaiaId: true } },
};

/** Una compra que se puede vincular: activa, sin caducar, de un cliente de la web. */
function sePuedeVincular(licencia, ahora = new Date()) {
  return Boolean(
    licencia &&
      licencia.status === 'ACTIVE' &&
      (!licencia.expiresAt || licencia.expiresAt > ahora) &&
      !licencia.acostaiaDeId &&
      licencia.user?.status === 'ACTIVE' &&
      !licencia.user.trialLinkId &&
      !licencia.user.acostaiaId,
  );
}

async function nombreDelProducto(productCode) {
  // Dentro de la función: license.service tira de medio backend.
  const { contratoDelProducto } = require('../licensing/license.service');
  return (await contratoDelProducto(productCode).catch(() => null))?.nombre ?? productCode;
}

async function revocar(where, motivo) {
  const activas = await prisma.license.findMany({
    where: { ...where, status: 'ACTIVE', acostaiaDeId: { not: null } },
    select: { id: true },
  });
  for (const { id } of activas) {
    await licenseRepository.setStatus(id, { status: 'REVOKED', revokedReason: motivo, origen: ORIGEN });
  }
  return activas.length;
}

/** Emite el conector de AcostaIA atado a la compra `comprada`. */
async function emitir(acostaiaId, comprada) {
  // Uno por compra, y uno por usuario de AcostaIA y producto.
  await revocar({ acostaiaDeId: comprada.id }, 'Vinculada de nuevo desde AcostaIA.');
  await revocar({ acostaiaId, productCode: comprada.productCode }, 'Vinculó otra licencia en AcostaIA.');

  const token = generateOpaqueToken(32);
  const licencia = await prisma.license.create({
    data: {
      userId: comprada.userId,
      productCode: comprada.productCode,
      tokenHash: hashToken(token),
      tokenHint: token.slice(0, 8),
      // Sin caducidad propia: vale lo que valga la comprada.
      expiresAt: null,
      callsPerDay: comprada.callsPerDay,
      callsPerMonth: comprada.callsPerMonth,
      costCentsPerMonth: comprada.costCentsPerMonth,
      callsLimitTotal: comprada.callsLimitTotal,
      costCentsLimitTotal: comprada.costCentsLimitTotal,
      delivery: comprada.delivery,
      variasTesis: comprada.variasTesis,
      acostaiaDeId: comprada.id,
      acostaiaId,
    },
    select: { id: true },
  });

  logger.info(
    { acostaiaId, licenseId: licencia.id, compradaId: comprada.id, producto: comprada.productCode },
    'Licencia comprada vinculada en AcostaIA',
  );

  const { urlDelConector } = require('../licensing/license.service');
  return {
    licenseId: licencia.id,
    connectorUrl: urlDelConector(token),
    productCode: comprada.productCode,
    nombre: await nombreDelProducto(comprada.productCode),
    expiresAt: comprada.expiresAt,
  };
}

const acostaiaVinculos = {
  tokenDelEnlace,

  /** Vincula la compra cuyo enlace del conector pegó el usuario. */
  async porEnlace({ acostaiaId, enlace }) {
    const token = tokenDelEnlace(enlace);
    if (!token) {
      throw new ValidationError(
        'Ese no parece un enlace del conector. Cópialo entero de tu panel en acostaresearch.com.',
      );
    }
    const comprada = await prisma.license.findUnique({
      where: { tokenHash: hashToken(token) },
      select: conUsuario,
    });
    if (!comprada) throw new NotFoundError('No encontramos ese conector. Revisa que esté bien copiado.');
    if (comprada.acostaiaDeId || comprada.user?.acostaiaId) {
      throw new ValidationError('Ese conector ya es de AcostaIA. Pega el de tu panel en acostaresearch.com.');
    }
    if (!sePuedeVincular(comprada)) {
      throw new ValidationError('Ese conector está desactivado o caducó. Renuévalo en acostaresearch.com.');
    }
    return emitir(acostaiaId, comprada);
  },

  /** Las compras vigentes de la cuenta de acostaresearch.com con ese correo. */
  async buscar({ email }) {
    const usuario = await prisma.user.findUnique({
      where: { email: String(email).trim().toLowerCase() },
      select: { id: true, acostaiaId: true },
    });
    if (!usuario || usuario.acostaiaId) return [];
    const licencias = await prisma.license.findMany({
      where: { userId: usuario.id, status: 'ACTIVE', acostaiaDeId: null },
      select: conUsuario,
      orderBy: { createdAt: 'desc' },
    });
    const salida = [];
    for (const l of licencias.filter((x) => sePuedeVincular(x))) {
      salida.push({
        licenseId: l.id,
        productCode: l.productCode,
        nombre: await nombreDelProducto(l.productCode),
        expiresAt: l.expiresAt,
        tokenHint: l.tokenHint,
      });
    }
    return salida;
  },

  /** Vincula una de las compras que encontró `buscar` (se vuelve a comprobar el correo). */
  async porCorreo({ acostaiaId, email, licenseId }) {
    const comprada = await prisma.license.findUnique({ where: { id: licenseId }, select: conUsuario });
    if (
      !comprada ||
      comprada.user?.email?.toLowerCase() !== String(email).trim().toLowerCase() ||
      !sePuedeVincular(comprada)
    ) {
      throw new NotFoundError('No encontramos esa licencia en tu cuenta de acostaresearch.com.');
    }
    return emitir(acostaiaId, comprada);
  },

  /** Desvincula: corta el conector de AcostaIA de ese producto. La compra no se toca. */
  async quitar({ acostaiaId, productCode }) {
    const revocadas = await revocar({ acostaiaId, productCode }, 'Desvinculada desde AcostaIA.');
    logger.info({ acostaiaId, producto: productCode, revocadas }, 'Licencia desvinculada en AcostaIA');
    return { revocadas };
  },

  /**
   * Sus vínculos vigentes (la compra sigue valiendo): producto → titular
   * comprador. Los usan «Mis documentos», «Mis fuentes», la subida del avance
   * y Zotero/Mendeley de AcostaIA, para enseñar lo mismo que ve el chat.
   */
  async vigentes(acostaiaId, ahora = new Date()) {
    const hijas = await prisma.license.findMany({
      where: { acostaiaId, status: 'ACTIVE', acostaiaDeId: { not: null } },
      select: {
        userId: true,
        productCode: true,
        acostaiaDe: { select: { status: true, expiresAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return hijas
      .filter((h) => h.acostaiaDe?.status === 'ACTIVE' && (!h.acostaiaDe.expiresAt || h.acostaiaDe.expiresAt > ahora))
      .map((h) => ({ userId: h.userId, productCode: h.productCode }));
  },
};

module.exports = acostaiaVinculos;
