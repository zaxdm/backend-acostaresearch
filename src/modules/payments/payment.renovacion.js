'use strict';

const licenseRepository = require('../licensing/license.repository');
const { AppError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');
const DIAS_PARA_RENOVAR = 30;

/** Se comprueba antes de crear una orden; nunca después de cobrarla. */
async function comprobarRenovacion(userId, plan, ahora = new Date()) {
  if (!userId || plan.kind !== 'LICENSE' || !plan.productCode) return;
  const licencias = await licenseRepository.listForUser(userId);
  const vigentes = licencias.filter(l => l.productCode === plan.productCode && l.status === 'ACTIVE');
  const limite = ahora.getTime() + DIAS_PARA_RENOVAR * 86_400_000;
  if (vigentes.some(l => l.expiresAt === null || new Date(l.expiresAt).getTime() > limite)) {
    throw new AppError('Este producto ya está activo. Puedes renovarlo durante los últimos 30 días de vigencia.', {
      statusCode: 409, code: ERROR_CODES.PLAN_NOT_PURCHASABLE,
    });
  }
}

module.exports = { comprobarRenovacion, DIAS_PARA_RENOVAR };
