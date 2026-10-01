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
 * código entero solo lo ve el ganador: ni se guarda en claro ni llega al panel,
 * que lo enseña con los cuatro últimos caracteres tapados. Si el correo no le
 * llegó, «reenviar» anula ese código y le manda uno nuevo.
 */

/** «ACR-R7VC-PJWV-EMXX» → «ACR-R7VC-PJWV-****»: lo que ve el panel. */
const ocultar = (codigo) => `${codigo.slice(0, -4)}****`;

/** Lo que se apunta en la nota del código, para encontrarlo al reenviar. */
const notaDe = (sorteo) => `Sorteo «${sorteo.nombre}»`.slice(0, 255);

/**
 * Cuántas vueltas tiene un sorteo: las primeras eliminan y la última da el
 * ganador. Con pocos inscritos se llega antes al ganador: si en la ruleta
 * queda una sola persona, esa gana.
 */
const VUELTAS = 3;

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

const participanteSelect = {
  id: true,
  email: true,
  nombre: true,
  eliminadoEn: true,
  createdAt: true,
};

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
    ronda: sorteo.ronda ?? 0,
    vueltas: VUELTAS,
    inscritos: sorteo._count?.participantes ?? participantes.length,
    ganador: ganador ?? null,
    sorteadoAt: sorteo.sorteadoAt,
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
    if ((sorteo.ganadorId || sorteo.ronda > 0) && abierto) {
      throw new ConflictError('Este sorteo ya empezó a girar: no se puede reabrir.');
    }
    await prisma.sorteo.update({ where: { id }, data: { abierto } });
    return sorteoService.ver(id);
  },

  /** Quitar a un inscrito: un correo de broma, uno repetido con otra letra. */
  async quitarParticipante(id, participanteId) {
    const sorteo = await buscar(id);
    if (sorteo.ganadorId || sorteo.ronda > 0) {
      throw new ConflictError('La ruleta ya empezó a girar: ya no se quita a nadie.');
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
   * Una vuelta de la ruleta.
   *
   * Gira solo entre los que siguen dentro. En las dos primeras vueltas el que
   * sale queda eliminado; en la tercera —o cuando ya solo queda uno— el que
   * sale gana. Cada vuelta se apunta con `updateMany` condicionado a la ronda
   * que se leyó: con dos administradores pulsando a la vez, solo una vuelta
   * cuenta y la otra recibe un 409. Si falla la creación del código, el
   * ganador se deshace para poder volver a girar la última vuelta.
   */
  async sortear(id, adminId) {
    const sorteo = await buscar(id);
    if (sorteo.ganadorId) throw new ConflictError('Este sorteo ya se realizó.');

    const candidatos = sorteo.participantes.filter((p) => p.eliminadoEn == null);
    if (candidatos.length === 0) {
      throw new ConflictError('Todavía no hay nadie inscrito: no hay a quién sortear.');
    }

    const anterior = sorteo.ronda ?? 0;
    const ronda = anterior + 1;
    const indice = crypto.randomInt(0, candidatos.length);
    const elegido = candidatos[indice];
    const otraVuelta = () =>
      new ConflictError('Otra persona acaba de girar esta ruleta. Recarga para ver cómo va.');

    // ── Vuelta que elimina ──
    if (ronda < VUELTAS && candidatos.length > 1) {
      const { count } = await prisma.sorteo.updateMany({
        where: { id, ganadorId: null, ronda: anterior },
        data: { ronda, abierto: false },
      });
      if (count === 0) throw otraVuelta();
      await prisma.sorteoParticipante.update({
        where: { id: elegido.id },
        data: { eliminadoEn: ronda },
      });

      logger.info({ sorteoId: id, ronda, adminId }, 'Vuelta del sorteo: un eliminado');
      return {
        tipo: 'ELIMINADO',
        ronda,
        participantes: candidatos,
        indice,
        eliminado: elegido,
        sorteo: await sorteoService.ver(id),
      };
    }

    // ── Vuelta que da el ganador ──
    const ganador = elegido;
    const { count } = await prisma.sorteo.updateMany({
      where: { id, ganadorId: null, ronda: anterior },
      data: { ganadorId: ganador.id, ronda, sorteadoAt: new Date(), abierto: false },
    });
    if (count === 0) throw otraVuelta();

    let codigo;
    try {
      codigo = await generarPremio(sorteo, ganador, adminId);
    } catch (error) {
      await prisma.sorteo.update({
        where: { id },
        data: { ganadorId: null, sorteadoAt: null, ronda: anterior },
      });
      throw error;
    }

    const correoEnviado = await avisarAlGanador(sorteo, ganador, codigo);

    await prisma.sorteo.update({
      where: { id },
      data: { codigoHint: codigo.slice(-4), correoEnviado },
    });

    logger.info(
      { sorteoId: id, ronda, enLaRuleta: candidatos.length, correoEnviado, adminId },
      'Sorteo realizado',
    );

    return {
      tipo: 'GANADOR',
      ronda,
      ganador,
      // La lista que gira la ruleta, en el mismo orden con que se eligió.
      participantes: candidatos,
      indice,
      codigoOculto: ocultar(codigo),
      correoEnviado,
      sorteo: await sorteoService.ver(id),
    };
  },

  /**
   * Volver a mandarle el premio al ganador.
   *
   * El código no se guarda en claro, así que no se puede reenviar el mismo:
   * se anula el anterior —si sigue sin canjear— y se genera otro. Si ya lo
   * canjeó, no se manda nada: ya tiene su matrícula.
   */
  async reenviar(id, adminId) {
    const sorteo = await buscar(id);
    if (!sorteo.ganadorId) throw new ConflictError('Este sorteo todavía no tiene ganador.');
    const ganador = sorteo.participantes.find((p) => p.id === sorteo.ganadorId);
    if (!ganador) throw new NotFoundError('El ganador ya no está en la lista.');

    const anteriores = {
      productCode: sorteo.productCode,
      buyerEmail: ganador.email,
      note: notaDe(sorteo),
      ...(sorteo.codigoHint ? { hint: sorteo.codigoHint } : {}),
    };
    const canjeado = await prisma.activationCode.findFirst({
      where: { ...anteriores, status: 'REDEEMED' },
      select: { id: true },
    });
    if (canjeado) throw new ConflictError('El ganador ya canjeó su código: no hace falta otro.');

    await prisma.activationCode.updateMany({
      where: { ...anteriores, status: 'AVAILABLE' },
      data: { status: 'VOID' },
    });

    const codigo = await generarPremio(sorteo, ganador, adminId);
    const correoEnviado = await avisarAlGanador(sorteo, ganador, codigo);
    await prisma.sorteo.update({
      where: { id },
      data: { codigoHint: codigo.slice(-4), correoEnviado },
    });

    logger.info({ sorteoId: id, correoEnviado, adminId }, 'Premio del sorteo reenviado');
    return {
      ganador,
      codigoOculto: ocultar(codigo),
      correoEnviado,
      sorteo: await sorteoService.ver(id),
    };
  },
};

/** El código de cortesía del ganador. Sin revisar el buzón y sin el correo de compra. */
async function generarPremio(sorteo, ganador, adminId) {
  const generados = await licenseService.generateCodes({
    cantidad: 1,
    productCode: sorteo.productCode,
    buyerEmail: ganador.email,
    note: notaDe(sorteo),
    createdById: adminId,
    paymentMethod: 'CORTESIA',
    revisarBuzon: false,
    avisar: false,
  });
  return generados.codes[0];
}

/**
 * El correo con el código entero. Su fallo no deshace nada: el panel lo dice y
 * ofrece reenviar.
 */
async function avisarAlGanador(sorteo, ganador, codigo) {
  const { premio, duracionDias } = await premioDe(sorteo.productCode);
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
    return true;
  } catch (error) {
    logger.error({ err: error, sorteoId: sorteo.id }, 'No salió el correo al ganador del sorteo');
    return false;
  }
}

module.exports = sorteoService;
