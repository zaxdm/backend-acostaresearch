'use strict';

const prisma = require('../../lib/prisma');
const logger = require('../../config/logger');
const { sendMail } = require('../../lib/mailer');
const { licenseAlert } = require('../../lib/emailTemplates');
const { analizar, NIVELES } = require('./license.detector');

/**
 * Vigilancia de licencias compartidas.
 *
 * LA REGLA, Y POR QUÉ TIENE RED
 * -----------------------------
 * A la primera sospecha alta NO se revoca: se avisa al comprador por correo y
 * queda anotado. Solo si vuelve a saltar pasadas unas horas se corta el acceso.
 *
 * Es a propósito. La señal más fuerte que queda —dos conversaciones vivas a la
 * vez— también la produce alguien que trabaja desde el móvil y el portátil, o
 * que le enseña la herramienta a un compañero una tarde. Cortarle el acceso a
 * un tesista en semana de sustentación por una heurística cuesta mucho más que
 * dejar correr una reventa dos días, y encima el aviso resuelve solo la mayoría
 * de los casos: quien compartió la URL la regenera y asunto arreglado.
 *
 * CUÁNDO CORRE
 * ------------
 * Después de registrar cada llamada, pero como mucho una vez cada
 * INTERVALO_MINUTOS por licencia. Sin ese freno, cada consulta cargaría treinta
 * días de historial para volver a calcular lo mismo.
 */

/** Cada cuánto se vuelve a evaluar una misma licencia. */
const INTERVALO_MINUTOS = 15;

/** Horas que deben pasar entre el aviso y la revocación. */
const GRACIA_HORAS = 12;

/** Ventana de historial que mira el detector. */
const VENTANA_DIAS = 30;

/** No se repite el mismo aviso una y otra vez dentro de esta ventana. */
const ANTIRREPETICION_HORAS = 24;

/** Intentos de extracción en 24 h a partir de los cuales se anota una alerta. */
const EXTRACCIONES_PARA_ALERTA = 3;

const HORA_MS = 60 * 60 * 1000;

/** Traduce el código de señal del detector al tipo de alerta que se guarda. */
const TIPOS = {
  VOLUMEN_DISPARADO: 'VOLUMEN',
  VOLUMEN_ALTO: 'VOLUMEN',
  MUCHAS_SESIONES: 'SESIONES_SOLAPADAS',
  VARIAS_SESIONES: 'SESIONES_SOLAPADAS',
  SESIONES_SOLAPADAS: 'SESIONES_SOLAPADAS',
  CONSULTAS_INCOHERENTES: 'CONSULTAS_INCOHERENTES',
};

function hace(horas) {
  return new Date(Date.now() - horas * HORA_MS);
}

/** ¿Ya hay una alerta igual reciente? Evita llenar la tabla de duplicados. */
async function alertaReciente(licenseId, kind) {
  return prisma.licenseAlert.findFirst({
    where: { licenseId, kind, createdAt: { gte: hace(ANTIRREPETICION_HORAS) } },
    select: { id: true },
  });
}

/** Aviso previo aún vigente: es el que habilita revocar a la segunda. */
async function avisoPrevio(licenseId) {
  return prisma.licenseAlert.findFirst({
    where: {
      licenseId,
      level: 'SOSPECHA_ALTA',
      action: 'NOTIFICADO',
      createdAt: { lte: hace(GRACIA_HORAS) },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true },
  });
}

async function avisar(licencia, motivos, revocada) {
  if (!licencia.user?.email) return;

  try {
    const mail = licenseAlert({
      firstName: licencia.user.firstName ?? 'Hola',
      motivos,
      revocada,
    });
    await sendMail({ to: licencia.user.email, ...mail });
  } catch (error) {
    // Que falle el correo no puede impedir que la alerta quede registrada.
    logger.error({ err: error, licenseId: licencia.id }, 'No se pudo avisar al comprador');
  }
}

/** Cuenta intentos de extracción recientes, que es una señal por sí sola. */
async function contarExtracciones(licenseId) {
  return prisma.licenseUsage.count({
    where: { licenseId, kind: 'EXTRACTION_ATTEMPT', createdAt: { gte: hace(24) } },
  });
}

/**
 * Evalúa una licencia y actúa. Devuelve el diagnóstico, o null si tocaba
 * saltársela por haberla revisado hace poco.
 *
 * Nunca lanza: es vigilancia, no puede tumbar la consulta de un cliente.
 */
async function evaluar(licenseId, { forzar = false } = {}) {
  try {
    const licencia = await prisma.license.findUnique({
      where: { id: licenseId },
      include: {
        user: { select: { email: true, firstName: true, role: true, trialLinkId: true } },
      },
    });

    if (!licencia || licencia.status !== 'ACTIVE') return null;

    // Tampoco los conectores de prueba. Su titular no existe —el correo es de
    // relleno—, así que no hay a quién avisar, y el gasto ya lo acotan sus
    // topes y el interruptor del enlace, que el administrador tiene a mano.
    if (licencia.user?.trialLinkId) return null;

    // La licencia del administrador no se vigila. Es la única del sistema que
    // no se vendió: la usa el dueño para probar y para enseñar el producto, y
    // eso produce justo las señales que el detector busca —dos sesiones vivas,
    // capítulos pedidos sin trabajar ninguno—. Aplicada aquí, la regla acabaría
    // revocándole su propio conector a las doce horas del primer aviso.
    if (licencia.user?.role === 'ADMIN') return null;

    const revisadaHaceNada =
      licencia.lastCheckedAt &&
      Date.now() - licencia.lastCheckedAt.getTime() < INTERVALO_MINUTOS * 60 * 1000;

    if (revisadaHaceNada && !forzar) return null;

    await prisma.license.update({
      where: { id: licenseId },
      data: { lastCheckedAt: new Date() },
    });

    const usos = await prisma.licenseUsage.findMany({
      where: { licenseId, createdAt: { gte: hace(VENTANA_DIAS * 24) } },
      select: { createdAt: true, promptHash: true, sessionId: true, tool: true },
      orderBy: { createdAt: 'asc' },
    });

    const diagnostico = analizar(usos);
    const señales = [...diagnostico.senales];

    // Los intentos de extracción no los ve el detector: se suman aquí.
    const extracciones = await contarExtracciones(licenseId);
    if (extracciones >= EXTRACCIONES_PARA_ALERTA) {
      señales.push({
        codigo: 'EXTRACCION',
        detalle: `${extracciones} intentos de obtener las instrucciones internas en 24 h.`,
        peso: 'medio',
      });
    }

    if (señales.length === 0) return diagnostico;

    // ── Se anota lo encontrado ──────────────────────────────────────────────
    for (const señal of señales) {
      const kind = señal.codigo === 'EXTRACCION' ? 'EXTRACCION' : TIPOS[señal.codigo];
      if (!kind) continue;
      if (await alertaReciente(licenseId, kind)) continue;

      await prisma.licenseAlert.create({
        data: {
          licenseId,
          kind,
          level: diagnostico.nivel === NIVELES.SOSPECHA_ALTA ? 'SOSPECHA_ALTA' : 'ALERTA',
          detalle: señal.detalle.slice(0, 500),
        },
      });
    }

    if (diagnostico.nivel !== NIVELES.SOSPECHA_ALTA) return diagnostico;

    // ── Sospecha alta: avisar primero, revocar a la segunda ─────────────────
    const motivos = señales.map((s) => s.detalle);
    const previo = await avisoPrevio(licenseId);

    if (!previo) {
      await prisma.licenseAlert.updateMany({
        where: { licenseId, createdAt: { gte: hace(1) }, action: 'NINGUNA' },
        data: { action: 'NOTIFICADO' },
      });
      await avisar(licencia, motivos, false);
      logger.warn({ licenseId, motivos }, 'Sospecha alta: comprador avisado, sin revocar');
      return diagnostico;
    }

    await prisma.license.update({
      where: { id: licenseId },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedReason: `Uso compartido detectado: ${motivos[0] ?? 'patrón anómalo'}`.slice(0, 255),
      },
    });
    await prisma.licenseAlert.updateMany({
      where: { licenseId, createdAt: { gte: hace(1) } },
      data: { action: 'REVOCADO' },
    });
    await avisar(licencia, motivos, true);

    logger.warn({ licenseId, motivos }, 'Licencia revocada automáticamente tras el aviso previo');
    return { ...diagnostico, revocada: true };
  } catch (error) {
    logger.error({ err: error, licenseId }, 'Falló la vigilancia de la licencia');
    return null;
  }
}

/** Alertas de una licencia, para el panel. */
function listarAlertas(licenseId, { limit = 50 } = {}) {
  return prisma.licenseAlert.findMany({
    where: { licenseId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/** Alertas abiertas de todas las licencias, lo primero que mira el admin. */
function alertasAbiertas({ limit = 100 } = {}) {
  return prisma.licenseAlert.findMany({
    where: { action: { in: ['NINGUNA', 'NOTIFICADO'] } },
    include: {
      license: {
        select: {
          id: true,
          productCode: true,
          status: true,
          tokenHint: true,
          user: { select: { email: true, firstName: true, lastName: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

module.exports = {
  evaluar,
  listarAlertas,
  alertasAbiertas,
  INTERVALO_MINUTOS,
  GRACIA_HORAS,
};
