'use strict';

const crypto = require('node:crypto');
const env = require('../../config/env');
const logger = require('../../config/logger');
const { ERROR_CODES } = require('../../config/constants');
const prisma = require('../../lib/prisma');
const { generateOpaqueToken, hashToken, addDays } = require('../../shared/utils/tokens');
const { AppError, NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const {
  urlDelConector,
  contratoDelProducto,
} = require('../licensing/license.service');
const projectStorage = require('../projects/project.storage');

/**
 * Enlaces de prueba del conector.
 *
 * El administrador crea un enlace para un grupo; cada persona que lo abre
 * recibe su propio conector, sin registrarse, hasta agotar los cupos. Ver el
 * modelo `TrialLink` para el porqué de no dar una sola URL a todos.
 *
 * Todo esto va aparte de códigos, pagos y licencias a propósito: no hay venta
 * ni cortesía a una persona con cuenta, así que no deja nada en Movimientos ni
 * en las cifras, y sus conectores no se vigilan como los de un comprador.
 */

/**
 * Minúsculas y dígitos, sin los que se confunden al leerlos en voz alta: fuera
 * la o y el 0, la l y el 1. Doce caracteres de 32 son 60 bits: nadie va a dar
 * con un enlace por tanteo y gastarle los cupos a un taller.
 */
const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789';
const LARGO_SLUG = 12;

function generarSlug() {
  let slug = '';
  for (let i = 0; i < LARGO_SLUG; i += 1) {
    slug += ALFABETO[crypto.randomInt(0, ALFABETO.length)];
  }
  return slug;
}

/**
 * El correo del titular de relleno.
 *
 * El dominio .invalid está reservado para esto: no existe ni existirá, así que
 * ningún correo sale hacia él y nadie puede crear una cuenta de Google con esa
 * dirección para quedarse con el invitado. Lleva un id aleatorio dentro para no
 * chocar con el de otro invitado.
 */
function correoDeInvitado() {
  return `invitado-${crypto.randomUUID()}@prueba.invalid`;
}

/** La página que se comparte con el grupo. */
function urlDelEnlace(slug) {
  return `${env.APP_URL.replace(/\/+$/, '')}/prueba/${slug}`;
}

/**
 * En qué punto está un enlace, dicho en una palabra.
 *
 * APAGADO manda sobre LLENO: un enlace apagado corta sus conectores, y eso es
 * lo primero que tiene que saber quien lo mira.
 */
function estadoDelEnlace({ active, seats, claimed }) {
  if (!active) return 'APAGADO';
  if (claimed >= seats) return 'LLENO';
  return 'ABIERTO';
}

/** Mismo mensaje para enlace inexistente o mal copiado: no se distingue cuál. */
function enlaceInvalido() {
  return new NotFoundError('Este enlace de prueba no existe. Revisa que esté bien copiado.');
}

function enlaceCerrado(estado) {
  const mensaje =
    estado === 'APAGADO'
      ? 'Esta prueba del conector ya terminó.'
      : 'Ya se entregaron todos los conectores de esta prueba.';
  return new AppError(mensaje, { statusCode: 409, code: ERROR_CODES.LICENSE_CODE_USED });
}

/** Nombre de venta de cada producto, para el panel y la página del enlace. */
async function nombresDeProducto(codigos) {
  const planes = await prisma.plan.findMany({
    where: { kind: 'LICENSE', productCode: { in: [...new Set(codigos)] } },
    select: { productCode: true, name: true, active: true },
  });

  const nombres = new Map();
  for (const plan of planes) {
    // Gana el activo, como en la lista de licencias del comprador.
    if (plan.active || !nombres.has(plan.productCode)) nombres.set(plan.productCode, plan.name);
  }
  return nombres;
}

const enlaceSelect = {
  id: true,
  slug: true,
  name: true,
  productCode: true,
  seats: true,
  claimed: true,
  accessDays: true,
  callsPerDay: true,
  callsLimitTotal: true,
  active: true,
  createdAt: true,
};

/** Lo que el panel enseña de un enlace, con su URL y su estado ya resueltos. */
function presentar(enlace, nombres, uso) {
  return {
    ...enlace,
    url: urlDelEnlace(enlace.slug),
    estado: estadoDelEnlace(enlace),
    productName: nombres.get(enlace.productCode) ?? enlace.productCode,
    // Cuántos de los entregados llegaron a usar el conector, y cuánto. Es la
    // pregunta de después de un taller: ¿lo probaron o solo lo recogieron?
    conectados: uso?.conectados ?? 0,
    consultas: uso?.consultas ?? 0,
  };
}

const trialService = {
  async create({ name, productCode, seats, accessDays, callsPerDay, callsLimitTotal, createdById }) {
    // Sin plan activo no hay catálogo que servir: el invitado recibiría un
    // conector vacío. Mejor negarse aquí que descubrirlo en mitad del taller.
    const contrato = await contratoDelProducto(productCode);
    if (!contrato.planId) {
      throw new ValidationError(`No hay ningún plan activo para «${productCode}».`);
    }

    const enlace = await prisma.trialLink.create({
      data: {
        slug: generarSlug(),
        name,
        productCode,
        seats,
        accessDays,
        callsPerDay,
        callsLimitTotal,
        createdById,
      },
      select: enlaceSelect,
    });

    logger.info(
      { trialLinkId: enlace.id, producto: productCode, seats, accessDays, porAdmin: createdById },
      'Enlace de prueba creado',
    );

    return presentar(enlace, new Map([[productCode, contrato.nombre]]));
  },

  async list() {
    const enlaces = await prisma.trialLink.findMany({
      select: enlaceSelect,
      orderBy: { createdAt: 'desc' },
    });
    if (enlaces.length === 0) return [];

    // Una sola consulta para el uso de todos: son como mucho unos cientos de
    // conectores, y agruparlos aquí evita una consulta por enlace.
    const licencias = await prisma.license.findMany({
      where: { user: { trialLinkId: { in: enlaces.map((e) => e.id) } } },
      select: { callsTotal: true, user: { select: { trialLinkId: true } } },
    });

    const uso = new Map();
    for (const { callsTotal, user } of licencias) {
      const suma = uso.get(user.trialLinkId) ?? { conectados: 0, consultas: 0 };
      if (callsTotal > 0) suma.conectados += 1;
      suma.consultas += callsTotal;
      uso.set(user.trialLinkId, suma);
    }

    const nombres = await nombresDeProducto(enlaces.map((e) => e.productCode));
    return enlaces.map((enlace) => presentar(enlace, nombres, uso.get(enlace.id)));
  },

  /** Los conectores entregados por un enlace, uno por invitado. */
  async guests(id) {
    const enlace = await prisma.trialLink.findUnique({ where: { id }, select: { id: true } });
    if (!enlace) throw new NotFoundError('Ese enlace de prueba no existe.');

    const invitados = await prisma.user.findMany({
      where: { trialLinkId: id },
      select: {
        lastName: true,
        createdAt: true,
        licenses: {
          select: { id: true, tokenHint: true, callsTotal: true, lastUsedAt: true, expiresAt: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return invitados.map((invitado) => {
      const licencia = invitado.licenses[0] ?? null;
      return {
        // El número de invitado se guarda como apellido al entregarlo.
        numero: Number(invitado.lastName) || null,
        recibidoAt: invitado.createdAt,
        tokenHint: licencia?.tokenHint ?? null,
        consultas: licencia?.callsTotal ?? 0,
        ultimoUso: licencia?.lastUsedAt ?? null,
        expiresAt: licencia?.expiresAt ?? null,
      };
    });
  },

  /**
   * Enciende o apaga el enlace.
   *
   * Apagado corta todos sus conectores a la vez —la comprobación está en
   * `licenseService.authenticate`— y deja de entregar nuevos. Encenderlo de
   * nuevo los devuelve tal como estaban: nada se ha borrado.
   */
  async setActive(id, active) {
    const existe = await prisma.trialLink.findUnique({ where: { id }, select: { id: true } });
    if (!existe) throw new NotFoundError('Ese enlace de prueba no existe.');

    const enlace = await prisma.trialLink.update({
      where: { id },
      data: { active },
      select: enlaceSelect,
    });

    logger.warn(
      { trialLinkId: id, active },
      active ? 'Enlace de prueba encendido' : 'Enlace de prueba apagado: conectores cortados',
    );

    const nombres = await nombresDeProducto([enlace.productCode]);
    return presentar(enlace, nombres);
  },

  /**
   * Borra el enlace y todo lo que colgaba de él. No hay vuelta atrás.
   *
   * La base se lleva en cascada a los invitados, y con ellos sus licencias,
   * su uso y sus proyectos. Lo que no se lleva es lo que vive en disco —los
   * capítulos que guardaron—, así que eso se borra aquí, después.
   */
  async remove(id) {
    const enlace = await prisma.trialLink.findUnique({
      where: { id },
      select: { id: true, name: true, claimed: true },
    });
    if (!enlace) throw new NotFoundError('Ese enlace de prueba no existe.');

    const proyectos = await prisma.project.findMany({
      where: { user: { trialLinkId: id } },
      select: { id: true },
    });

    await prisma.trialLink.delete({ where: { id } });

    // Después de la base y sin tumbar nada si falla: el enlace ya no existe, y
    // una carpeta huérfana es un estorbo, no un acceso.
    for (const { id: projectId } of proyectos) {
      await projectStorage.borrarProyecto(projectId).catch((error) => {
        logger.error({ err: error, projectId }, 'No se pudo borrar la carpeta de un invitado');
      });
    }

    logger.warn(
      { trialLinkId: id, nombre: enlace.name, entregados: enlace.claimed },
      'Enlace de prueba borrado con sus conectores',
    );

    return { id, name: enlace.name };
  },

  /** Lo que ve quien abre el enlace, antes de pedir su conector. Público. */
  async publicInfo(slug) {
    const enlace = await prisma.trialLink.findUnique({ where: { slug }, select: enlaceSelect });
    if (!enlace) throw enlaceInvalido();

    const nombres = await nombresDeProducto([enlace.productCode]);

    // Solo lo que le sirve al invitado: ni topes internos ni cuántos lo usan.
    return {
      name: enlace.name,
      productName: nombres.get(enlace.productCode) ?? enlace.productCode,
      estado: estadoDelEnlace(enlace),
      quedan: Math.max(0, enlace.seats - enlace.claimed),
      seats: enlace.seats,
      accessDays: enlace.accessDays,
      callsPerDay: enlace.callsPerDay,
      callsLimitTotal: enlace.callsLimitTotal,
    };
  },

  /**
   * Entrega un conector a quien abre el enlace. Público y sin registro.
   *
   * El cupo se toma con un `updateMany` condicionado a que quede sitio: es el
   * cerrojo. MySQL bloquea la fila hasta el final de la transacción, así que
   * dos invitados que pulsan a la vez no pueden llevarse el mismo cupo ni pasar
   * del tope; el segundo espera y ve el contador ya subido.
   */
  async claim(slug) {
    const enlace = await prisma.trialLink.findUnique({ where: { slug }, select: enlaceSelect });
    if (!enlace) throw enlaceInvalido();

    const estado = estadoDelEnlace(enlace);
    if (estado !== 'ABIERTO') throw enlaceCerrado(estado);

    const contrato = await contratoDelProducto(enlace.productCode);
    const token = generateOpaqueToken(32);
    const expiresAt = addDays(new Date(), enlace.accessDays);

    const entrega = await prisma.$transaction(async (tx) => {
      const { count } = await tx.trialLink.updateMany({
        where: {
          id: enlace.id,
          active: true,
          claimed: { lt: prisma.trialLink.fields.seats },
        },
        data: { claimed: { increment: 1 } },
      });

      // Otro invitado se llevó el último cupo, o el enlace se apagó, entre la
      // lectura de arriba y este instante.
      if (count === 0) return null;

      const { claimed: numero } = await tx.trialLink.findUnique({
        where: { id: enlace.id },
        select: { claimed: true },
      });

      const invitado = await tx.user.create({
        data: {
          email: correoDeInvitado(),
          firstName: 'Invitado',
          // El número de invitado, para distinguirlos en el panel.
          lastName: String(numero),
          trialLinkId: enlace.id,
        },
        select: { id: true },
      });

      await tx.license.create({
        data: {
          userId: invitado.id,
          productCode: enlace.productCode,
          tokenHash: hashToken(token),
          tokenHint: token.slice(0, 8),
          expiresAt,
          callsPerDay: enlace.callsPerDay,
          callsLimitTotal: enlace.callsLimitTotal,
          // Se comporta como el conector del producto: lo que se prueba es eso.
          delivery: contrato.topes.delivery,
        },
      });

      return { numero };
    });

    if (!entrega) {
      const ahora = await prisma.trialLink.findUnique({ where: { id: enlace.id } });
      throw enlaceCerrado(ahora ? estadoDelEnlace(ahora) : 'APAGADO');
    }

    logger.info(
      { trialLinkId: enlace.id, numero: entrega.numero, de: enlace.seats },
      'Conector de prueba entregado',
    );

    return {
      connectorUrl: urlDelConector(token),
      numero: entrega.numero,
      expiresAt,
      productName: contrato.nombre,
    };
  },
};

module.exports = trialService;

// Funciones puras, expuestas para poder probarlas sin una base de datos.
module.exports.estadoDelEnlace = estadoDelEnlace;
module.exports.generarSlug = generarSlug;
module.exports.correoDeInvitado = correoDeInvitado;
