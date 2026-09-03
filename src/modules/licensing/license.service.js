'use strict';

const crypto = require('node:crypto');
const env = require('../../config/env');
const logger = require('../../config/logger');
const { ERROR_CODES } = require('../../config/constants');
const licenseRepository = require('./license.repository');
const { analizar, NIVELES } = require('./license.detector');
const {
  generateOpaqueToken,
  hashToken,
  addDays,
} = require('../../shared/utils/tokens');
const { AppError, NotFoundError } = require('../../shared/errors/AppError');

/**
 * Alfabeto sin caracteres que se confunden al dictarlos por WhatsApp: fuera la
 * O y el 0, la I y el 1. El comprador va a teclear esto a mano.
 */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GRUPOS = 3;
const LARGO_GRUPO = 4;

/** Días de histórico que mira el detector. */
const VENTANA_ANALISIS_DIAS = 30;

function generarCodigo() {
  const grupos = [];
  for (let g = 0; g < GRUPOS; g += 1) {
    let grupo = '';
    for (let i = 0; i < LARGO_GRUPO; i += 1) {
      grupo += ALFABETO[crypto.randomInt(0, ALFABETO.length)];
    }
    grupos.push(grupo);
  }
  return `ACR-${grupos.join('-')}`;
}

/** Normaliza lo que teclea el comprador: mayúsculas y sin espacios sobrantes. */
function normalizarCodigo(codigo) {
  return codigo.trim().toUpperCase().replace(/\s+/g, '');
}

function urlDelConector(token) {
  return `${env.MCP_PUBLIC_URL.replace(/\/+$/, '')}/${token}`;
}

/** Mismo mensaje para código inexistente, ya usado o anulado: no se filtra cuál. */
function codigoInvalido(code = ERROR_CODES.LICENSE_CODE_INVALID) {
  return new AppError('Ese código no es válido o ya se usó.', { statusCode: 400, code });
}

const licenseService = {
  /**
   * Genera códigos de un solo uso. Devuelve los códigos EN CLARO una única vez:
   * en la base de datos solo queda su hash, así que si no se copian ahora, se
   * pierden y hay que generar otros.
   */
  async generateCodes({ cantidad = 1, productCode, buyerEmail, note, createdById, expiresAt }) {
    const producto = productCode ?? env.LICENSE_PRODUCT_CODE;
    const codigos = [];
    const filas = [];

    for (let i = 0; i < cantidad; i += 1) {
      const codigo = generarCodigo();
      codigos.push(codigo);
      filas.push({
        codeHash: hashToken(codigo),
        // Los últimos 4 caracteres bastan para reconocerlo en el panel.
        hint: codigo.slice(-4),
        productCode: producto,
        buyerEmail,
        note,
        createdById,
        expiresAt,
      });
    }

    await licenseRepository.createCodes(filas);
    logger.info({ cantidad, producto, buyerEmail }, 'Códigos de activación generados');

    return { productCode: producto, codes: codigos };
  },

  /**
   * Canjea un código y entrega la licencia con su URL de conector.
   *
   * La URL lleva el token dentro, así que el comprador puede verla y, si quiere,
   * reenviarla. Eso no se puede impedir; se detecta después por el patrón de uso
   * (ver `license.detector.js`) y se corta revocando.
   */
  async redeemCode({ userId, code }) {
    const normalizado = normalizarCodigo(code);
    const registro = await licenseRepository.findCodeByHash(hashToken(normalizado));

    if (!registro) throw codigoInvalido();

    if (registro.status === 'REDEEMED') {
      throw codigoInvalido(ERROR_CODES.LICENSE_CODE_USED);
    }

    if (registro.status === 'VOID') throw codigoInvalido();

    if (registro.expiresAt && registro.expiresAt <= new Date()) {
      throw new AppError('Ese código caducó. Escríbenos y te damos uno nuevo.', {
        statusCode: 400,
        code: ERROR_CODES.LICENSE_CODE_INVALID,
      });
    }

    const token = generateOpaqueToken(32);
    const licencia = await licenseRepository.redeem({
      codeId: registro.id,
      userId,
      productCode: registro.productCode,
      tokenHash: hashToken(token),
      tokenHint: token.slice(0, 8),
      expiresAt:
        env.LICENSE_DURATION_DAYS > 0 ? addDays(new Date(), env.LICENSE_DURATION_DAYS) : null,
    });

    // Sin licencia: otra petición canjeó el mismo código un instante antes.
    if (!licencia) throw codigoInvalido(ERROR_CODES.LICENSE_CODE_USED);

    logger.info(
      { userId, licenseId: licencia.id, producto: registro.productCode },
      'Código canjeado: licencia activada',
    );

    return { license: licencia, connectorUrl: urlDelConector(token) };
  },

  /**
   * Prepara una licencia para una compra pagada por la web.
   *
   * Devuelve los datos para crearla y la URL ya montada, pero no la guarda: de
   * eso se encarga la transacción del cobro, para que la licencia y el pago se
   * confirmen juntos o no se confirme ninguno.
   */
  prepareForPurchase({ userId, productCode, durationDays }) {
    const token = generateOpaqueToken(32);

    return {
      data: {
        userId,
        productCode,
        tokenHash: hashToken(token),
        tokenHint: token.slice(0, 8),
        expiresAt: durationDays > 0 ? addDays(new Date(), durationDays) : null,
      },
      connectorUrl: urlDelConector(token),
    };
  },

  /**
   * Valida el token que viene en la URL del conector. Es la puerta de entrada
   * del MCP, así que se comprueba todo aquí: existe, está activa, no ha caducado
   * y la cuenta del dueño sigue en pie.
   */
  async authenticate(token) {
    if (!token) {
      throw new AppError('Falta la licencia.', {
        statusCode: 401,
        code: ERROR_CODES.LICENSE_INVALID,
      });
    }

    const licencia = await licenseRepository.findByTokenHash(hashToken(token));

    if (!licencia) {
      throw new AppError('Esta licencia no existe.', {
        statusCode: 401,
        code: ERROR_CODES.LICENSE_INVALID,
      });
    }

    if (licencia.status !== 'ACTIVE') {
      throw new AppError('Esta licencia está desactivada. Escríbenos si crees que es un error.', {
        statusCode: 403,
        code: ERROR_CODES.LICENSE_REVOKED,
      });
    }

    if (licencia.expiresAt && licencia.expiresAt <= new Date()) {
      throw new AppError('Esta licencia caducó.', {
        statusCode: 403,
        code: ERROR_CODES.LICENSE_REVOKED,
      });
    }

    if (licencia.user.status !== 'ACTIVE') {
      throw new AppError('La cuenta asociada a esta licencia no está activa.', {
        statusCode: 403,
        code: ERROR_CODES.LICENSE_REVOKED,
      });
    }

    return licencia;
  },

  /**
   * Anota la llamada. Nunca lanza: si falla el registro de uso no se le puede
   * negar el servicio a un cliente que sí pagó.
   */
  async recordUsage({ licenseId, tool, prompt, sessionId, ok = true, durationMs }) {
    try {
      await licenseRepository.recordUsage({
        licenseId,
        tool,
        // Solo el hash: sirve para comparar consultas entre sí sin conservar
        // lo que escribió el tesista, que es material de su tesis.
        promptHash: prompt ? hashToken(prompt) : null,
        sessionId: sessionId ?? null,
        ok,
        durationMs,
      });
    } catch (error) {
      logger.error({ err: error, licenseId }, 'No se pudo registrar el uso de la licencia');
    }
  },

  listForUser(userId) {
    return licenseRepository.listForUser(userId);
  },

  /**
   * Genera una URL nueva para una licencia y anula la anterior.
   *
   * Hace falta porque del token solo se guarda el hash: si el comprador pierde
   * la URL, no hay forma de volver a mostrársela. Rotar también es la salida
   * cuando sospecha que se la copiaron, sin tener que revocarle el acceso.
   */
  async rotate({ licenseId, userId }) {
    const licencia = await licenseRepository.findOwned(licenseId, userId);
    if (!licencia) throw new NotFoundError('No encontramos esa licencia.');

    if (licencia.status !== 'ACTIVE') {
      throw new AppError('Esta licencia está desactivada; no se le puede generar una URL nueva.', {
        statusCode: 409,
        code: ERROR_CODES.LICENSE_REVOKED,
      });
    }

    const token = generateOpaqueToken(32);
    const actualizada = await licenseRepository.replaceToken(licenseId, {
      tokenHash: hashToken(token),
      tokenHint: token.slice(0, 8),
    });

    logger.info({ licenseId, userId }, 'URL del conector regenerada');
    return { license: actualizada, connectorUrl: urlDelConector(token) };
  },

  listAll(filtros) {
    return licenseRepository.listAll(filtros);
  },

  /** Ficha completa de una licencia: estado, uso reciente y diagnóstico. */
  async inspect(id) {
    const licencia = await licenseRepository.findById(id);
    if (!licencia) throw new NotFoundError('No encontramos esa licencia.');

    const desde = addDays(new Date(), -VENTANA_ANALISIS_DIAS);
    const usos = await licenseRepository.usagesSince(id, desde);

    return {
      license: licencia,
      diagnostico: analizar(usos),
      usosRecientes: await licenseRepository.recentUsages(id),
    };
  },

  /**
   * Revisa todas las licencias activas y devuelve las que pintan mal.
   *
   * A propósito NO revoca nada por su cuenta. Una revocación automática por una
   * señal estadística puede dejar tirado a un cliente legítimo en plena semana
   * de sustentación; que la última palabra la tenga una persona sale más barato
   * que perder a un comprador que sí pagó.
   */
  async review({ limit = 200 } = {}) {
    const licencias = await licenseRepository.listAll({ status: 'ACTIVE', limit });
    const desde = addDays(new Date(), -VENTANA_ANALISIS_DIAS);
    const hallazgos = [];

    for (const licencia of licencias) {
      const usos = await licenseRepository.usagesSince(licencia.id, desde);
      const diagnostico = analizar(usos);

      if (diagnostico.nivel !== NIVELES.NORMAL) {
        hallazgos.push({ license: licencia, diagnostico });
      }
    }

    // Primero lo más grave.
    hallazgos.sort((a, b) => (a.diagnostico.nivel === NIVELES.SOSPECHA_ALTA ? -1 : 1));
    return hallazgos;
  },

  async revoke(id, reason) {
    const licencia = await licenseRepository.findById(id);
    if (!licencia) throw new NotFoundError('No encontramos esa licencia.');

    const actualizada = await licenseRepository.setStatus(id, {
      status: 'REVOKED',
      revokedReason: reason,
    });

    logger.warn({ licenseId: id, reason }, 'Licencia revocada');
    return actualizada;
  },

  async reactivate(id) {
    const licencia = await licenseRepository.findById(id);
    if (!licencia) throw new NotFoundError('No encontramos esa licencia.');

    logger.info({ licenseId: id }, 'Licencia reactivada');
    return licenseRepository.setStatus(id, { status: 'ACTIVE' });
  },

  listCodes(filtros) {
    return licenseRepository.listCodes(filtros);
  },

  async voidCode(id) {
    const { count } = await licenseRepository.voidCode(id);
    if (count === 0) {
      throw new AppError('Ese código ya se canjeó o ya estaba anulado.', {
        statusCode: 409,
        code: ERROR_CODES.LICENSE_CODE_USED,
      });
    }
  },
};

module.exports = licenseService;
