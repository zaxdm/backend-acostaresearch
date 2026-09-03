'use strict';

const prisma = require('../../lib/prisma');

const pendingRegistrationRepository = {
  findByEmail(email) {
    return prisma.pendingRegistration.findUnique({ where: { email } });
  },

  /**
   * Un alta pendiente por correo. Registrarse otra vez con el mismo correo
   * sobrescribe la anterior en lugar de fallar: mientras no se verifique,
   * el alta no está reservada.
   */
  upsert({ email, passwordHash, firstName, lastName, codeHash, expiresAt }) {
    const datos = { passwordHash, firstName, lastName, codeHash, expiresAt, attempts: 0 };
    return prisma.pendingRegistration.upsert({
      where: { email },
      update: datos,
      create: { email, ...datos },
    });
  },

  /** Código nuevo para un alta que ya existe; reinicia los intentos. */
  refreshCode(id, { codeHash, expiresAt }) {
    return prisma.pendingRegistration.update({
      where: { id },
      data: { codeHash, expiresAt, attempts: 0 },
    });
  },

  registerFailedAttempt(id) {
    return prisma.pendingRegistration.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
  },

  /**
   * El momento del alta: nace el usuario y desaparece el pendiente, en una
   * transacción para que no pueda quedar a medias.
   */
  promoteToUser(pendingId, datosUsuario, select) {
    return prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: datosUsuario, select });
      await tx.pendingRegistration.delete({ where: { id: pendingId } });
      return user;
    });
  },
};

module.exports = pendingRegistrationRepository;
