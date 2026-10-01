'use strict';

const crypto = require('node:crypto');

const env = require('../../config/env');
const logger = require('../../config/logger');
const prisma = require('../../lib/prisma');
const { sendMail } = require('../../lib/mailer');
const { ganadorDelSorteo } = require('../../lib/emailTemplates');
const licenseService = require('../licensing/license.service');
const { ConflictError, NotFoundError } = require('../../shared/errors/AppError');

/**
 * Sorteos de una matrícula del método.
 *
 * El administrador crea el sorteo y reparte el enlace /sorteo/<slug>. Quien lo
 * abre deja su correo una sola vez —el índice único (sorteo, correo) lo
 * impide—, sin cuenta y sin verificar el correo. Cuando el administrador quiere,
 * gira la ruleta: el ganador lo elige ESTE servidor con `crypto.randomInt`, y
 * la web solo anima la ruleta hasta caer en el que ya se eligió. Así no hay
 * forma de amañarlo desde el navegador.
 *
 * El premio es un código de cortesía del producto del sorteo (por defecto el
 * método de tesis, cuyo plan dura tres meses), que se le manda por correo. El
 * código no se guarda en claro: lo ven el ganador en su correo y el
 * administrador en la pantalla, una vez.
 */

/** El mismo alfabeto que los enlaces de prueba: sin letras que se confundan. */
const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789';
const LARGO_SLUG = 12;

function generarSlug() {
  let slug = '';
  for (let i = 0; i < LARGO_SLUG; i += 1) {
    slug += ALFABETO[crypto.randomInt(0, ALFABETO.length)];
  }
  return slug;
}

const urlDe = (slug) => `${env.APP_URL.replace(/\/+$/, '')}/sorteo/${slug}`;

/** El plan que da el premio: su nombre y cuántos días dura. */
async function premioDe(productCode) {
  const plan = await prisma.plan.findFirst({
    where: { kind: 'LICENSE', productCode },
    select: { name: true, durationDays: true },
  });
  return {
    premio: plan?.name ?? 'Método de tesis',
    duracionDias: plan?.durationDays ?? env.LICENSE_DURATION_DAYS ?? 0,
  };
}

const participanteSelect = { id: true, email: true, nombre: true, createdAt: true };

/** Un sorteo como lo ve el panel. */
async function salidaAdmin(sorteo) {
  const { premio, duracionDias } = await premioDe(sorteo.productCode);
  const participantes = sorteo.participantes ?? [];
  let ganador = null;
  if (sorteo.ganadorId) {
    ganador =
      participantes.find((p) => p.id === sorteo.ganadorId) ??
      (await prisma.sorteoParticipante.findUnique({
        where: { id: sorteo.ganadorId },
        select: participanteSelect,
      }));
  }

  return {
    id: sorteo.id,
    slug: sorteo.slug,
    nombre: sorteo.nombre,
    url: urlDe(sorteo.slug),
    productCode: sorteo.productCode,
    premio,
    duracionDias,
    abierto: sorteo.abierto,
    inscritos: sorteo._count?.participantes ?? participantes.length,
    ganador: ganador ?? null,
    sorteadoAt: sorteo.sorteadoAt,
    codigoHint: sorteo.codigoHint,
    correoEnviado: sorteo.correoEnviado,
    createdAt: sorteo.createdAt,
  };
}

async function buscar(id) {
  const sorteo = await prisma.sorteo.findUnique({
    where: { id },
    include: { participantes: { select: participanteSelect, orderBy: { createdAt: 'asc' } } },
  });
  if (!sorteo) throw new NotFoundError('Ese sorteo no existe.');
  return sorteo;
}

const sorteoService = {
  // ── Lo público ─────────────────────────────────────────────────────────

  /** Lo que ve quien abre el enlace. Ni la lista de inscritos ni el ganador. */
  async verPublico(slug) {
    const sorteo = await prisma.sorteo.findUnique({
      where: { slug },
      include: { _count: { select: { participantes: true } } },
    });
    if (!sorteo) throw new NotFoundError('Este sorteo no existe o ya no está disponible.');

    const { premio, duracionDias } = await premioDe(sorteo.productCode);
    return {
      nombre: sorteo.nombre,
      premio,
      duracionDias,
      abierto: sorteo.abierto && !sorteo.ganadorId,
      sorteado: Boolean(sorteo.ganadorId),
      inscritos: sorteo._count.participantes,
    };
  },

  /** Apuntarse. Un correo, una vez por sorteo. */
  async inscribir(slug, { email, nombre }) {
    const sorteo = await prisma.sorteo.findUnique({
      where: { slug },
      select: { id: true, abierto: true, ganadorId: true },
    });
    if (!sorteo) throw new NotFoundError('Este sorteo no existe o ya no está disponible.');
    if (sorteo.ganadorId) throw new ConflictError('Este sorteo ya se realizó.');
    if (!sorteo.abierto) throw new ConflictError('Las inscripciones de este sorteo están cerradas.');

    try {
      await prisma.sorteoParticipante.create({
        data: { sorteoId: sorteo.id, email, nombre: nombre ?? '' },
      });
    } catch (error) {
      // El índice único (sorteo, correo): ya estaba apuntado.
      if (error?.code === 'P2002') {
        throw new ConflictError('Ese correo ya está participando en este sorteo.');
      }
      throw error;
    }

    logger.info({ sorteoId: sorteo.id }, 'Inscripción en un sorteo');
    return { email };
  },

  // ── El panel ───────────────────────────────────────────────────────────

  async listar() {
    const sorteos = await prisma.sorteo.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { _count: { select: { participantes: true } } },
    });
    return Promise.all(sorteos.map(salidaAdmin));
  },

  async ver(id) {
    const sorteo = await buscar(id);
    return { ...(await salidaAdmin(sorteo)), participantes: sorteo.participantes };
  },

  async crear({ nombre }, createdById) {
    const sorteo = await prisma.sorteo.create({
      data: {
        slug: generarSlug(),
        nombre,
        productCode: env.LICENSE_PRODUCT_CODE,
        createdById,
      },
      include: { _count: { select: { participantes: true } } },
    });
    logger.info({ sorteoId: sorteo.id, createdById }, 'Sorteo creado');
    return salidaAdmin(sorteo);
  },

  /** Abrir o cerrar las inscripciones. Uno ya sorteado no se reabre. */
  async cambiar(id, { abierto }) {
    const sorteo = await buscar(id);
    if (sorteo.ganadorId && abierto) {
      throw new ConflictError('Este sorteo ya se realizó: no se puede reabrir.');
    }
    await prisma.sorteo.update({ where: { id }, data: { abierto } });
    return sorteoService.ver(id);
  },

  /** Quitar a un inscrito: un correo de broma, uno repetido con otra letra. */
  async quitarParticipante(id, participanteId) {
    const sorteo = await buscar(id);
    if (sorteo.ganadorId === participanteId) {
      throw new ConflictError('Ese es el ganador: no se puede quitar.');
    }
    const { count } = await prisma.sorteoParticipante.deleteMany({
      where: { id: participanteId, sorteoId: id },
    });
    if (count === 0) throw new NotFoundError('Ese inscrito no existe.');
    return sorteoService.ver(id);
  },

  async borrar(id) {
    await buscar(id);
    await prisma.sorteo.delete({ where: { id } });
    logger.info({ sorteoId: id }, 'Sorteo borrado');
  },

  /**
   * Girar la ruleta.
   *
   * El ganador se fija con `updateMany` condicionado a que siga vacío: con dos
   * administradores pulsando a la vez, solo uno sortea y el otro recibe un 409
   * en vez de un segundo ganador. Si después falla la creación del código, se
   * deshace el ganador para poder volver a sortear.
   */
  async sortear(id, adminId) {
    const sorteo = await buscar(id);
    if (sorteo.ganadorId) throw new ConflictError('Este sorteo ya se realizó.');

    const participantes = sorteo.participantes;
    if (participantes.length === 0) {
      throw new ConflictError('Todavía no hay nadie inscrito: no hay a quién sortear.');
    }

    const indice = crypto.randomInt(0, participantes.length);
    const ganador = participantes[indice];

    const { count } = await prisma.sorteo.updateMany({
      where: { id, ganadorId: null },
      data: { ganadorId: ganador.id, sorteadoAt: new Date(), abierto: false },
    });
    if (count === 0) throw new ConflictError('Este sorteo ya se realizó.');

    let codigo;
    try {
      const generados = await licenseService.generateCodes({
        cantidad: 1,
        productCode: sorteo.productCode,
        buyerEmail: ganador.email,
        note: `Sorteo «${sorteo.nombre}»`.slice(0, 255),
        createdById: adminId,
        paymentMethod: 'CORTESIA',
        // Sin consultar el buzón y sin el correo de compra: este lleva el suyo.
        revisarBuzon: false,
        avisar: false,
      });
      codigo = generados.codes[0];
    } catch (error) {
      await prisma.sorteo.update({
        where: { id },
        data: { ganadorId: null, sorteadoAt: null, abierto: sorteo.abierto },
      });
      throw error;
    }

    const { premio, duracionDias } = await premioDe(sorteo.productCode);

    let correoEnviado = false;
    try {
      await sendMail({
        to: ganador.email,
        ...ganadorDelSorteo({
          nombre: ganador.nombre,
          sorteo: sorteo.nombre,
          premio,
          duracionDias,
          codigo,
        }),
      });
      correoEnviado = true;
    } catch (error) {
      // El ganador y el código ya existen; el administrador tiene el código
      // en pantalla para mandárselo por otra vía.
      logger.error({ err: error, sorteoId: id }, 'No salió el correo al ganador del sorteo');
    }

    await prisma.sorteo.update({
      where: { id },
      data: { codigoHint: codigo.slice(-4), correoEnviado },
    });

    logger.info(
      { sorteoId: id, inscritos: participantes.length, correoEnviado, adminId },
      'Sorteo realizado',
    );

    return {
      ganador,
      // La lista que gira la ruleta, en el mismo orden con que se eligió.
      participantes,
      indice,
      codigo,
      correoEnviado,
      sorteo: await sorteoService.ver(id),
    };
  },
};

module.exports = sorteoService;
