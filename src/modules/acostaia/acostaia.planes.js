'use strict';

const prisma = require('../../lib/prisma');
const { ROLES } = require('../../config/constants');

/**
 * Los planes de Epicuro.ai (10-nov-2026): Estándar y Power, de 30 días, que se
 * venden aquí como cualquier otro plan (Culqi, Hotmart, boleta, /admin).
 *
 * Una fila por cuenta (`epicuro_planes`). Comprar o renovar suma los días del
 * plan a lo que le quede y deja el nivel del plan comprado: quien pasa de
 * Estándar a Power conserva los días que tenía, ya con Power.
 *
 * Epicuro no recibe avisos: pregunta por el correo (`deCorreo`) cuando lo
 * necesita. Así una entrega no se pierde aunque Epicuro esté caído.
 */

const DIA_MS = 24 * 60 * 60 * 1000;

const esPlanDeEpicuro = (plan) => plan?.kind === 'EPICURO';

/** Lo que ve Epicuro: el nivel y hasta cuándo, o null si no tiene o ya venció. */
function vista(fila, ahora = new Date()) {
  if (!fila || new Date(fila.expiresAt) <= ahora) return null;
  return { nivel: fila.nivel, planCode: fila.planCode, expiresAt: fila.expiresAt };
}

const acostaiaPlanes = {
  esPlanDeEpicuro,

  /**
   * Entrega el plan comprado, DENTRO de la transacción del cobro (ver
   * `payment.delivery`). El cerrojo contra cobros dobles es el de `settle`.
   */
  async entregar({ userId, plan }, tx) {
    const ahora = new Date();
    const actual = await tx.epicuroPlan.findUnique({ where: { userId } });
    const vigente = Boolean(actual) && new Date(actual.expiresAt) > ahora;
    const desde = vigente ? new Date(actual.expiresAt) : ahora;
    const expiresAt = new Date(desde.getTime() + plan.durationDays * DIA_MS);
    const datos = { nivel: plan.productCode, planCode: plan.code, expiresAt };

    const fila = actual
      ? await tx.epicuroPlan.update({
          where: { userId },
          // Si ya había vencido, el plan empieza de nuevo hoy.
          data: { ...datos, ...(!vigente && { activatedAt: ahora }) },
        })
      : await tx.epicuroPlan.create({ data: { userId, ...datos } });
    return { ...fila, renovada: vigente };
  },

  /**
   * El plan vigente de quien tiene ese correo en acostaresearch.com. Un ADMIN
   * sin plan comprado entra con Power (11-nov-2026), por un día que Epicuro
   * renueva solo al volver a preguntar: así deja de valer si pierde el rol.
   */
  async deCorreo(email) {
    const usuario = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: { role: true, epicuroPlan: true },
    });
    const comprado = vista(usuario?.epicuroPlan);
    if (comprado || usuario?.role !== ROLES.ADMIN) return comprado;
    return { nivel: 'POWER', planCode: 'ADMIN', expiresAt: new Date(Date.now() + DIA_MS) };
  },

  /** El de una cuenta, para volver a enseñar lo entregado en un reintento. */
  async deUsuario(userId) {
    return vista(await prisma.epicuroPlan.findUnique({ where: { userId } }));
  },

  /**
   * Un cobro devuelto (reembolso o contracargo de Hotmart): se le restan los
   * días de ese plan. Si con eso ya no le queda nada, vence ahora.
   */
  async descontar({ userId, dias }) {
    const fila = await prisma.epicuroPlan.findUnique({ where: { userId } });
    const ahora = new Date();
    if (!fila || new Date(fila.expiresAt) <= ahora) return 'ya_revocada';
    const nueva = new Date(new Date(fila.expiresAt).getTime() - dias * DIA_MS);
    if (nueva > ahora) {
      await prisma.epicuroPlan.update({ where: { userId }, data: { expiresAt: nueva } });
      return 'acortada';
    }
    await prisma.epicuroPlan.update({ where: { userId }, data: { expiresAt: ahora } });
    return 'revocada';
  },
};

module.exports = acostaiaPlanes;
