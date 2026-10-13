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
  // La etiqueta de país: en un administrador de país, el que administra; en un
  // cliente, el que lo consiguió.
  pais: true,
  sessionVersion: true,
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

  /**
   * `licencia` criba por si la cuenta tiene alguna licencia emitida («con») o
   * ninguna («sin»); revocada o suspendida también cuenta, que es donde se va a
   * reactivarla. `paisDeLicencias` es el del administrador de país: él solo ve
   * las licencias de las cuentas de su país, así que para él solo esas «tienen».
   *
   * `conteo` cuenta las tres pestañas con la misma búsqueda, sin la criba.
   */
  async paginate({ page, perPage, search, licencia, paisDeLicencias }) {
    // Sin mode: insensitive, que no existe en MySQL. No hace falta, porque la
    // colación por defecto de MySQL/MariaDB (utf8mb4_..._ci) ya ignora mayúsculas.
    //
    // Los invitados de los enlaces de prueba no salen: no son cuentas de nadie,
    // solo el titular de relleno de un conector. Se ven en su propia sección.
    const base = {
      trialLinkId: null,
      ...(search && {
        OR: [
          { email: { contains: search } },
          { firstName: { contains: search } },
          { lastName: { contains: search } },
        ],
      }),
    };
    const conLicencia = {
      licenses: { some: {} },
      ...(paisDeLicencias && { pais: paisDeLicencias }),
    };
    const where =
      licencia === 'con'
        ? { ...base, AND: [conLicencia] }
        : licencia === 'sin'
          ? { ...base, NOT: conLicencia }
          : base;

    const [items, total, todos, con] = await Promise.all([
      prisma.user.findMany({
        where,
        select: publicSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      prisma.user.count({ where }),
      prisma.user.count({ where: base }),
      prisma.user.count({ where: { ...base, AND: [conLicencia] } }),
    ]);

    return {
      items,
      meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
      conteo: { todos, con, sin: todos - con },
    };
  },
};

module.exports = userRepository;
