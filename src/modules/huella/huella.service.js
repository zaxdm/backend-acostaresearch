'use strict';

const crypto = require('node:crypto');
const env = require('../../config/env');
const { AppError } = require('../../shared/errors/AppError');
const acostaiaPlanes = require('../acostaia/acostaia.planes');

/**
 * Huella IA, el detector (10-nov-2026). Viene con la IA: quien tiene un plan de
 * Epicuro vigente entra a huella.acostaresearch.com con un enlace firmado que
 * se genera aquí. Huella comprueba la firma con el mismo secreto y lleva su
 * propio tope de 5 trabajos al día por correo.
 *
 * El enlace es corto (10 minutos) y solo dice quién es y hasta cuándo vale el
 * plan: no lleva nada que sirva fuera de Huella.
 */

const VIGENCIA_MS = 10 * 60 * 1000;

const b64 = (texto) => Buffer.from(texto).toString('base64url');

function firmar(datos) {
  const cuerpo = b64(JSON.stringify(datos));
  const firma = crypto.createHmac('sha256', env.HUELLA_SECRETO).update(cuerpo).digest('base64url');
  return `${cuerpo}.${firma}`;
}

const huellaService = {
  firmar,

  /** El enlace para abrir Huella IA, si la persona tiene la IA vigente. */
  async enlace({ userId, email }) {
    if (!env.HUELLA_SECRETO || !env.HUELLA_URL) {
      throw new AppError('Huella IA todavía no está conectada a tu cuenta. Inténtalo más tarde.', { statusCode: 503 });
    }
    const plan = await acostaiaPlanes.deUsuario(userId);
    if (!plan) {
      throw new AppError('Huella IA viene con el plan de IA (Epicuro + Huella IA). Actívalo en Planes.', {
        statusCode: 403,
        code: 'SIN_PLAN_IA',
      });
    }
    const token = firmar({
      email,
      nivel: plan.nivel,
      planHasta: new Date(plan.expiresAt).getTime(),
      exp: Date.now() + VIGENCIA_MS,
    });
    return { url: `${env.HUELLA_URL.replace(/\/$/, '')}/?t=${encodeURIComponent(token)}` };
  },
};

module.exports = huellaService;
