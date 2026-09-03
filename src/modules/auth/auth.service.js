'use strict';

const crypto = require('node:crypto');
const env = require('../../config/env');
const logger = require('../../config/logger');
const {
  ERROR_CODES,
  VERIFICATION_CODE_LENGTH,
  MAX_VERIFICATION_ATTEMPTS,
} = require('../../config/constants');
const userRepository = require('../users/user.repository');
const tokenRepository = require('./token.repository');
const pendingRepository = require('./pendingRegistration.repository');
const billingService = require('../billing/billing.service');
const { sendMail } = require('../../lib/mailer');
const { emailVerificationCode } = require('../../lib/emailTemplates');
const { hashPassword, verifyPassword, fakeVerify } = require('../../shared/utils/password');
const {
  signAccessToken,
  generateOpaqueToken,
  generateNumericCode,
  hashToken,
  safeCompareHex,
  addDays,
  addMinutes,
} = require('../../shared/utils/tokens');
const {
  AppError,
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
} = require('../../shared/errors/AppError');

/** Emite un refresh token nuevo y devuelve el valor en claro (solo aquí existe). */
async function issueRefreshToken({ userId, familyId, context }) {
  const token = generateOpaqueToken();
  const expiresAt = addDays(new Date(), env.JWT_REFRESH_TTL_DAYS);

  const data = {
    tokenHash: hashToken(token),
    familyId: familyId ?? crypto.randomUUID(),
    userId,
    expiresAt,
    ip: context?.ip ?? null,
    userAgent: context?.userAgent ?? null,
  };

  return { token, expiresAt, data };
}

/** Genera el código, lo guarda hasheado en el alta pendiente y lo envía. */
async function sendCode(pending, { firstName }) {
  const code = generateNumericCode(VERIFICATION_CODE_LENGTH);
  const expiresAt = addMinutes(new Date(), env.EMAIL_VERIFICATION_TTL_MINUTES);

  await pendingRepository.refreshCode(pending.id, { codeHash: hashToken(code), expiresAt });

  const mail = emailVerificationCode({
    firstName,
    code,
    expiresInMinutes: env.EMAIL_VERIFICATION_TTL_MINUTES,
  });

  await sendMail({ to: pending.email, ...mail });
}

/** Mensaje único para código erróneo, inexistente o de otra cuenta. */
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

const authService = {
  /**
   * Registro: NO crea el usuario. Guarda los datos como alta pendiente y envía
   * el código. La cuenta nace en verifyEmail, al acertar el código, de modo que
   * la tabla de usuarios solo contiene correos verificados.
   */
  async register({ firstName, lastName, email, password }) {
    const existing = await userRepository.findByEmail(email);
    if (existing) {
      throw new ConflictError(
        'Ya existe una cuenta con ese correo.',
        ERROR_CODES.EMAIL_ALREADY_REGISTERED,
      );
    }

    // Repetir el registro con un correo aún sin verificar sobrescribe el intento
    // anterior: mientras no se confirme, ese correo no está reservado por nadie.
    const pending = await pendingRepository.upsert({
      email,
      firstName,
      lastName,
      passwordHash: await hashPassword(password),
      codeHash: '',
      expiresAt: new Date(),
    });

    // El alta pendiente queda guardada aunque el correo falle, así el usuario
    // puede pedir el código otra vez sin rellenar el formulario de nuevo.
    let emailSent = true;
    try {
      await sendCode(pending, { firstName });
    } catch (error) {
      emailSent = false;
      logger.error({ err: error, email }, 'No se pudo enviar el código de verificación');
    }

    return { email, emailSent };
  },

  async login({ email, password }, context) {
    const user = await userRepository.findByEmailWithSecret(email);

    if (!user) {
      // Mismo coste que una verificación real: no se filtra si el correo existe.
      await fakeVerify(password);
      throw new UnauthorizedError(
        'Correo o contraseña incorrectos.',
        ERROR_CODES.INVALID_CREDENTIALS,
      );
    }

    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedError(
        'Correo o contraseña incorrectos.',
        ERROR_CODES.INVALID_CREDENTIALS,
      );
    }

    if (user.status === 'SUSPENDED') {
      throw new ForbiddenError('Tu cuenta está suspendida.', ERROR_CODES.ACCOUNT_SUSPENDED);
    }

    // Red de seguridad: un usuario creado a mano sin verificar tampoco entra.
    if (!user.emailVerifiedAt) {
      throw new ForbiddenError(
        'Debes confirmar tu correo antes de iniciar sesión.',
        ERROR_CODES.EMAIL_NOT_VERIFIED,
      );
    }

    const { token, expiresAt, data } = await issueRefreshToken({ userId: user.id, context });
    await tokenRepository.createRefreshToken(data);

    const publicUser = await userRepository.update(user.id, { lastLoginAt: new Date() });

    return {
      user: publicUser,
      accessToken: signAccessToken({ userId: user.id, role: user.role, email: user.email }),
      refreshToken: token,
      refreshExpiresAt: expiresAt,
    };
  },

  /**
   * Rota el refresh token. Si llega uno ya revocado se asume robo de sesión
   * y se revoca la familia entera, obligando a iniciar sesión de nuevo.
   */
  async refresh(rawToken, context) {
    if (!rawToken) {
      throw new UnauthorizedError('No hay sesión activa.', ERROR_CODES.INVALID_TOKEN);
    }

    const stored = await tokenRepository.findRefreshByHash(hashToken(rawToken));
    if (!stored) {
      throw new UnauthorizedError('Sesión inválida.', ERROR_CODES.INVALID_TOKEN);
    }

    if (stored.revokedAt) {
      await tokenRepository.revokeFamily(stored.familyId);
      logger.warn(
        { userId: stored.userId, familyId: stored.familyId },
        'Reutilización de refresh token: familia revocada',
      );
      throw new UnauthorizedError('Sesión inválida.', ERROR_CODES.INVALID_TOKEN);
    }

    if (stored.expiresAt <= new Date()) {
      throw new UnauthorizedError('La sesión expiró.', ERROR_CODES.TOKEN_EXPIRED);
    }

    if (stored.user.status !== 'ACTIVE') {
      await tokenRepository.revokeAllForUser(stored.userId);
      throw new ForbiddenError('La cuenta no está activa.', ERROR_CODES.ACCOUNT_SUSPENDED);
    }

    const { token, expiresAt, data } = await issueRefreshToken({
      userId: stored.userId,
      familyId: stored.familyId,
      context,
    });
    await tokenRepository.rotate(stored.id, data);

    return {
      accessToken: signAccessToken({
        userId: stored.user.id,
        role: stored.user.role,
        email: stored.user.email,
      }),
      refreshToken: token,
      refreshExpiresAt: expiresAt,
    };
  },

  /** Cierra la sesión actual. Es idempotente: un token desconocido no es error. */
  async logout(rawToken) {
    if (!rawToken) return;

    const stored = await tokenRepository.findRefreshByHash(hashToken(rawToken));
    if (stored && !stored.revokedAt) {
      await tokenRepository.revokeFamily(stored.familyId);
    }
  },

  /** Cierra todas las sesiones del usuario en todos sus dispositivos. */
  async logoutAll(userId) {
    await tokenRepository.revokeAllForUser(userId);
  },

  /**
   * Aquí nace la cuenta. Exigir el correo además del código impide barrer el
   * espacio de 6 dígitos contra cualquier alta: hay que acertar el código de un
   * correo concreto, y cada código muere a los 5 fallos.
   */
  async verifyEmail({ email, code }) {
    const pending = await pendingRepository.findByEmail(email);

    if (!pending) {
      // Puede que ya se verificara: repetir el formulario no debe dar error.
      const user = await userRepository.findByEmail(email);
      if (user) return user;
      throw codigoInvalido(0);
    }

    if (pending.attempts >= MAX_VERIFICATION_ATTEMPTS) {
      throw new AppError('Demasiados intentos fallidos. Pide un código nuevo.', {
        statusCode: 429,
        code: ERROR_CODES.TOO_MANY_ATTEMPTS,
      });
    }

    if (pending.expiresAt <= new Date()) {
      throw new AppError('El código caducó. Pide uno nuevo.', {
        statusCode: 400,
        code: ERROR_CODES.TOKEN_EXPIRED,
      });
    }

    if (!safeCompareHex(pending.codeHash, hashToken(code))) {
      const actualizado = await pendingRepository.registerFailedAttempt(pending.id);
      const restantes = MAX_VERIFICATION_ATTEMPTS - actualizado.attempts;

      if (restantes <= 0) {
        logger.warn({ email }, 'Código de verificación agotado por intentos fallidos');
        throw new AppError('Demasiados intentos fallidos. Pide un código nuevo.', {
          statusCode: 429,
          code: ERROR_CODES.TOO_MANY_ATTEMPTS,
        });
      }

      throw codigoInvalido(restantes);
    }

    const user = await pendingRepository.promoteToUser(
      pending.id,
      {
        email: pending.email,
        passwordHash: pending.passwordHash,
        firstName: pending.firstName,
        lastName: pending.lastName,
        emailVerifiedAt: new Date(),
      },
      userRepository.publicSelect,
    );

    // Prueba gratuita del humanizador. Si falla, la cuenta ya está creada y no
    // debe romperse el alta por esto: el admin siempre puede activarla a mano.
    try {
      await billingService.grantTrial(user.id);
    } catch (error) {
      logger.error({ err: error, userId: user.id }, 'No se pudo activar la prueba gratuita');
    }

    logger.info({ userId: user.id, email: user.email }, 'Cuenta creada tras verificar el código');
    return user;
  },

  /**
   * Reenvía el código del alta pendiente. Responde siempre igual, exista o no,
   * para no permitir enumerar correos registrados.
   */
  async resendVerification(email) {
    const pending = await pendingRepository.findByEmail(email);
    if (!pending) return;

    await sendCode(pending, { firstName: pending.firstName });
  },
};

module.exports = authService;
