'use strict';

const crypto = require('node:crypto');
const env = require('../../config/env');
const logger = require('../../config/logger');
const prisma = require('../../lib/prisma');
const { sendMail } = require('../../lib/mailer');
const plantillas = require('../../lib/emailTemplates');
const {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
} = require('../../shared/errors/AppError');

/**
 * Referidos: un tesista invita a otro y los dos ganan días.
 *
 * El recorrido:
 *   1. Quien ya tiene el método ve su código en el perfil y un enlace
 *      /planes?ref=CODIGO para mandarlo por WhatsApp.
 *   2. El invitado llega con ese enlace (o escribe el código en /planes) y
 *      queda apuntado como «invitado por» — todavía sin premio.
 *   3. Cuando paga su primer acceso al método, se premia: días extra en SU
 *      licencia recién entregada y días extra en la del que lo invitó.
 *
 * Por qué días y no dinero: encaja con lo que ya se vende (licencias por
 * tiempo), no toca los precios ni los descuentos, y no hay nada que pagar a
 * nadie. Y por qué al pagar y no al registrarse: un registro no cuesta nada, y
 * premiarlo es invitar a que alguien se cree diez cuentas para sí mismo.
 */

/** Sin letras que se confundan al dictarlas: ni O/0 ni I/1/L. */
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Solo cuentan las licencias de clientes, no las de los enlaces de prueba. */
const DE_CLIENTE = { user: { trialLinkId: null } };

/** «María José» → «MARIA». Las letras de su nombre hacen el código reconocible. */
function prefijoDe(nombre) {
  const limpio = String(nombre ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  return limpio.slice(0, 5) || 'TESIS';
}

function sufijo(largo = 4) {
  const bytes = crypto.randomBytes(largo);
  return [...bytes].map((b) => ALFABETO[b % ALFABETO.length]).join('');
}

/** Lo que se teclea se compara sin espacios, guiones ni minúsculas. */
function normalizarCodigo(codigo) {
  return String(codigo ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** «Ana Pérez» → «Ana P.»: al que invitó le basta para reconocerlo. */
function nombreCorto({ firstName, lastName }) {
  const inicial = String(lastName ?? '').trim().charAt(0);
  return `${String(firstName ?? '').trim()}${inicial ? ` ${inicial}.` : ''}`.trim() || 'Alguien';
}

function enlaceDe(codigo) {
  return `${env.APP_URL.replace(/\/+$/, '')}/planes?ref=${codigo}`;
}

/**
 * Suma días a una licencia. Sin caducidad, no hay nada que sumar. Si ya caducó,
 * se cuenta desde hoy: no se regalan días que ya pasaron.
 *
 * Devuelve la licencia con su nueva fecha, o null si no se tocó.
 */
async function sumarDias(licencia, dias, cliente = prisma) {
  if (!licencia || dias <= 0 || licencia.expiresAt === null) return null;

  const base = licencia.expiresAt > new Date() ? licencia.expiresAt : new Date();
  const expiresAt = new Date(base.getTime() + dias * 24 * 60 * 60 * 1000);

  return cliente.license.update({
    where: { id: licencia.id },
    data: { expiresAt },
    select: { id: true, expiresAt: true },
  });
}

/**
 * La licencia a la que se le suman los días del que invitó: la vigente con
 * caducidad más reciente. Una revocada no, y una suspendida tampoco: el premio
 * no puede ser la forma de alargar algo que se cortó a propósito.
 */
function licenciaDelInvitador(userId, cliente = prisma) {
  return cliente.license.findFirst({
    where: { userId, status: 'ACTIVE', expiresAt: { not: null }, ...DE_CLIENTE },
    orderBy: { expiresAt: 'desc' },
    select: { id: true, expiresAt: true },
  });
}

/** Correo a cada lado del premio. Sin await: el premio ya está en la base. */
function avisarDelPremio({ userId, dias, expiresAt, invitado, esInvitador }) {
  if (dias <= 0) return;

  prisma.user
    .findUnique({ where: { id: userId }, select: { email: true, firstName: true } })
    .then((usuario) => {
      if (!usuario?.email) return null;
      return sendMail({
        to: usuario.email,
        ...plantillaDelPremio({ firstName: usuario.firstName, dias, expiresAt, invitado, esInvitador }),
      });
    })
    .catch((error) => logger.error({ err: error, userId }, 'No salió el correo del premio por referido'));
}

function plantillaDelPremio({ firstName, dias, expiresAt, invitado, esInvitador }) {
  const { layout, escapar, fecha, appUrl } = plantillas;
  const hasta = expiresAt ? fecha(expiresAt) : null;
  const titulo = esInvitador ? `Ganaste ${dias} días más` : `Tienes ${dias} días de regalo`;
  const frase = esInvitador
    ? `${invitado} empezó el método con tu código. Te sumamos ${dias} días a tu acceso`
    : `Llegaste invitado por un compañero, así que te sumamos ${dias} días a tu acceso`;
  const cola = hasta ? `: ahora termina el ${hasta}.` : '.';
  const pendiente = esInvitador && !expiresAt;
  const detalle = pendiente
    ? 'Ahora mismo no tienes el método activo, así que los días quedan guardados y se suman solos en cuanto lo tengas.'
    : null;
  const panel = `${appUrl()}/perfil`;

  return {
    subject: `${titulo} · Acosta Research`,
    text: [`Hola ${firstName}:`, '', `${frase}${pendiente ? '.' : cola}`, detalle, '', `Tu panel: ${panel}`]
      .filter((linea) => linea !== null)
      .join('\n'),
    html: layout(
      titulo,
      `<p style="margin:0 0 18px;font-size:15px;line-height:1.6">Hola ${escapar(firstName)}:
         ${escapar(frase)}${pendiente ? '.' : escapar(cola)}</p>
       ${detalle ? `<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#4a5568">${escapar(detalle)}</p>` : ''}
       ${
         esInvitador
           ? `<p style="margin:0 0 18px;font-size:14px;line-height:1.6">Tu código sigue sirviendo: cada compañero que empiece con él te suma otros ${dias} días.</p>`
           : ''
       }
       <p style="margin:0;font-size:14px"><a href="${panel}" style="color:#1a56db">Abrir mi panel</a></p>`,
      { preheader: frase },
    ),
  };
}

const referidosService = {
  /**
   * Lo que ve en su perfil: su código (se crea aquí la primera vez), a quién
   * invitó y cuántos días lleva ganados.
   *
   * Solo tiene código quien ya tiene el método: invitar a algo que uno no usa
   * no convence a nadie, y así el código no se regala en masa con cuentas
   * vacías.
   */
  async miPanel(userId) {
    const usuario = await prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, codigoReferido: true, trialLinkId: true },
    });
    if (!usuario) throw new NotFoundError('Esa cuenta no existe.');

    const tieneMetodo =
      !usuario.trialLinkId &&
      (await prisma.license.count({ where: { userId, status: { not: 'REVOKED' } } })) > 0;

    const [invitados, meInvito] = await Promise.all([
      prisma.referido.findMany({
        where: { invitadorId: userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          estado: true,
          diasInvitador: true,
          diasPorAplicar: true,
          createdAt: true,
          premiadoAt: true,
          invitado: { select: { firstName: true, lastName: true } },
        },
      }),
      prisma.referido.findUnique({
        where: { invitadoId: userId },
        select: { estado: true, invitador: { select: { firstName: true, lastName: true } } },
      }),
    ]);

    let codigo = usuario.codigoReferido;
    if (!codigo && tieneMetodo) codigo = await this.crearCodigo(userId, usuario.firstName);

    const premiados = invitados.filter((i) => i.estado === 'PREMIADO');

    return {
      disponible: Boolean(codigo),
      codigo: codigo ?? null,
      enlace: codigo ? enlaceDe(codigo) : null,
      diasPorInvitado: env.REFERIDO_DIAS_INVITADOR,
      diasParaElInvitado: env.REFERIDO_DIAS_INVITADO,
      diasGanados: premiados.reduce((suma, i) => suma + i.diasInvitador - i.diasPorAplicar, 0),
      diasPorAplicar: premiados.reduce((suma, i) => suma + i.diasPorAplicar, 0),
      invitados: invitados.map((i) => ({
        nombre: nombreCorto(i.invitado),
        estado: i.estado,
        createdAt: i.createdAt,
        premiadoAt: i.premiadoAt,
      })),
      meInvito: meInvito
        ? { nombre: nombreCorto(meInvito.invitador), estado: meInvito.estado }
        : null,
    };
  },

  /** Le da un código único. Reintenta si el sorteo choca con otro. */
  async crearCodigo(userId, firstName) {
    for (let intento = 0; intento < 5; intento += 1) {
      const codigo = `${prefijoDe(firstName)}${sufijo()}`;
      try {
        const { count } = await prisma.user.updateMany({
          where: { id: userId, codigoReferido: null },
          data: { codigoReferido: codigo },
        });
        if (count > 0) return codigo;
        // Otra petición se lo dio un instante antes: vale ese.
        const ya = await prisma.user.findUnique({
          where: { id: userId },
          select: { codigoReferido: true },
        });
        return ya.codigoReferido;
      } catch (error) {
        if (error?.code !== 'P2002') throw error;
      }
    }
    throw new AppError('No se pudo crear tu código. Inténtalo otra vez.', { statusCode: 503 });
  },

  /**
   * Lo que ve /planes antes de apuntar: de quién es el código. Público, para
   * poder saludar al que llega con el enlace antes de que tenga cuenta.
   */
  async deQuienEs(codigo) {
    const invitador = await prisma.user.findUnique({
      where: { codigoReferido: normalizarCodigo(codigo) },
      select: { firstName: true, lastName: true, status: true },
    });
    if (!invitador || invitador.status !== 'ACTIVE') {
      throw new NotFoundError('Ese código de invitación no existe. Revisa que esté bien escrito.');
    }
    return { nombre: nombreCorto(invitador), dias: env.REFERIDO_DIAS_INVITADO };
  },

  /**
   * Apunta quién lo invitó. Solo para quien todavía no tiene el método: el
   * premio es por traer a alguien nuevo, no por renovar a un conocido.
   */
  async apuntarse(userId, codigo) {
    const normalizado = normalizarCodigo(codigo);
    if (normalizado.length < 5) throw new ValidationError('Escribe el código completo.');

    const invitador = await prisma.user.findUnique({
      where: { codigoReferido: normalizado },
      select: { id: true, firstName: true, lastName: true, status: true },
    });
    if (!invitador || invitador.status !== 'ACTIVE') {
      throw new NotFoundError('Ese código de invitación no existe. Revisa que esté bien escrito.');
    }
    if (invitador.id === userId) {
      throw new ValidationError('Ese es tu propio código: compártelo con un compañero.');
    }

    const ya = await prisma.referido.findUnique({
      where: { invitadoId: userId },
      select: { invitadorId: true },
    });
    if (ya) {
      if (ya.invitadorId === invitador.id) {
        return { nombre: nombreCorto(invitador), dias: env.REFERIDO_DIAS_INVITADO, yaEstaba: true };
      }
      throw new ConflictError('Ya estás apuntado con el código de otra persona.');
    }

    const tuvoMetodo = await prisma.license.count({ where: { userId } });
    if (tuvoMetodo > 0) {
      throw new ConflictError(
        'Los códigos de invitación son para quien empieza el método. Tú ya lo tienes: comparte el tuyo desde tu perfil.',
      );
    }

    try {
      await prisma.referido.create({ data: { invitadorId: invitador.id, invitadoId: userId } });
    } catch (error) {
      // Doble clic: la otra petición ya lo apuntó.
      if (error?.code !== 'P2002') throw error;
    }

    logger.info({ invitadorId: invitador.id, invitadoId: userId }, 'Invitado apuntado con un código');
    return { nombre: nombreCorto(invitador), dias: env.REFERIDO_DIAS_INVITADO, yaEstaba: false };
  },

  /**
   * Premia la primera compra de un invitado. Se llama cuando se ENTREGA una
   * licencia nueva (no una renovación): por la web o con un código vendido.
   *
   * El paso de PENDIENTE a PREMIADO es el cerrojo: si llegan dos entregas a la
   * vez, solo una lo encuentra pendiente y reparte los días.
   *
   * Nunca lanza: lo llaman flujos de cobro que ya terminaron bien.
   */
  async premiarCompra({ userId, licenseId, paymentId = null }) {
    try {
      const referido = await prisma.referido.findUnique({
        where: { invitadoId: userId },
        select: {
          id: true,
          estado: true,
          invitadorId: true,
          invitado: { select: { firstName: true, lastName: true } },
        },
      });
      if (!referido || referido.estado !== 'PENDIENTE') return null;

      const diasInvitado = env.REFERIDO_DIAS_INVITADO;
      const diasInvitador = env.REFERIDO_DIAS_INVITADOR;

      const resultado = await prisma.$transaction(async (tx) => {
        const { count } = await tx.referido.updateMany({
          where: { id: referido.id, estado: 'PENDIENTE' },
          data: { estado: 'PREMIADO', premiadoAt: new Date(), paymentId, diasInvitado, diasInvitador },
        });
        if (count === 0) return null;

        const suya = await tx.license.findUnique({
          where: { id: licenseId },
          select: { id: true, expiresAt: true },
        });
        const invitadoTras = await sumarDias(suya, diasInvitado, tx);

        const delInvitador = await licenciaDelInvitador(referido.invitadorId, tx);
        const invitadorTras = await sumarDias(delInvitador, diasInvitador, tx);
        // Con un acceso que no caduca no hay nada que sumar ni que guardar.
        const sinCaducidad =
          !delInvitador &&
          (await tx.license.count({
            where: { userId: referido.invitadorId, status: 'ACTIVE', expiresAt: null, ...DE_CLIENTE },
          })) > 0;
        if (!invitadorTras && !sinCaducidad && diasInvitador > 0) {
          await tx.referido.update({
            where: { id: referido.id },
            data: { diasPorAplicar: diasInvitador },
          });
        }

        return { invitadoTras, invitadorTras, sinCaducidad };
      });

      if (!resultado) return null;

      logger.info(
        { referidoId: referido.id, invitadorId: referido.invitadorId, invitadoId: userId },
        'Referido premiado',
      );

      avisarDelPremio({
        userId,
        dias: diasInvitado,
        expiresAt: resultado.invitadoTras?.expiresAt ?? null,
        esInvitador: false,
      });
      avisarDelPremio({
        userId: referido.invitadorId,
        // Sin caducidad no ganó días que contarle.
        dias: resultado.sinCaducidad ? 0 : diasInvitador,
        expiresAt: resultado.invitadorTras?.expiresAt ?? null,
        invitado: nombreCorto(referido.invitado),
        esInvitador: true,
      });

      return resultado;
    } catch (error) {
      logger.error({ err: error, userId, licenseId }, 'No se pudo premiar al referido');
      return null;
    }
  },

  /**
   * Los días que esperaban porque el que invitó no tenía licencia. Corre con
   * los avisos del día: en cuanto vuelve a tener el método, se le suman.
   */
  async aplicarPendientes() {
    const pendientes = await prisma.referido.findMany({
      where: { estado: 'PREMIADO', diasPorAplicar: { gt: 0 } },
      select: { id: true, invitadorId: true, diasPorAplicar: true },
      take: 200,
    });

    let aplicados = 0;
    for (const { id, invitadorId, diasPorAplicar: dias } of pendientes) {
      const aplicado = await prisma.$transaction(async (tx) => {
        const licencia = await licenciaDelInvitador(invitadorId, tx);
        if (!licencia) return false;
        const { count } = await tx.referido.updateMany({
          where: { id, diasPorAplicar: dias },
          data: { diasPorAplicar: 0 },
        });
        if (count === 0) return false;
        await sumarDias(licencia, dias, tx);
        return true;
      });
      if (aplicado) aplicados += 1;
    }

    if (aplicados > 0) logger.info({ aplicados }, 'Días de referidos pendientes ya sumados');
    return aplicados;
  },

  /** Panel: los últimos referidos, para ver quién trae a quién. */
  async listar({ limite = 100 } = {}) {
    const filas = await prisma.referido.findMany({
      orderBy: { createdAt: 'desc' },
      take: limite,
      select: {
        id: true,
        estado: true,
        diasInvitador: true,
        diasInvitado: true,
        diasPorAplicar: true,
        createdAt: true,
        premiadoAt: true,
        invitador: { select: { email: true, firstName: true, lastName: true, codigoReferido: true } },
        invitado: { select: { email: true, firstName: true, lastName: true } },
      },
    });
    return filas;
  },

  /**
   * Panel: anula uno pendiente (se invitó a sí mismo con otra cuenta…). Uno ya
   * premiado no se deshace aquí: los días se quitan a mano en la licencia.
   */
  async anular(id) {
    const { count } = await prisma.referido.updateMany({
      where: { id, estado: 'PENDIENTE' },
      data: { estado: 'ANULADO' },
    });
    if (count === 0) throw new ConflictError('Solo se puede anular uno que aún no se premió.');
    return { id };
  },
};

module.exports = referidosService;
module.exports.normalizarCodigo = normalizarCodigo;
module.exports.prefijoDe = prefijoDe;
module.exports.nombreCorto = nombreCorto;
module.exports.sumarDias = sumarDias;
module.exports.plantillaDelPremio = plantillaDelPremio;
