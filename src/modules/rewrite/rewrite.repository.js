'use strict';

const prisma = require('../../lib/prisma');

/** Lo que se devuelve al cliente. `sourceText` solo en el detalle, no en la lista. */
const listSelect = {
  id: true,
  mode: true,
  chapter: true,
  status: true,
  sourceWords: true,
  createdAt: true,
};

const detailSelect = {
  ...listSelect,
  sourceText: true,
  resultText: true,
  errorCode: true,
  durationMs: true,
};

const rewriteRepository = {
  detailSelect,

  create(data) {
    return prisma.rewrite.create({ data, select: detailSelect });
  },

  findForUser(id, userId) {
    return prisma.rewrite.findFirst({ where: { id, userId }, select: detailSelect });
  },

  async paginateForUser(userId, { page, perPage }) {
    const [items, total] = await Promise.all([
      prisma.rewrite.findMany({
        where: { userId },
        select: listSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      prisma.rewrite.count({ where: { userId } }),
    ]);

    return { items, meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) } };
  },
};

module.exports = rewriteRepository;
