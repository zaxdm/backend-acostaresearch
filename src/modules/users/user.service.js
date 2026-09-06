'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const {
  ERROR_CODES,
  ROLES,
  VERIFICATION_CODE_LENGTH,
  MAX_VERIFICATION_ATTEMPTS,
} = require('../../config/constants');
const prisma = require('../../lib/prisma');
const { sendMail } = require('../../lib/mailer');
const { passwordChangeCode, adminAccountCreated } = require('../../lib/emailTemplates');
const tokenRepository = require('../auth/token.repository');
const { hashPassword } = require('../../shared/utils/password');
const {
  generateNumericCode,
  hashToken,
  safeCompareHex,
  addMinutes,
} = require('../../shared/utils/tokens');
const {
  AppError,
  ConflictError,
  NotFoundError,
} = require('../../shared/errors/AppError');
const userRepository = require('./user.repository');

/** Lo único que autoriza un código de cuenta, por ahora. */
const CAMBIO_DE_CLAVE = 'PASSWORD';

/** Mensaje único para código erróneo, caducado o de otra operación. */
function codigoInvalido(intentosRestantes) {
  const sufijo =
    intentosRestantes > 0
      ? ` Te ${intentosRestantes === 1 ? 'queda' : 'quedan'} ${intentosRestantes} ` +
        `${intentosRestantes === 1 ? 'intento' : 'intentos'}.`
      : '';

  return new AppError(`El código no es válido o ya caducó.${sufijo}`, {
    statusCode: 400,
    code: ERROR_CODES.INVALID_VERIFICATION_CODE,
    details: intentosRestantes > 0 ? { remainingAttempts: intentosRestantes } : undefined,
  });
}

/**
 * Una contraseña provisional que se puede dictar por teléfono sin equivocarse.
 *
 * Sin las letras y cifras que se confunden al leerlas en voz alta o al copiarlas
 * de un correo —O y 0, l y 1, I—. Cumple la política por construcción: bloques
 * de minúsculas, una mayúscula y dígitos.
 */
function claveProvisional() {
  const minusculas = 'abcdefghijkmnopqrstuvwxyz';
  const mayusculas = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digitos = '23456789';

  const de = (alfabeto, n) =>
    Array.from({ length: n }, () => alfabeto[Math.floor(Math.random() * alfabeto.length)]).join('');

  return `${de(mayusculas, 1)}${de(minusculas, 5)}-${de(minusculas, 4)}${de(digitos, 3)}`;
}

const userService = {
  async getProfile(userId) {
    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError('El usuario ya no existe.');
    return user;
  },

  list({ page, perPage, search }) {
    return userRepository.paginate({ page, perPage, search });
  },

  /**
   * Cambia el nombre y el apellido de la propia cuenta.
   *
   * Sin código y sin contraseña, a propósito: un nombre mal escrito no es una
   * credencial, y ponerle una barrera a corregir una tilde solo consigue que se
   * quede mal escrito para siempre.
   */
  async updateProfile(userId, { firstName, lastName }) {
    const user = await userRepository.update(userId, { firstName, lastName });
    logger.info({ userId }, 'Datos de la cuenta actualizados');
    return user;
  },

  /**
   * Manda al correo de la cuenta el código para cambiar la contraseña.
   *
   * Va al correo y no se pide la contraseña actual porque son dos preguntas
   * distintas: la contraseña actual demuestra que alguien la sabe —también quien
   * la robó—, y el código demuestra que quien pide el cambio tiene la bandeja de
   * entrada del dueño. Contra una sesión secuestrada, lo segundo protege y lo
   * primero no.
   *
   * Y hace posible lo que si no sería imposible: una cuenta creada con Google no
   * tiene contraseña que teclear, así que exigirla la dejaría sin forma de
   * ponerse una.
   */
  async requestPasswordCode(userId) {
    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError('El usuario ya no existe.');

    const code = generateNumericCode(VERIFICATION_CODE_LENGTH);
    const expiresAt = addMinutes(new Date(), env.EMAIL_VERIFICATION_TTL_MINUTES);
    const datos = { codeHash: hashToken(code), expiresAt, attempts: 0 };

    // Pedir otro código sustituye al anterior en vez de dejar dos vivos: uno
    // viejo que siga valiendo es justo lo que no se quiere de algo que viaja por
    // correo.
    await prisma.accountCode.upsert({
      where: { userId_purpose: { userId, purpose: CAMBIO_DE_CLAVE } },
      update: datos,
      create: { userId, purpose: CAMBIO_DE_CLAVE, ...datos },
    });

    const mail = passwordChangeCode({
      firstName: user.firstName,
      code,
      expiresInMinutes: env.EMAIL_VERIFICATION_TTL_MINUTES,
    });

    await sendMail({ to: user.email, ...mail });
    logger.info({ userId }, 'Código de cambio de contraseña enviado');

    return { email: user.email, expiresInMinutes: env.EMAIL_VERIFICATION_TTL_MINUTES };
  },

  /**
   * Cambia la contraseña si el código es el que se envió.
   *
   * Al terminar se cierran TODAS las demás sesiones. Es la mitad que le falta al
   * cambio para servir de algo: si alguien tenía la cuenta abierta en otro sitio,
   * cambiar la contraseña sin echarlo lo deja dentro exactamente igual que antes.
   * La sesión desde la que se pide el cambio se mantiene, porque echar a quien
   * acaba de demostrar que es el dueño solo estorba.
   */
  async changePassword(userId, { code, newPassword }, refreshActual) {
    const guardado = await prisma.accountCode.findUnique({
      where: { userId_purpose: { userId, purpose: CAMBIO_DE_CLAVE } },
    });

    if (!guardado) throw codigoInvalido(0);

    if (guardado.attempts >= MAX_VERIFICATION_ATTEMPTS) {
      throw new AppError('Demasiados intentos fallidos. Pide un código nuevo.', {
        statusCode: 429,
        code: ERROR_CODES.TOO_MANY_ATTEMPTS,
      });
    }

    if (guardado.expiresAt <= new Date()) {
      throw new AppError('El código caducó. Pide uno nuevo.', {
        statusCode: 400,
        code: ERROR_CODES.TOKEN_EXPIRED,
      });
    }

    if (!safeCompareHex(guardado.codeHash, hashToken(code))) {
      const actualizado = await prisma.accountCode.update({
        where: { id: guardado.id },
        data: { attempts: { increment: 1 } },
      });
      const restantes = MAX_VERIFICATION_ATTEMPTS - actualizado.attempts;

      if (restantes <= 0) {
        logger.warn({ userId }, 'Código de contraseña agotado por intentos fallidos');
        throw new AppError('Demasiados intentos fallidos. Pide un código nuevo.', {
          statusCode: 429,
          code: ERROR_CODES.TOO_MANY_ATTEMPTS,
        });
      }

      throw codigoInvalido(restantes);
    }

    // El código se gasta dentro de la misma transacción que el cambio: si algo
    // falla después, no puede quedar una contraseña nueva con su código todavía
    // válido para volver a cambiarla.
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { passwordHash: await hashPassword(newPassword) },
      }),
      prisma.accountCode.delete({ where: { id: guardado.id } }),
    ]);

    // Se busca la sesión desde la que se pidió el cambio para NO cerrarla. Si no
    // aparece, `revokeOthersForUser` echa a todos, incluida esta.
    const actual = refreshActual
      ? await tokenRepository.findRefreshByHash(hashToken(refreshActual))
      : null;

    const { count } = await tokenRepository.revokeOthersForUser(userId, actual?.id);
    logger.warn({ userId, sesionesCerradas: count }, 'Contraseña cambiada');

    return { sesionesCerradas: count };
  },

  /**
   * Crea una cuenta de administrador. Solo la crea otro administrador.
   *
   * Nace verificada y sin pasar por el alta normal: no hay a quién mandarle un
   * código de confirmación que signifique algo, porque quien decide que esa
   * persona entra no es ella, es quien la crea.
   *
   * Si el correo ya tiene cuenta se rechaza en vez de ascenderla. Convertir a un
   * comprador en administrador desde un formulario de alta es demasiado fácil de
   * hacer sin querer: el correo se teclea, y un dedo puede escribir el de un
   * cliente.
   */
  async createAdmin({ firstName, lastName, email, password }, creadoPor) {
    const existe = await userRepository.findByEmail(email);
    if (existe) {
      throw new ConflictError(
        'Ya existe una cuenta con ese correo. Si quieres darle acceso, hay que hacerlo sobre esa cuenta, no crear otra.',
        ERROR_CODES.EMAIL_ALREADY_REGISTERED,
      );
    }

    const clave = password || claveProvisional();
    const generada = !password;

    const user = await userRepository.create({
      email,
      firstName,
      lastName,
      passwordHash: await hashPassword(clave),
      role: ROLES.ADMIN,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });

    // El correo va después de crear, no dentro: si el envío falla, la cuenta ya
    // existe y la contraseña se puede dictar. Al revés —deshacer el alta porque
    // no salió un correo— se pierde el trabajo por el eslabón más frágil.
    let emailSent = true;
    try {
      await sendMail({ to: email, ...adminAccountCreated({ firstName, email, password: clave }) });
    } catch (error) {
      emailSent = false;
      logger.error({ err: error, email }, 'No se pudo enviar el correo de alta de administrador');
    }

    logger.warn({ email, creadoPor, emailSent }, 'Cuenta de administrador creada');

    return {
      user,
      emailSent,
      // La contraseña vuelve al panel SOLO si la generó el servidor: es la única
      // vez que se puede leer, y quien la creó necesita poder dictarla si el
      // correo no llega.
      password: generada ? clave : null,
    };
  },
};

module.exports = userService;
