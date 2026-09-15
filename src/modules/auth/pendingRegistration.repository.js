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

  /**
   * Suma un intento fallido, y dice si todavía quedaba alguno.
   *
   * La cuenta se leía, se comparaba y se incrementaba en tres pasos: con
   * peticiones en paralelo cabían más de los cinco intentos por código. La
   * condición va dentro del propio UPDATE, así que solo uno de los que llegan a
   * la vez se lleva el último intento.
   */
  async registerFailedAttempt(id, maximo) {
    const { count } = await prisma.pendingRegistration.updateMany({
      where: { id, attempts: { lt: maximo } },
      data: { attempts: { increment: 1 } },
    });

    // `sumado` dice si ESTA llamada se llevó un intento, y no cuántos hay: con
    // varias a la vez, releer la cuenta devuelve la de todas juntas.
    if (count === 0) return { sumado: false, agotado: true, attempts: maximo };

    const actual = await prisma.pendingRegistration.findUnique({
      where: { id },
      select: { attempts: true },
    });
    const attempts = actual?.attempts ?? maximo;
    return { sumado: true, agotado: attempts >= maximo, attempts };
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
