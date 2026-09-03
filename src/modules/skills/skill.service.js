'use strict';

const prisma = require('../../lib/prisma');

/**
 * Catálogo de skills.
 *
 * Todo lo que sale de aquí es público para el comprador: nombre y resumen. El
 * contenido operativo no pasa por este módulo ni por ningún otro que responda
 * al conector; ese es el punto de todo el diseño.
 */

const catalogoSelect = {
  code: true,
  orden: true,
  displayName: true,
  summary: true,
  anthropicSkillId: true,
};

const skillService = {
  /** Skills activas, en el orden del método. */
  listCatalog() {
    return prisma.skill.findMany({
      where: { active: true },
      select: catalogoSelect,
      orderBy: { orden: 'asc' },
    });
  },

  findByCode(code) {
    return prisma.skill.findUnique({ where: { code } });
  },

  /** Skills ya registradas en la Skills API: las únicas invocables. */
  listInvocables() {
    return prisma.skill.findMany({
      where: { active: true, anthropicSkillId: { not: null } },
      select: catalogoSelect,
      orderBy: { orden: 'asc' },
    });
  },

  /** Guarda los identificadores que devuelve la Skills API tras subir el bundle. */
  registerUpload(code, { anthropicSkillId, anthropicVersionId }) {
    return prisma.skill.update({
      where: { code },
      data: { anthropicSkillId, anthropicVersionId },
    });
  },
};

module.exports = skillService;
