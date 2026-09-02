'use strict';

const crypto = require('node:crypto');
const env = require('../../config/env');
const logger = require('../../config/logger');
const { ERROR_CODES } = require('../../config/constants');
const userRepository = require('../users/user.repository');
const tokenRepository = require('./token.repository');
const { sendMail } = require('../../lib/mailer');
const { emailVerification, buildVerificationUrl } = require('../../lib/emailTemplates');
const { hashPassword, verifyPassword, fakeVerify } = require('../../shared/utils/password');
const {
  signAccessToken,
  generateOpaqueToken,
  hashToken,
  addDays,
  addHours,
} = require('../../shared/utils/tokens');
const {
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

async function sendVerificationEmail(user) {
  await tokenRepository.consumePendingVerifications(user.id, 'EMAIL_VERIFICATION');

  const token = generateOpaqueToken(32);
  await tokenRepository.createVerificationToken({
    tokenHash: hashToken(token),
    type: 'EMAIL_VERIFICATION',
    userId: user.id,
    expiresAt: addHours(new Date(), env.EMAIL_VERIFICATION_TTL_HOURS),
  });

  const mail = emailVerification({
    firstName: user.firstName,
    verificationUrl: buildVerificationUrl(token),
    expiresInHours: env.EMAIL_VERIFICATION_TTL_HOURS,
  });

  await sendMail({ to: user.email, ...mail });
}

const authService = {
  /**
   * Alta de usuario. No inicia sesión: la cuenta queda en PENDING hasta que
   * el usuario confirme su correo.
   */
  async register({ firstName, lastName, email, password }) {
    const existing = await userRepository.findByEmail(email);
    if (existing) {
      throw new ConflictError(
        'Ya existe una cuenta con ese correo.',
        ERROR_CODES.EMAIL_ALREADY_REGISTERED,
      );
    }

    const user = await userRepository.create({
      firstName,
      lastName,
      email,
      passwordHash: await hashPassword(password),
    });

    await sendVerificationEmail(user);
    return user;
  },

  async login({ email, password }, context) {
    const user = await userRepository.findByEmailWithSecret(email);

    if (!user) {
      // Mismo coste que una verificación real: no se filtra si el correo existe.
      await fakeVerify(password);
      throw new UnauthorizedError('Correo o contraseña incorrectos.', ERROR_CODES.INVALID_CREDENTIALS);
    }

    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedError('Correo o contraseña incorrectos.', ERROR_CODES.INVALID_CREDENTIALS);
    }

    if (user.status === 'SUSPENDED') {
      throw new ForbiddenError('Tu cuenta está suspendida.', ERROR_CODES.ACCOUNT_SUSPENDED);
    }

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

  async verifyEmail(rawToken) {
    const stored = await tokenRepository.findVerificationByHash(hashToken(rawToken));

    if (!stored || stored.type !== 'EMAIL_VERIFICATION' || stored.consumedAt) {
      throw new UnauthorizedError('El enlace de verificación no es válido.', ERROR_CODES.INVALID_TOKEN);
    }

    if (stored.expiresAt <= new Date()) {
      throw new UnauthorizedError('El enlace de verificación expiró.', ERROR_CODES.TOKEN_EXPIRED);
    }

    await tokenRepository.confirmEmail(stored.id, stored.userId);
    return userRepository.findById(stored.userId);
  },

  /**
   * Reenvía el correo de verificación. Responde siempre igual, exista o no la
   * cuenta, para no permitir enumerar correos registrados.
   */
  async resendVerification(email) {
    const user = await userRepository.findByEmail(email);
    if (user && !user.emailVerifiedAt) {
      await sendVerificationEmail(user);
    }
  },
};

module.exports = authService;
