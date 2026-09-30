'use strict';

const crypto = require('node:crypto');
const env = require('../../config/env');
const logger = require('../../config/logger');
const prisma = require('../../lib/prisma');
const { sendMail } = require('../../lib/mailer');
const { perfilDe, traeHerramientas } = require('../productos/producto.perfil');
const plantillas = require('./avisos.plantillas');
const referidosService = require('../referidos/referidos.service');

/**
 * Correos según el avance del tesista. Una pasada al día.
 *
 *   SIN_CONECTAR   compró hace 3+ días y no ha usado el conector
 *   SIN_AVANZAR    lo usó, pero lleva 7+ días sin volver
 *   FALTA_FORMATO  ya avanza y no ha subido el formato de su universidad
 *   VENCE_PRONTO   su acceso termina en 5 días o menos
 *
 * El aviso de caducidad de 15 días sigue siendo el de `scripts/avisar-caducidad`,
 * que no se toca: este es el segundo, más corto y más cerca de la fecha.
 *
 * Reglas para no convertirse en spam:
 *   - cada aviso sale UNA vez por episodio (ver `AvisoAvance.clave`);
 *   - como mucho un correo por persona y pasada, el más importante;
 *   - nada si ya recibió uno en los últimos 3 días;
 *   - nada a quien lo desactivó (`User.avisosApagadosAt`), a administradores
 *     ni a invitados de enlaces de prueba;
 *   - SIN_CONECTAR y SIN_AVANZAR dejan de insistir a los 30 días: a esas
 *     alturas otro correo no lo va a traer de vuelta.
 */

const DIA_MS = 24 * 60 * 60 * 1000;

const REGLAS = {
  sinConectarTras: 3,
  sinAvanzarTras: 7,
  formatoTras: 5,
  venceEn: 5,
  dejarDeInsistir: 30,
  pausaEntreCorreos: 3,
};

/** De más a menos importante: si tocan dos, sale el primero. */
const PRIORIDAD = ['VENCE_PRONTO', 'SIN_CONECTAR', 'SIN_AVANZAR', 'FALTA_FORMATO'];

/** Perú: UTC−5. La pasada sale a partir de las 9 de la mañana de Lima. */
const HORA_DE_ENVIO = 9;

const hace = (ahora, dias) => new Date(ahora.getTime() - dias * DIA_MS);
const dentroDe = (ahora, dias) => new Date(ahora.getTime() + dias * DIA_MS);
const diasEntre = (antes, despues) => Math.max(1, Math.floor((despues - antes) / DIA_MS));
const diaISO = (fecha) => new Date(fecha).toISOString().slice(0, 10);

// ── La baja ────────────────────────────────────────────────────────────────

/**
 * La firma del enlace de baja. Sin caducidad a propósito: un correo de hace
 * dos meses tiene que poder desactivar los avisos igual que el de hoy. No da
 * acceso a nada más que a esto.
 */
function firmaDeBaja(userId) {
  return crypto
    .createHmac('sha256', env.JWT_ACCESS_SECRET)
    .update(`avisos-baja:${userId}`)
    .digest('base64url');
}

function firmaValida(userId, firma) {
  const esperada = Buffer.from(firmaDeBaja(userId));
  const recibida = Buffer.from(String(firma ?? ''));
  return esperada.length === recibida.length && crypto.timingSafeEqual(esperada, recibida);
}

function enlaceDeBaja(userId) {
  return `${env.apiPublicUrl}${env.API_PREFIX}/avisos/baja?u=${userId}&t=${firmaDeBaja(userId)}`;
}

// ── A quién le toca ──────────────────────────────────────────────────────────

/** Las licencias que pueden recibir algo: vigentes, de clientes que no dijeron que no. */
function licenciasCandidatas(ahora) {
  return prisma.license.findMany({
    where: {
      status: 'ACTIVE',
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: ahora } }],
      user: { role: 'USER', status: 'ACTIVE', trialLinkId: null, avisosApagadosAt: null },
    },
    select: {
      id: true,
      userId: true,
      productCode: true,
      callsTotal: true,
      lastUsedAt: true,
      createdAt: true,
      expiresAt: true,
      user: { select: { email: true, firstName: true } },
    },
  });
}

/**
 * Qué avisos le tocarían a una licencia, sin mirar aún si ya se mandaron.
 * Pura: recibe la licencia y su proyecto, devuelve [{ tipo, clave, datos }].
 */
function avisosDe(licencia, proyecto, ahora = new Date()) {
  const avisos = [];
  const conFases = traeHerramientas(licencia.productCode);

  if (licencia.expiresAt && licencia.expiresAt <= dentroDe(ahora, REGLAS.venceEn)) {
    avisos.push({
      tipo: 'VENCE_PRONTO',
      // La fecha en la clave: si renueva y vuelve a acercarse, hay otro aviso.
      clave: `${licencia.id}:${diaISO(licencia.expiresAt)}`,
      datos: {
        dias: Math.max(1, Math.ceil((licencia.expiresAt - ahora) / DIA_MS)),
        expiresAt: licencia.expiresAt,
      },
    });
  }

  if (
    licencia.callsTotal === 0 &&
    licencia.createdAt <= hace(ahora, REGLAS.sinConectarTras) &&
    licencia.createdAt >= hace(ahora, REGLAS.dejarDeInsistir)
  ) {
    avisos.push({
      tipo: 'SIN_CONECTAR',
      clave: licencia.id,
      datos: { dias: diasEntre(licencia.createdAt, ahora) },
    });
  }

  if (
    conFases &&
    licencia.callsTotal > 0 &&
    licencia.lastUsedAt &&
    licencia.lastUsedAt <= hace(ahora, REGLAS.sinAvanzarTras) &&
    licencia.lastUsedAt >= hace(ahora, REGLAS.dejarDeInsistir)
  ) {
    avisos.push({
      tipo: 'SIN_AVANZAR',
      // El día de su último uso: si vuelve y se para otra vez, es otro episodio.
      clave: `${licencia.id}:${diaISO(licencia.lastUsedAt)}`,
      datos: { dias: diasEntre(licencia.lastUsedAt, ahora), fase: proyecto?.fase ?? null },
    });
  }

  // El formato es de tesis e informe: un artículo va al formato de la revista.
  if (
    conFases &&
    perfilDe(licencia.productCode).tipo !== 'articulo' &&
    proyecto &&
    !proyecto.plantillaAt &&
    proyecto.avanza &&
    licencia.createdAt <= hace(ahora, REGLAS.formatoTras)
  ) {
    avisos.push({ tipo: 'FALTA_FORMATO', clave: proyecto.id, datos: {} });
  }

  return avisos;
}

/** El que más importa de los que le tocan. */
function elMasImportante(avisos) {
  return [...avisos].sort((a, b) => PRIORIDAD.indexOf(a.tipo) - PRIORIDAD.indexOf(b.tipo))[0] ?? null;
}

/**
 * Los proyectos de esas licencias, con lo que hace falta: si ya avanza, si
 * subió el formato y en qué fase está.
 */
async function proyectosDe(licencias) {
  if (licencias.length === 0) return new Map();

  const proyectos = await prisma.project.findMany({
    where: { userId: { in: [...new Set(licencias.map((l) => l.userId))] } },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      userId: true,
      productCode: true,
      plantillaAt: true,
      stages: {
        where: { estado: { in: ['EN_CURSO', 'LISTO'] } },
        select: { skillCode: true, estado: true, updatedAt: true },
      },
    },
  });

  const enCurso = [
    ...new Set(
      proyectos.flatMap((p) => p.stages.filter((s) => s.estado === 'EN_CURSO').map((s) => s.skillCode)),
    ),
  ];
  const nombres = new Map(
    (
      await prisma.skill.findMany({
        where: { code: { in: enCurso } },
        select: { code: true, displayName: true },
      })
    ).map((s) => [s.code, s.displayName]),
  );

  // Uno por persona y producto: el que se tocó por última vez (varias tesis
  // en ranuras distintas son raras, y la última es la que está trabajando).
  const porClave = new Map();
  for (const p of proyectos) {
    const clave = `${p.userId}:${p.productCode}`;
    if (porClave.has(clave)) continue;
    const actual = p.stages
      .filter((s) => s.estado === 'EN_CURSO')
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    porClave.set(clave, {
      id: p.id,
      plantillaAt: p.plantillaAt,
      avanza: p.stages.length > 0,
      fase: actual ? (nombres.get(actual.skillCode) ?? null) : null,
    });
  }
  return porClave;
}

/** El nombre del producto que reconoce el comprador. */
async function nombresDeProducto() {
  const planes = await prisma.plan.findMany({
    where: { productCode: { not: null }, kind: 'LICENSE' },
    select: { productCode: true, name: true },
    orderBy: { sortOrder: 'asc' },
  });
  const porCodigo = new Map();
  for (const p of planes) if (!porCodigo.has(p.productCode)) porCodigo.set(p.productCode, p.name);
  return porCodigo;
}

function mensajeDe(aviso, { licencia, planName }) {
  const base = {
    firstName: licencia.user.firstName || 'Hola',
    obra: perfilDe(licencia.productCode).tuObra,
    planName,
    baja: enlaceDeBaja(licencia.userId),
    ...aviso.datos,
  };
  switch (aviso.tipo) {
    case 'SIN_CONECTAR':
      return plantillas.sinConectar(base);
    case 'SIN_AVANZAR':
      return plantillas.sinAvanzar(base);
    case 'FALTA_FORMATO':
      return plantillas.faltaFormato(base);
    case 'VENCE_PRONTO':
      return plantillas.vencePronto(base);
    default:
      return null;
  }
}

const avisosService = {
  /**
   * La pasada del día. Con `soloVer` no manda nada: devuelve a quién escribiría.
   * Devuelve { enviados, fallados, lista }.
   */
  async enviarDelDia({ ahora = new Date(), soloVer = false } = {}) {
    if (!env.AVISOS_AVANCE_ACTIVOS && !soloVer) return { enviados: 0, fallados: 0, lista: [] };

    const licencias = await licenciasCandidatas(ahora);
    if (licencias.length === 0) return { enviados: 0, fallados: 0, lista: [] };

    const userIds = [...new Set(licencias.map((l) => l.userId))];
    const [proyectos, nombres, yaEnviados] = await Promise.all([
      proyectosDe(licencias),
      nombresDeProducto(),
      prisma.avisoAvance.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, tipo: true, clave: true, enviadoAt: true },
      }),
    ]);

    const enviadosAntes = new Set(yaEnviados.map((a) => `${a.userId}|${a.tipo}|${a.clave}`));
    const conPausa = new Set(
      yaEnviados
        .filter((a) => a.enviadoAt >= hace(ahora, REGLAS.pausaEntreCorreos))
        .map((a) => a.userId),
    );

    // Por persona, el aviso más importante de todas sus licencias.
    const porPersona = new Map();
    for (const licencia of licencias) {
      if (conPausa.has(licencia.userId) || !licencia.user?.email) continue;
      const proyecto = proyectos.get(`${licencia.userId}:${licencia.productCode}`);
      const pendientes = avisosDe(licencia, proyecto, ahora).filter(
        (a) => !enviadosAntes.has(`${licencia.userId}|${a.tipo}|${a.clave}`),
      );
      const candidato = elMasImportante(pendientes);
      if (!candidato) continue;
      const previo = porPersona.get(licencia.userId);
      if (!previo || PRIORIDAD.indexOf(candidato.tipo) < PRIORIDAD.indexOf(previo.aviso.tipo)) {
        porPersona.set(licencia.userId, { aviso: candidato, licencia });
      }
    }

    const lista = [...porPersona.values()].map(({ aviso, licencia }) => ({
      email: licencia.user.email,
      tipo: aviso.tipo,
      producto: licencia.productCode,
    }));
    if (soloVer) return { enviados: 0, fallados: 0, lista };

    let enviados = 0;
    let fallados = 0;
    for (const { aviso, licencia } of porPersona.values()) {
      const mensaje = mensajeDe(aviso, {
        licencia,
        planName: nombres.get(licencia.productCode) ?? 'el método',
      });
      if (!mensaje) continue;
      const baja = enlaceDeBaja(licencia.userId);
      try {
        await sendMail({
          to: licencia.user.email,
          ...mensaje,
          headers: {
            'List-Unsubscribe': `<${baja}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });
        // Después de salir, como en el aviso de caducidad: si el proveedor
        // falla, mañana se vuelve a intentar.
        await prisma.avisoAvance
          .create({
            data: { userId: licencia.userId, licenseId: licencia.id, tipo: aviso.tipo, clave: aviso.clave },
          })
          .catch((error) => {
            if (error?.code !== 'P2002') throw error;
          });
        enviados += 1;
      } catch (error) {
        fallados += 1;
        logger.error({ err: error, userId: licencia.userId, tipo: aviso.tipo }, 'No salió un correo de avance');
      }
    }

    logger.info({ enviados, fallados }, 'Correos de avance del día');
    return { enviados, fallados, lista };
  },

  /**
   * Lo que corre el servidor cada hora: la pasada de avisos una vez al día, a
   * partir de las 9 de Lima, y los días de referidos que estaban esperando.
   * `estado.ultimoDia` vive en memoria; si el servidor se reinicia el mismo
   * día, la segunda pasada no repite nada (las claves ya están apuntadas).
   */
  async pasadaProgramada(estado, ahora = new Date()) {
    const enLima = new Date(ahora.getTime() - 5 * 60 * 60 * 1000);
    const hoy = enLima.toISOString().slice(0, 10);
    if (estado.ultimoDia === hoy || enLima.getUTCHours() < HORA_DE_ENVIO) return null;
    estado.ultimoDia = hoy;

    await referidosService.aplicarPendientes();
    return this.enviarDelDia({ ahora });
  },

  /** Desde el enlace del correo. Devuelve false si la firma no vale. */
  async darDeBaja(userId, firma) {
    if (!firmaValida(userId, firma)) return false;
    await prisma.user.updateMany({
      where: { id: userId, avisosApagadosAt: null },
      data: { avisosApagadosAt: new Date() },
    });
    logger.info({ userId }, 'Correos de avance desactivados desde el correo');
    return true;
  },

  /** Desde el perfil. */
  async preferencia(userId) {
    const usuario = await prisma.user.findUnique({
      where: { id: userId },
      select: { avisosApagadosAt: true },
    });
    return { activos: !usuario?.avisosApagadosAt };
  },

  async cambiarPreferencia(userId, activos) {
    await prisma.user.update({
      where: { id: userId },
      data: { avisosApagadosAt: activos ? null : new Date() },
    });
    return { activos };
  },
};

module.exports = avisosService;
module.exports.avisosDe = avisosDe;
module.exports.elMasImportante = elMasImportante;
module.exports.firmaDeBaja = firmaDeBaja;
module.exports.firmaValida = firmaValida;
module.exports.REGLAS = REGLAS;
