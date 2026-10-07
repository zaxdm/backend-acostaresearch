'use strict';

const prisma = require('../../lib/prisma');

/** Campos que pueden salir de la API. `passwordHash` nunca se selecciona. */
const publicSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  status: true,
  emailVerifiedAt: true,
  lastLoginAt: true,
  createdAt: true,
};

const userRepository = {
  publicSelect,

  findById(id) {
    return prisma.user.findUnique({ where: { id }, select: publicSelect });
  },

  /** Incluye el hash: uso exclusivo del flujo de login. */
  findByEmailWithSecret(email) {
    return prisma.user.findUnique({ where: { email } });
  },

  findByGoogleId(googleId) {
    return prisma.user.findUnique({ where: { googleId } });
  },

  findByEmail(email) {
    return prisma.user.findUnique({ where: { email }, select: publicSelect });
  },

  create(data) {
    return prisma.user.create({ data, select: publicSelect });
  },

  /**
   * La cuenta que abrió una compra en Hotmart y que su dueño aún no reclamó.
   *
   * Quien paga en Hotmart sin cuenta en la web recibe una, sin contraseña ni
   * Google y sin verificar, para entregarle lo comprado. Registrarse después
   * con ese correo la reclama en vez de chocar con «ya existe». Se exige todo
   * a la vez para que ninguna otra cuenta —una de Google, un invitado de un
   * enlace de prueba, una que ya se usa— se pueda reclamar así.
   */
  findPorReclamar(email) {
    return prisma.user.findFirst({
      where: {
        email,
        passwordHash: null,
        googleId: null,
        trialLinkId: null,
        emailVerifiedAt: null,
        payments: { some: { provider: 'HOTMART' } },
      },
      select: { id: true },
    });
  },

  update(id, data) {
    return prisma.user.update({ where: { id }, data, select: publicSelect });
  },

  async paginate({ page, perPage, search }) {
    // Sin mode: insensitive, que no existe en MySQL. No hace falta, porque la
    // colación por defecto de MySQL/MariaDB (utf8mb4_..._ci) ya ignora mayúsculas.
    //
    // Los invitados de los enlaces de prueba no salen: no son cuentas de nadie,
    // solo el titular de relleno de un conector. Se ven en su propia sección.
    const where = {
      trialLinkId: null,
      ...(search && {
        OR: [
          { email: { contains: search } },
          { firstName: { contains: search } },
          { lastName: { contains: search } },
        ],
      }),
    };

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: publicSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      prisma.user.count({ where }),
    ]);

    return { items, meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) } };
  },
};

module.exports = userRepository;
