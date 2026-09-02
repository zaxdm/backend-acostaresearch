'use strict';

const prisma = require('../../lib/prisma');

const tokenRepository = {
  // ── Refresh tokens ──────────────────────────────────────────────────────
  createRefreshToken(data) {
    return prisma.refreshToken.create({ data });
  },

  findRefreshByHash(tokenHash) {
    return prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
  },

  revokeRefreshToken(id) {
    return prisma.refreshToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  },

  /** Corta de raíz una sesión completa: se usa al detectar reutilización. */
  revokeFamily(familyId) {
    return prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  revokeAllForUser(userId) {
    return prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  /** Rotación atómica: revocar el token usado y emitir el siguiente de la familia. */
  rotate(currentId, nextData) {
    return prisma.$transaction([
      prisma.refreshToken.update({ where: { id: currentId }, data: { revokedAt: new Date() } }),
      prisma.refreshToken.create({ data: nextData }),
    ]);
  },

  // ── Tokens de verificación ──────────────────────────────────────────────
  createVerificationToken(data) {
    return prisma.verificationToken.create({ data });
  },

  findVerificationByHash(tokenHash) {
    return prisma.verificationToken.findUnique({ where: { tokenHash } });
  },

  /** Invalida los tokens vigentes antes de emitir uno nuevo. */
  consumePendingVerifications(userId, type) {
    return prisma.verificationToken.updateMany({
      where: { userId, type, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  },

  /** Marca el correo como verificado y consume el token en una sola transacción. */
  confirmEmail(tokenId, userId) {
    const now = new Date();
    return prisma.$transaction([
      prisma.verificationToken.update({ where: { id: tokenId }, data: { consumedAt: now } }),
      prisma.user.update({
        where: { id: userId },
        data: { emailVerifiedAt: now, status: 'ACTIVE' },
      }),
    ]);
  },
};

module.exports = tokenRepository;
