'use strict';

const prisma = require('../../lib/prisma');
const logger = require('../../config/logger');
const { NotFoundError, ConflictError } = require('../../shared/errors/AppError');
const skillBundle = require('./skill.bundle');
const skillDelivery = require('./skill.delivery');

/**
 * Catálogo de skills.
 *
 * Lo que sale por `listCatalog` es público para el comprador: nombre y resumen.
 * El contenido operativo no pasa por este módulo ni por ningún otro que
 * responda al conector; ese es el punto de todo el diseño.
 */

const catalogoSelect = {
  code: true,
  productCode: true,
  orden: true,
  displayName: true,
  summary: true,
  anthropicSkillId: true,
};

/** Lo que ve el administrador: todo menos la ruta del bundle. */
const adminSelect = {
  id: true,
  code: true,
  productCode: true,
  orden: true,
  displayName: true,
  summary: true,
  active: true,
  skillMdBytes: true,
  anthropicSkillId: true,
  createdAt: true,
  updatedAt: true,
};

/**
 * Filtro de grupo para una licencia.
 *
 * Una licencia solo ve los capítulos de SU grupo. Se cuelan también los que no
 * tienen grupo asignado: son la red de seguridad para una skill subida sin
 * elegirlo, y es preferible que se vea de más —y se note— a que desaparezca en
 * silencio del conector de todo el mundo.
 *
 * Sin `productCode` no se filtra nada: es lo que necesita la portada pública,
 * que enseña el catálogo entero a quien todavía no ha comprado.
 */
function delGrupo(productCode) {
  if (!productCode) return {};
  return { OR: [{ productCode }, { productCode: null }] };
}

/**
 * Comprueba que el grupo existe antes de colgarle un capítulo.
 *
 * Un grupo no es una etiqueta libre: es el `productCode` de un plan que alguien
 * puede comprar. Aceptar uno inventado dejaría el capítulo colgando de un
 * producto inexistente —invisible para todas las licencias— y sin ningún aviso.
 */
async function exigirGrupo(productCode) {
  const plan = await prisma.plan.findFirst({
    where: { kind: 'LICENSE', productCode },
    select: { code: true },
  });

  if (!plan) {
    throw new NotFoundError(
      `No hay ningún grupo con el código «${productCode}». Créalo primero en Grupos.`,
    );
  }
}

const skillService = {
  /**
   * Skills activas, en el orden del método.
   *
   * Con `productCode` devuelve solo las del grupo que esa licencia compró; sin
   * él, todas: es la misma consulta que alimenta la web pública.
   */
  listCatalog(productCode = null) {
    return prisma.skill.findMany({
      where: { active: true, ...delGrupo(productCode) },
      select: catalogoSelect,
      orderBy: { orden: 'asc' },
    });
  },

  /**
   * ¿Puede esta licencia pedir este capítulo?
   *
   * Se comprueba en la entrega y no solo en el listado: que algo no salga en
   * la lista no impide pedirlo por su código, y el código de un capítulo no es
   * ningún secreto.
   */
  perteneceAlGrupo(skill, productCode) {
    return skill.productCode === null || skill.productCode === productCode;
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

  // ── Administración ───────────────────────────────────────────────────────

  /** Todas, activas o no, para el panel. */
  listAll() {
    return prisma.skill.findMany({ select: adminSelect, orderBy: { orden: 'asc' } });
  },

  /**
   * Comprueba un bundle sin guardarlo.
   *
   * Sirve para que el panel enseñe qué va a pasar —qué código trae, cuántos
   * pasos, si reemplaza a una existente— antes de que el administrador
   * confirme. Subir por error encima de un capítulo bueno es el fallo que hay
   * que hacer difícil.
   */
  async inspectBundle(buffer) {
    const datos = skillBundle.analizar(buffer);
    const existente = await prisma.skill.findUnique({
      where: { code: datos.code },
      select: adminSelect,
    });

    return { ...datos, reemplaza: existente };
  },

  /**
   * Guarda el bundle y crea o actualiza su ficha.
   *
   * El código sale SIEMPRE del `name` del SKILL.md, no de un campo del
   * formulario: es la clave con la que el conector pide el capítulo, y si el
   * administrador pudiera escribirla a mano acabaría habiendo una skill cuyo
   * archivo dice una cosa y cuya ficha dice otra.
   */
  async upsertFromBundle({ buffer, displayName, summary, orden, active, productCode }) {
    const datos = skillBundle.analizar(buffer);
    const existente = await prisma.skill.findUnique({ where: { code: datos.code } });

    // Si se indica grupo, tiene que existir y tiene que ser vendible. Un
    // `productCode` inventado dejaría el capítulo colgando de un producto que
    // nadie puede comprar: invisible para todos y sin ningún aviso.
    const grupo = productCode?.trim() || null;
    if (grupo) await exigirGrupo(grupo);

    const ruta = skillBundle.guardar(datos.code, buffer);

    // El bundle vive en memoria mientras el servidor está en pie: sin esto se
    // seguiría sirviendo el contenido anterior hasta el próximo reinicio.
    skillDelivery.olvidar();

    // El número que se le enseña al administrador es el de tramos que va a
    // entregar el conector, no el de encabezados `## Paso` del documento. Una
    // skill sin pasos numerados se sirve igual, por secciones, y decirle
    // «0 pasos» le haría pensar que se subió mal.
    const tramos = skillDelivery.contarTramos({ bundlePath: ruta });

    const comun = {
      displayName: displayName?.trim() || existente?.displayName || datos.displayNameSugerido,
      summary: summary?.trim() || existente?.summary || datos.summarySugerido,
      bundlePath: ruta,
      skillMdBytes: datos.skillMdBytes,
    };

    if (existente) {
      const skill = await prisma.skill.update({
        where: { code: datos.code },
        data: {
          ...comun,
          orden: orden ?? existente.orden,
          active: active ?? existente.active,
          // Reemplazar el archivo no cambia de grupo por sí solo: si no se
          // indica uno, se queda donde estaba.
          productCode: grupo ?? existente.productCode,
          // El bundle cambió, así que lo que hay subido a la Skills API ya no
          // corresponde. Se borra la referencia para que `subir-skills` lo
          // vuelva a publicar y no se sirva una versión vieja.
          anthropicSkillId: null,
          anthropicVersionId: null,
        },
        select: adminSelect,
      });

      logger.info({ code: skill.code, tramos }, 'Skill actualizada desde el panel');
      return { skill, tramos, creada: false };
    }

    // El orden se cuenta DENTRO del grupo: cada producto es un método con su
    // propia secuencia. Numerarlos a lo largo de toda la tabla haría que el
    // primer capítulo de un grupo nuevo se llamara «10».
    const ultima = await prisma.skill.findFirst({
      where: { productCode: grupo },
      orderBy: { orden: 'desc' },
      select: { orden: true },
    });

    const skill = await prisma.skill.create({
      data: {
        ...comun,
        code: datos.code,
        productCode: grupo,
        orden: orden ?? (ultima ? ultima.orden + 1 : 1),
        active: active ?? true,
      },
      select: adminSelect,
    });

    logger.info({ code: skill.code, tramos }, 'Skill añadida desde el panel');
    return { skill, tramos, creada: true };
  },

  /** Edita la ficha. No toca el archivo: para eso se vuelve a subir el bundle. */
  async updateMeta(id, cambios) {
    const existente = await prisma.skill.findUnique({ where: { id } });
    if (!existente) throw new NotFoundError('Esa skill no existe.');

    // Cambiar de grupo es mover el capítulo de un producto a otro, así que el
    // destino tiene que existir. La cadena vacía significa «sin grupo».
    if (cambios.productCode !== undefined) {
      const grupo = cambios.productCode?.trim() || null;
      if (grupo) await exigirGrupo(grupo);
      cambios = { ...cambios, productCode: grupo };
    }

    return prisma.skill.update({ where: { id }, data: cambios, select: adminSelect });
  },

  /**
   * Quita la ficha del catálogo.
   *
   * El .skill se queda en disco a propósito: borrar el archivo desde una
   * petición web es irreversible y nadie lo pide de verdad. Si hace falta, se
   * vuelve a subir; si sobra, se borra a mano en el servidor.
   */
  async remove(id) {
    const existente = await prisma.skill.findUnique({ where: { id } });
    if (!existente) throw new NotFoundError('Esa skill no existe.');

    if (existente.active) {
      throw new ConflictError('Desactívala antes de quitarla, para no dejar sin capítulo a quien esté trabajando.');
    }

    await prisma.skill.delete({ where: { id } });
    skillDelivery.olvidar();

    logger.warn({ code: existente.code }, 'Skill retirada del catálogo');
    return { code: existente.code, bundlePath: existente.bundlePath };
  },
};

module.exports = skillService;
