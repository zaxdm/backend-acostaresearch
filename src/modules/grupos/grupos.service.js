'use strict';

const crypto = require('node:crypto');
const logger = require('../../config/logger');
const prisma = require('../../lib/prisma');
const { sendMail } = require('../../lib/mailer');
const plantillas = require('../../lib/emailTemplates');
const { contratoDelProducto, urlDelConector } = require('../licensing/license.service');
const { revisarCorreos } = require('../../shared/utils/correo');
const { generateOpaqueToken, hashToken, addDays } = require('../../shared/utils/tokens');
const {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
} = require('../../shared/errors/AppError');

/**
 * Grupos: cupos del método vendidos a una universidad o a un asesor.
 *
 * Cómo se vende: se negocia fuera (cotización, factura, transferencia) y el
 * administrador da de alta el grupo con los cupos, el producto y el
 * coordinador. El cobro queda apuntado como un pago del coordinador, así que
 * entra en las ventas del mes y en su «Mis compras» con su constancia.
 *
 * Cómo se usa: el coordinador reparte UN enlace (/grupo/<slug>). Cada alumno
 * entra con su cuenta y recibe su licencia normal —su conector, su tesis, sus
 * correos—, hasta agotar los cupos. Desde su perfil el coordinador ve cómo va
 * cada uno: si conectó Claude, cuántas fases cerró y en cuál está. No ve el
 * texto de nadie.
 *
 * Diferencias con un enlace de prueba (`TrialLink`), que es lo que se parece:
 * allí no hay cuentas ni correos y todo muere a la vez; aquí son clientes de
 * verdad, con licencia que dura lo que diga el grupo (o el plan).
 */

const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789';
const LARGO_SLUG = 10;

function generarSlug() {
  let slug = '';
  for (let i = 0; i < LARGO_SLUG; i += 1) slug += ALFABETO[crypto.randomInt(0, ALFABETO.length)];
  return slug;
}

function urlDelGrupo(slug) {
  return `${plantillas.appUrl().replace(/\/+$/, '')}/grupo/${slug}`;
}

/** ABIERTO, LLENO, CERRADO (pasó la fecha) o APAGADO. */
function estadoDelGrupo(grupo, ahora = new Date()) {
  if (!grupo.activo) return 'APAGADO';
  if (grupo.cierraAt && grupo.cierraAt <= ahora) return 'CERRADO';
  if (grupo.ocupados >= grupo.cupos) return 'LLENO';
  return 'ABIERTO';
}

function grupoCerrado(estado) {
  const mensajes = {
    LLENO: 'Este grupo ya no tiene cupos libres. Escríbele a quien te pasó el enlace.',
    CERRADO: 'El plazo para unirse a este grupo terminó. Escríbele a quien te pasó el enlace.',
    APAGADO: 'Este grupo ya no admite a nadie. Escríbele a quien te pasó el enlace.',
  };
  return new AppError(mensajes[estado] ?? mensajes.APAGADO, { statusCode: 409 });
}

function nombreCompleto(usuario) {
  return `${usuario.firstName ?? ''} ${usuario.lastName ?? ''}`.trim();
}

const grupoSelect = {
  id: true,
  slug: true,
  nombre: true,
  productCode: true,
  cupos: true,
  ocupados: true,
  duracionDias: true,
  cierraAt: true,
  activo: true,
  paymentMethod: true,
  amountCents: true,
  note: true,
  createdAt: true,
  coordinador: { select: { id: true, email: true, firstName: true, lastName: true } },
};

function presentar(grupo, nombres) {
  return {
    ...grupo,
    url: urlDelGrupo(grupo.slug),
    estado: estadoDelGrupo(grupo),
    quedan: Math.max(0, grupo.cupos - grupo.ocupados),
    productName: nombres?.get(grupo.productCode) ?? grupo.productCode,
  };
}

async function nombresDeProducto(codigos) {
  const planes = await prisma.plan.findMany({
    where: { kind: 'LICENSE', productCode: { in: [...new Set(codigos)] } },
    select: { productCode: true, name: true },
    orderBy: { sortOrder: 'asc' },
  });
  const porCodigo = new Map();
  for (const p of planes) if (!porCodigo.has(p.productCode)) porCodigo.set(p.productCode, p.name);
  return porCodigo;
}

/** El correo de bienvenida del alumno, con su URL. Sin await, como en un canje. */
function avisarAlAlumno({ userId, planName, connectorUrl, expiresAt }) {
  prisma.user
    .findUnique({ where: { id: userId }, select: { email: true, firstName: true } })
    .then((usuario) => {
      if (!usuario?.email) return null;
      return sendMail({
        to: usuario.email,
        ...plantillas.licenseReady({
          firstName: usuario.firstName,
          planName,
          connectorUrl,
          expiresAt,
          via: 'grupo',
        }),
      });
    })
    .catch((error) => logger.error({ err: error, userId }, 'No salió el correo del alumno del grupo'));
}

const gruposService = {
  /** Panel: da de alta un grupo vendido. */
  async crear({
    nombre,
    productCode,
    cupos,
    duracionDias = 0,
    cierraAt = null,
    coordinadorEmail,
    paymentMethod = 'CORTESIA',
    paymentRef = null,
    amountCents = null,
    note = null,
    createdById,
  }) {
    const email = coordinadorEmail.trim().toLowerCase();
    const coordinador = await prisma.user.findUnique({
      where: { email },
      select: { id: true, status: true, trialLinkId: true },
    });
    if (!coordinador || coordinador.status !== 'ACTIVE' || coordinador.trialLinkId) {
      // Se le pide que se registre: su panel de seguimiento cuelga de su cuenta,
      // y sin cuenta el cobro no tiene a nombre de quién apuntarse.
      const [revision] = await revisarCorreos([email]);
      throw new ValidationError(
        [
          {
            field: 'body.coordinadorEmail',
            message: revision?.problema
              ? `${email}: ${revision.problema}`
              : `${email} no tiene cuenta. Pídele que se registre en acostaresearch.com y vuelve a intentarlo.`,
          },
        ],
        'El coordinador tiene que tener cuenta.',
      );
    }

    const contrato = await contratoDelProducto(productCode);
    if (!contrato.planId) {
      throw new ValidationError('Ese producto no tiene un plan de licencia activo.');
    }

    const cobra = paymentMethod !== 'CORTESIA' && amountCents > 0;

    const grupo = await prisma.$transaction(async (tx) => {
      const creado = await tx.grupo.create({
        data: {
          slug: generarSlug(),
          nombre,
          productCode,
          cupos,
          duracionDias,
          cierraAt,
          coordinadorId: coordinador.id,
          paymentMethod,
          paymentRef: paymentRef || null,
          amountCents: cobra ? amountCents : null,
          note,
          createdById,
        },
        select: { id: true },
      });

      if (cobra) {
        // Un pago como los de un código vendido a mano: ya cobrado, revisado
        // por quien lo da de alta. La orden lleva el id del grupo, que es
        // único, así que el mismo grupo no puede apuntar dos cobros.
        const pago = await tx.payment.create({
          data: {
            userId: coordinador.id,
            planId: contrato.planId,
            provider: paymentMethod,
            providerOrderId: `GRUPO-${creado.id}`,
            providerCaptureId: paymentRef || `GRUPO-${creado.id}`,
            status: 'PAID',
            amountCents,
            currency: 'PEN',
            payerEmail: email,
            operationCode: paymentRef || null,
            paidAt: new Date(),
            reviewedById: createdById,
            reviewedAt: new Date(),
            rawResponse: JSON.stringify({ via: 'GRUPO', nombre, cupos, productCode, nota: note }),
          },
          select: { id: true },
        });
        await tx.grupo.update({ where: { id: creado.id }, data: { paymentId: pago.id } });
      }

      return tx.grupo.findUnique({ where: { id: creado.id }, select: grupoSelect });
    });

    logger.info(
      { grupoId: grupo.id, cupos, productCode, coordinadorId: coordinador.id, amountCents },
      'Grupo dado de alta',
    );
    return presentar(grupo, await nombresDeProducto([productCode]));
  },

  /** Panel: todos, los últimos primero. */
  async listar() {
    const grupos = await prisma.grupo.findMany({ orderBy: { createdAt: 'desc' }, select: grupoSelect });
    const nombres = await nombresDeProducto(grupos.map((g) => g.productCode));
    return grupos.map((g) => presentar(g, nombres));
  },

  /**
   * Panel: encender, apagar, ampliar cupos, mover la fecha o renombrar. Los
   * cupos no bajan de los ya ocupados: esos alumnos ya tienen su licencia.
   */
  async actualizar(id, cambios) {
    const grupo = await prisma.grupo.findUnique({ where: { id }, select: { ocupados: true } });
    if (!grupo) throw new NotFoundError('Ese grupo no existe.');
    if (cambios.cupos !== undefined && cambios.cupos < grupo.ocupados) {
      throw new ValidationError(`Ya hay ${grupo.ocupados} alumnos dentro: los cupos no pueden ser menos.`);
    }
    const actualizado = await prisma.grupo.update({ where: { id }, data: cambios, select: grupoSelect });
    return presentar(actualizado, await nombresDeProducto([actualizado.productCode]));
  },

  /** Lo que ve el alumno antes de unirse. Público. */
  async publico(slug) {
    const grupo = await prisma.grupo.findUnique({ where: { slug }, select: grupoSelect });
    if (!grupo) throw new NotFoundError('Este enlace de grupo no existe. Revisa que esté bien copiado.');
    const nombres = await nombresDeProducto([grupo.productCode]);
    return {
      nombre: grupo.nombre,
      productName: nombres.get(grupo.productCode) ?? grupo.productCode,
      estado: estadoDelGrupo(grupo),
      quedan: Math.max(0, grupo.cupos - grupo.ocupados),
      coordinador: nombreCompleto(grupo.coordinador),
      duracionDias: grupo.duracionDias,
    };
  },

  /**
   * El alumno se une y recibe su licencia. El cupo se toma con el mismo
   * cerrojo que un enlace de prueba: `updateMany` condicionado a que quede
   * sitio, dentro de la transacción que crea la licencia.
   */
  async unirse(slug, userId) {
    const grupo = await prisma.grupo.findUnique({
      where: { slug },
      select: { ...grupoSelect, coordinadorId: true },
    });
    if (!grupo) throw new NotFoundError('Este enlace de grupo no existe. Revisa que esté bien copiado.');

    const suya = await prisma.license.findFirst({
      where: { userId, productCode: grupo.productCode, status: { not: 'REVOKED' } },
      select: { id: true, grupoId: true },
    });
    if (suya?.grupoId === grupo.id) {
      // Ya estaba dentro: no se gasta otro cupo. La URL no se puede volver a
      // enseñar (solo se guarda su huella); la saca de su panel con «Nueva URL».
      return { yaEstaba: true, connectorUrl: null, productName: null };
    }
    if (suya) {
      throw new ConflictError(
        'Ya tienes este método activo en tu cuenta. No hace falta que ocupes un cupo del grupo.',
      );
    }

    const estado = estadoDelGrupo(grupo);
    if (estado !== 'ABIERTO') throw grupoCerrado(estado);

    const contrato = await contratoDelProducto(grupo.productCode);
    const dias = grupo.duracionDias > 0 ? grupo.duracionDias : contrato.durationDays;
    const token = generateOpaqueToken(32);

    const licencia = await prisma.$transaction(async (tx) => {
      const { count } = await tx.grupo.updateMany({
        where: {
          id: grupo.id,
          activo: true,
          ocupados: { lt: prisma.grupo.fields.cupos },
        },
        data: { ocupados: { increment: 1 } },
      });
      if (count === 0) return null;

      return tx.license.create({
        data: {
          userId,
          productCode: grupo.productCode,
          tokenHash: hashToken(token),
          tokenHint: token.slice(0, 8),
          expiresAt: dias > 0 ? addDays(new Date(), dias) : null,
          grupoId: grupo.id,
          ...contrato.topes,
        },
        select: { id: true, expiresAt: true },
      });
    });

    if (!licencia) {
      const ahora = await prisma.grupo.findUnique({ where: { id: grupo.id }, select: grupoSelect });
      throw grupoCerrado(ahora ? estadoDelGrupo(ahora) : 'APAGADO');
    }

    const connectorUrl = urlDelConector(token);
    logger.info({ grupoId: grupo.id, userId, licenseId: licencia.id }, 'Alumno unido a un grupo');
    avisarAlAlumno({ userId, planName: contrato.nombre, connectorUrl, expiresAt: licencia.expiresAt });

    return {
      yaEstaba: false,
      connectorUrl,
      expiresAt: licencia.expiresAt,
      productName: contrato.nombre,
    };
  },

  /**
   * Los grupos que coordina, con cómo va cada alumno. Solo el avance: si
   * conectó, cuántas fases cerró y en cuál está. Nada del texto.
   */
  async mios(userId) {
    const grupos = await prisma.grupo.findMany({
      where: { coordinadorId: userId },
      orderBy: { createdAt: 'desc' },
      select: {
        ...grupoSelect,
        licencias: {
          orderBy: { createdAt: 'asc' },
          select: {
            userId: true,
            status: true,
            callsTotal: true,
            lastUsedAt: true,
            createdAt: true,
            expiresAt: true,
            user: { select: { firstName: true, lastName: true, email: true } },
          },
        },
      },
    });
    if (grupos.length === 0) return [];

    const alumnos = [...new Set(grupos.flatMap((g) => g.licencias.map((l) => l.userId)))];
    const proyectos = await prisma.project.findMany({
      where: { userId: { in: alumnos } },
      orderBy: { updatedAt: 'desc' },
      select: {
        userId: true,
        productCode: true,
        tema: true,
        plantillaAt: true,
        stages: { select: { skillCode: true, estado: true, updatedAt: true } },
      },
    });
    const enCurso = [
      ...new Set(
        proyectos.flatMap((p) => p.stages.filter((s) => s.estado === 'EN_CURSO').map((s) => s.skillCode)),
      ),
    ];
    const nombresDeFase = new Map(
      (
        await prisma.skill.findMany({
          where: { code: { in: enCurso } },
          select: { code: true, displayName: true },
        })
      ).map((s) => [s.code, s.displayName]),
    );
    const proyectoDe = new Map();
    for (const p of proyectos) {
      const clave = `${p.userId}:${p.productCode}`;
      if (!proyectoDe.has(clave)) proyectoDe.set(clave, p);
    }

    const nombres = await nombresDeProducto(grupos.map((g) => g.productCode));

    return grupos.map(({ licencias, ...grupo }) => ({
      ...presentar(grupo, nombres),
      alumnos: licencias.map((licencia) => {
        const proyecto = proyectoDe.get(`${licencia.userId}:${grupo.productCode}`);
        const actual = proyecto?.stages
          .filter((s) => s.estado === 'EN_CURSO')
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        return {
          nombre: nombreCompleto(licencia.user) || licencia.user.email,
          email: licencia.user.email,
          seUnio: licencia.createdAt,
          activo: licencia.status === 'ACTIVE',
          conecto: licencia.callsTotal > 0,
          ultimoUso: licencia.lastUsedAt,
          fasesTerminadas: proyecto?.stages.filter((s) => s.estado === 'LISTO').length ?? 0,
          faseActual: actual ? (nombresDeFase.get(actual.skillCode) ?? null) : null,
          tema: proyecto?.tema ?? null,
          formatoSubido: Boolean(proyecto?.plantillaAt),
        };
      }),
    }));
  },
};

module.exports = gruposService;
module.exports.estadoDelGrupo = estadoDelGrupo;
module.exports.generarSlug = generarSlug;
