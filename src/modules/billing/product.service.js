'use strict';

const prisma = require('../../lib/prisma');
const logger = require('../../config/logger');
const { NotFoundError, ConflictError } = require('../../shared/errors/AppError');

/**
 * Grupos de skills.
 *
 * Un grupo es un producto vendible: un conjunto de capítulos con su precio, su
 * duración y sus topes de uso. «Método de tesis» es uno; «humanizar texto»
 * puede ser otro, con otro precio y otros capítulos dentro.
 *
 * NO es un concepto nuevo en la base de datos: un grupo ES un `Plan` de tipo
 * LICENSE. Se hace así porque un grupo tiene que tener precio, caducidad y
 * poder venderse, que es exactamente lo que ya sabe hacer un plan. Inventar
 * una tabla aparte habría obligado a duplicar el precio en dos sitios, y dos
 * sitios con el mismo precio acaban siempre diciendo cosas distintas.
 *
 * El `productCode` es la bisagra: lo lleva el plan, lo lleva cada licencia
 * emitida y lo lleva cada skill. El conector cruza los tres.
 */

const grupoSelect = {
  id: true,
  code: true,
  productCode: true,
  name: true,
  description: true,
  priceCents: true,
  priceUsdCents: true,
  currency: true,
  durationDays: true,
  active: true,
  sortOrder: true,
  mcpCallsPerDay: true,
  mcpCallsPerMonth: true,
  mcpCostCentsPerMonth: true,
  mcpCallsTotal: true,
  mcpCostCentsTotal: true,
  mcpDelivery: true,
};

/** Cuántos capítulos cuelgan de cada grupo, para enseñarlo en el panel. */
async function contarSkills(grupos) {
  const conteo = await prisma.skill.groupBy({
    by: ['productCode'],
    _count: { _all: true },
  });

  const porGrupo = new Map(conteo.map((fila) => [fila.productCode, fila._count._all]));
  return grupos.map((grupo) => ({ ...grupo, skills: porGrupo.get(grupo.productCode) ?? 0 }));
}

const productService = {
  /** Todos los grupos, activos o no: el panel necesita ver los retirados. */
  async list() {
    const grupos = await prisma.plan.findMany({
      where: { kind: 'LICENSE' },
      select: grupoSelect,
      orderBy: { sortOrder: 'asc' },
    });

    return contarSkills(grupos);
  },

  /**
   * Crea un grupo.
   *
   * El `code` del plan y su `productCode` se mantienen iguales a propósito:
   * son dos campos porque el modelo permite varios planes del mismo producto
   * —por ejemplo, un precio de lanzamiento— pero mientras eso no exista,
   * tenerlos distintos solo sería una fuente de despistes.
   */
  async create(datos) {
    const code = datos.code.trim().toUpperCase();

    const existente = await prisma.plan.findUnique({ where: { code }, select: { id: true } });
    if (existente) {
      throw new ConflictError(`Ya hay un grupo con el código «${code}».`);
    }

    const ultimo = await prisma.plan.findFirst({
      where: { kind: 'LICENSE' },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });

    const grupo = await prisma.plan.create({
      data: {
        code,
        productCode: code,
        kind: 'LICENSE',
        name: datos.name.trim(),
        description: datos.description?.trim() || null,
        priceCents: datos.priceCents,
        priceUsdCents: datos.priceUsdCents ?? null,
        currency: 'PEN',
        durationDays: datos.durationDays,
        active: datos.active ?? true,
        sortOrder: (ultimo?.sortOrder ?? 0) + 1,
        // Un plan de licencia no reparte palabras: eso es de las bolsas del
        // humanizador. La columna es obligatoria, así que va a cero.
        words: 0,
        mcpDelivery: datos.mcpDelivery ?? 'INSTRUCTIONS',
        mcpCallsPerDay: datos.mcpCallsPerDay ?? 200,
        mcpCallsPerMonth: 0,
        mcpCostCentsPerMonth: 0,
        mcpCallsTotal: 0,
        mcpCostCentsTotal: 0,
      },
      select: grupoSelect,
    });

    logger.info({ code: grupo.code, precio: grupo.priceCents }, 'Grupo creado desde el panel');
    return { ...grupo, skills: 0 };
  },

  /**
   * Edita un grupo.
   *
   * El código no se toca nunca: es la referencia que llevan las licencias ya
   * emitidas y las skills que cuelgan de él. Cambiarlo dejaría a los
   * compradores actuales apuntando a un producto que ya no existe.
   */
  async update(code, cambios) {
    const existente = await prisma.plan.findFirst({
      where: { code, kind: 'LICENSE' },
      select: { id: true, code: true, productCode: true },
    });
    if (!existente) throw new NotFoundError('Ese grupo no existe.');

    const grupo = await prisma.plan.update({
      where: { id: existente.id },
      data: {
        ...(cambios.name === undefined ? {} : { name: cambios.name.trim() }),
        ...(cambios.description === undefined
          ? {}
          : { description: cambios.description?.trim() || null }),
        ...(cambios.priceCents === undefined ? {} : { priceCents: cambios.priceCents }),
        ...(cambios.priceUsdCents === undefined ? {} : { priceUsdCents: cambios.priceUsdCents }),
        ...(cambios.durationDays === undefined ? {} : { durationDays: cambios.durationDays }),
        ...(cambios.active === undefined ? {} : { active: cambios.active }),
        ...(cambios.mcpCallsPerDay === undefined ? {} : { mcpCallsPerDay: cambios.mcpCallsPerDay }),
      },
      select: grupoSelect,
    });

    logger.info({ code: grupo.code }, 'Grupo actualizado desde el panel');
    const [conConteo] = await contarSkills([grupo]);
    return conConteo;
  },

  /**
   * Retira un grupo del catálogo.
   *
   * No se borra: hay licencias emitidas que apuntan a él y capítulos que
   * cuelgan de su código. Borrar la fila dejaría a esos compradores con una
   * licencia hacia un producto inexistente. Desactivar lo saca de la venta y
   * deja intacto lo ya vendido, que es lo que se quiere de verdad.
   */
  async retire(code) {
    return productService.update(code, { active: false });
  },
};

module.exports = productService;
