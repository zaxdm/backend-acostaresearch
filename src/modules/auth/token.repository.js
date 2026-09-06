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

  /**
   * Cierra todas las sesiones menos una. Para cuando se cambia la contraseña.
   *
   * Sin `keepId` echa a todo el mundo, lo mismo que la de arriba: si la sesión
   * que pidió el cambio no se pudo identificar —cookie perdida, token ya
   * rotado—, se prefiere sacar a todos y que el dueño vuelva a entrar antes que
   * dejar dentro por si acaso a quien tal vez no debería estar.
   */
  revokeOthersForUser(userId, keepId) {
    return prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null, ...(keepId ? { id: { not: keepId } } : {}) },
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
