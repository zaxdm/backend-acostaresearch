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
};

module.exports = tokenRepository;
