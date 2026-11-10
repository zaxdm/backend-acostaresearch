'use strict';

const crypto = require('node:crypto');
const env = require('../../config/env');
const prisma = require('../../lib/prisma');
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

const base = () => env.HUELLA_URL.replace(/\/$/, '');

/** Un administrador entra sin plan comprado (para probar y ayudar), por un día. */
const PLAN_DE_ADMIN = () => ({ nivel: 'POWER', expiresAt: new Date(Date.now() + 24 * 3600 * 1000) });

/**
 * Promoción (10-nov-2026): con HUELLA_GRATIS_HASTA en el futuro, quien ya tiene
 * matrícula (una licencia vigente de un método) entra hasta esa hora. La sesión
 * de Huella vence con ella (planHasta).
 */
async function planGratis(userId, ahora = new Date()) {
  const hasta = env.HUELLA_GRATIS_HASTA ? new Date(env.HUELLA_GRATIS_HASTA) : null;
  if (!hasta || hasta <= ahora) return null;
  const matriculas = await prisma.license.count({
    where: { userId, status: 'ACTIVE', OR: [{ expiresAt: null }, { expiresAt: { gt: ahora } }] },
  });
  return matriculas > 0 ? { nivel: 'ESTANDAR', expiresAt: hasta } : null;
}

/** El plan de IA vigente, o un error que la web sabe enseñar. */
async function planVigente(userId, esAdmin = false) {
  if (!env.HUELLA_SECRETO || !env.HUELLA_URL) {
    throw new AppError('Huella IA todavía no está conectada a tu cuenta. Inténtalo más tarde.', { statusCode: 503 });
  }
  const plan = (await acostaiaPlanes.deUsuario(userId)) ?? (esAdmin ? PLAN_DE_ADMIN() : null) ?? (await planGratis(userId));
  if (!plan) {
    throw new AppError('Huella IA viene con el plan de IA (Epicuro + Huella IA). Actívalo en Planes.', {
      statusCode: 403,
      code: 'SIN_PLAN_IA',
    });
  }
  return plan;
}

const tokenPara = (email, plan, vigenciaMs = VIGENCIA_MS) =>
  firmar({
    email: String(email).toLowerCase(),
    nivel: plan.nivel,
    planHasta: new Date(plan.expiresAt).getTime(),
    exp: Date.now() + vigenciaMs,
  });

const huellaService = {
  firmar,

  /** El enlace para abrir Huella IA, si la persona tiene la IA vigente. */
  async enlace({ userId, email, esAdmin = false }) {
    const plan = await planVigente(userId, esAdmin);
    return { url: `${base()}/?t=${encodeURIComponent(tokenPara(email, plan))}` };
  },

  /**
   * Manda a Huella el avance de su proyecto (el mismo Word de «Descargar mi
   * avance») y devuelve el enlace que abre Huella con ese análisis en «Mis
   * trabajos» (11-nov-2026). Huella lo cuenta en su tope de 5 al día: el
   * backend entra con la misma sesión firmada que el enlace, que dura 2 minutos.
   */
  async analizarAvance({ userId, email, productCode, esAdmin = false }, { pedir = fetch } = {}) {
    const plan = await planVigente(userId, esAdmin);
    const projectService = require('../projects/project.service');
    const documento = await projectService.armarWord(userId, productCode);
    if (!documento) {
      throw new AppError('Todavía no hay ningún capítulo escrito en tu proyecto para revisar.', { statusCode: 404 });
    }

    const formulario = new FormData();
    formulario.append(
      'archivo',
      new Blob([documento.buffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      documento.nombreArchivo || 'Mi avance.docx',
    );
    let respuesta;
    try {
      respuesta = await pedir(`${base()}/api/analizar`, {
        method: 'POST',
        headers: { Cookie: `huella_sesion=${tokenPara(email, plan, 2 * 60 * 1000)}` },
        body: formulario,
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new AppError('Huella IA no respondió. Inténtalo otra vez en un momento.', { statusCode: 503 });
    }
    const datos = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok || !datos.id) {
      // 429 = ya usó sus 5 de hoy; Huella da el motivo en español.
      throw new AppError(String(datos.detail ?? 'Huella IA no pudo recibir tu avance.'), {
        statusCode: respuesta.status === 429 ? 429 : 502,
      });
    }
    const token = encodeURIComponent(tokenPara(email, plan));
    return {
      id: datos.id,
      restantes: datos.restantes ?? null,
      url: `${base()}/?t=${token}&ver=${encodeURIComponent(datos.id)}`,
    };
  },
};

module.exports = huellaService;
