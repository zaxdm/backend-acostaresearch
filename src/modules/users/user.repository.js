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

  findByEmail(email) {
    return prisma.user.findUnique({ where: { email }, select: publicSelect });
  },

  create(data) {
    return prisma.user.create({ data, select: publicSelect });
  },

  update(id, data) {
    return prisma.user.update({ where: { id }, data, select: publicSelect });
  },

  async paginate({ page, perPage, search }) {
    const where = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};

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
