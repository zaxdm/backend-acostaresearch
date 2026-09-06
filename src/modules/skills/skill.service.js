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

const gruposSelect = { select: { productCode: true } };

const catalogoSelect = {
  code: true,
  orden: true,
  displayName: true,
  summary: true,
  anthropicSkillId: true,
  groups: gruposSelect,
};

/** Lo que ve el administrador: todo menos la ruta del bundle. */
const adminSelect = {
  id: true,
  code: true,
  groups: gruposSelect,
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
 * están en ninguno: son la red de seguridad para una skill subida sin elegirlo,
 * y es preferible que se vea de más —y se note— a que desaparezca en silencio
 * del conector de todo el mundo.
 *
 * Sin `productCode` no se filtra nada: es lo que necesita la portada pública,
 * que enseña el catálogo entero a quien todavía no ha comprado.
 */
function delGrupo(productCode) {
  if (!productCode) return {};
  return { OR: [{ groups: { none: {} } }, { groups: { some: { productCode } } }] };
}

/** Aplana `groups` a una lista de códigos: es lo que espera quien lo consume. */
function conGrupos(skill) {
  if (!skill) return skill;
  const { groups, ...resto } = skill;
  return { ...resto, productCodes: (groups ?? []).map((g) => g.productCode) };
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
  async listCatalog(productCode = null) {
    const skills = await prisma.skill.findMany({
      where: { active: true, ...delGrupo(productCode) },
      select: catalogoSelect,
      orderBy: { orden: 'asc' },
    });
    return skills.map(conGrupos);
  },

  /**
   * ¿Puede esta licencia pedir este capítulo?
   *
   * Se comprueba en la entrega y no solo en el listado: que algo no salga en
   * la lista no impide pedirlo por su código, y el código de un capítulo no es
   * ningún secreto.
   */
  perteneceAlGrupo(skill, productCode) {
    const suyos = skill.productCodes ?? [];
    return suyos.length === 0 || suyos.includes(productCode);
  },

  async findByCode(code) {
    const skill = await prisma.skill.findUnique({
      where: { code },
      include: { groups: gruposSelect },
    });
    return conGrupos(skill);
  },

  /** Skills ya registradas en la Skills API: las únicas invocables. */
  async listInvocables() {
    const skills = await prisma.skill.findMany({
      where: { active: true, anthropicSkillId: { not: null } },
      select: catalogoSelect,
      orderBy: { orden: 'asc' },
    });
    return skills.map(conGrupos);
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
  async listAll() {
    const skills = await prisma.skill.findMany({ select: adminSelect, orderBy: { orden: 'asc' } });
    return skills.map(conGrupos);
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

    return { ...datos, reemplaza: conGrupos(existente) };
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
    // Se normaliza ANTES de nada y se guarda lo normalizado: si llegó un
    // SKILL.md suelto, lo que va al disco es ya el bundle envuelto. Guardar el
    // archivo original dejaría en la carpeta del conector algo que después no
    // se puede abrir como zip.
    const bundle = skillBundle.normalizar(buffer);
    const datos = skillBundle.analizar(bundle);
    const existente = await prisma.skill.findUnique({ where: { code: datos.code } });

    // Si se indica grupo, tiene que existir y tiene que ser vendible. Un
    // `productCode` inventado dejaría el capítulo colgando de un producto que
    // nadie puede comprar: invisible para todos y sin ningún aviso.
    const grupo = productCode?.trim() || null;
    if (grupo) await exigirGrupo(grupo);

    const ruta = skillBundle.guardar(datos.code, bundle);

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
          // Subirlo desde un grupo lo AÑADE a ese grupo; no lo saca de los
          // demás. Volver a subir el archivo desde el pack con humanizador no
          // puede dejar sin capítulo al método de tesis.
          ...(grupo
            ? {
                groups: {
                  connectOrCreate: {
                    where: { skillId_productCode: { skillId: existente.id, productCode: grupo } },
                    create: { productCode: grupo },
                  },
                },
              }
            : {}),
          // El bundle cambió, así que lo que hay subido a la Skills API ya no
          // corresponde. Se borra la referencia para que `subir-skills` lo
          // vuelva a publicar y no se sirva una versión vieja.
          anthropicSkillId: null,
          anthropicVersionId: null,
        },
        select: adminSelect,
      });

      logger.info({ code: skill.code, tramos }, 'Skill actualizada desde el panel');
      return { skill: conGrupos(skill), tramos, creada: false };
    }

    // El orden se cuenta DENTRO del grupo: cada producto es un método con su
    // propia secuencia. Numerarlos a lo largo de toda la tabla haría que el
    // primer capítulo de un grupo nuevo se llamara «10».
    const ultima = await prisma.skill.findFirst({
      where: grupo ? { groups: { some: { productCode: grupo } } } : { groups: { none: {} } },
      orderBy: { orden: 'desc' },
      select: { orden: true },
    });

    const skill = await prisma.skill.create({
      data: {
        ...comun,
        code: datos.code,
        orden: orden ?? (ultima ? ultima.orden + 1 : 1),
        active: active ?? true,
        ...(grupo ? { groups: { create: { productCode: grupo } } } : {}),
      },
      select: adminSelect,
    });

    logger.info({ code: skill.code, tramos }, 'Skill añadida desde el panel');
    return { skill: conGrupos(skill), tramos, creada: true };
  },

  /** Edita la ficha. No toca el archivo: para eso se vuelve a subir el bundle. */
  async updateMeta(id, cambios) {
    const existente = await prisma.skill.findUnique({ where: { id } });
    if (!existente) throw new NotFoundError('Esa skill no existe.');

    // `productCodes` es la lista COMPLETA de grupos del capítulo: lo que no
    // venga en ella deja de serlo. Lista vacía = en ninguno, que es la red de
    // seguridad de siempre (se ve desde cualquier licencia).
    const { productCodes, ...ficha } = cambios;

    if (productCodes !== undefined) {
      const grupos = [...new Set(productCodes.map((c) => c.trim()).filter(Boolean))];
      for (const grupo of grupos) await exigirGrupo(grupo);

      await prisma.$transaction([
        prisma.skillGroup.deleteMany({
          where:
            grupos.length > 0 ? { skillId: id, productCode: { notIn: grupos } } : { skillId: id },
        }),
        ...grupos.map((productCode) =>
          prisma.skillGroup.upsert({
            where: { skillId_productCode: { skillId: id, productCode } },
            create: { skillId: id, productCode },
            update: {},
          }),
        ),
      ]);
    }

    const skill = await prisma.skill.update({
      where: { id },
      data: ficha,
      select: adminSelect,
    });

    return conGrupos(skill);
  },

  /**
   * Fija de una vez qué capítulos tiene un grupo.
   *
   * Es lo que pulsa «Guardar cambios» en la ventana de un grupo, y existe como
   * operación propia justo por lo que puede tocar: SOLO las filas de ESTE
   * grupo. Antes esto se hacía con un PATCH por capítulo cambiando su único
   * `productCode`, así que marcar un capítulo aquí lo borraba del grupo de al
   * lado. Con esta forma, eso ya no se puede escribir ni por error.
   */
  async setGroupSkills(productCode, skillIds) {
    await exigirGrupo(productCode);

    const ids = [...new Set(skillIds)];
    if (ids.length > 0) {
      const existen = await prisma.skill.count({ where: { id: { in: ids } } });
      if (existen !== ids.length) {
        throw new NotFoundError('Alguno de los capítulos marcados ya no existe. Vuelve a cargar.');
      }
    }

    await prisma.$transaction([
      prisma.skillGroup.deleteMany({
        where: ids.length > 0 ? { productCode, skillId: { notIn: ids } } : { productCode },
      }),
      ...ids.map((skillId) =>
        prisma.skillGroup.upsert({
          where: { skillId_productCode: { skillId, productCode } },
          create: { skillId, productCode },
          update: {},
        }),
      ),
    ]);

    // Lo que sirve el conector se arma con el catálogo: si no se olvida, un
    // capítulo recién añadido no aparece hasta el próximo reinicio.
    skillDelivery.olvidar();

    logger.info({ productCode, capitulos: ids.length }, 'Capítulos de un grupo actualizados');
    return skillService.listAll();
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
