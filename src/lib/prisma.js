'use strict';

const { PrismaClient } = require('@prisma/client');
const env = require('../config/env');
const logger = require('../config/logger');

const prisma = new PrismaClient({
  log: env.isDevelopment
    ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
    : ['warn', 'error'],
});

if (env.isDevelopment) {
  prisma.$on('query', (e) => {
    logger.debug({ query: e.query, duration: `${e.duration}ms` }, 'prisma');
  });
}

module.exports = prisma;
