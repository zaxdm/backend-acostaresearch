'use strict';

const prisma = require('../../lib/prisma');

/** Una columna DATE desde «2026-11-03». */
function comoFecha(dia) {
  return new Date(`${dia}T00:00:00Z`);
}

const cajaRepository = {
  comoFecha,

  saldoInicial() {
    return prisma.movimientoCaja.findFirst({
      where: { tipo: 'SALDO_INICIAL' },
      orderBy: { fecha: 'asc' },
    });
  },

  /** Entradas y salidas apuntadas a mano entre dos días (ambos incluidos). */
  movimientosEntre(desdeDia, hastaDia) {
    return prisma.movimientoCaja.findMany({
      where: {
        tipo: { in: ['ENTRADA', 'SALIDA'] },
        fecha: { gte: comoFecha(desdeDia), lte: comoFecha(hastaDia) },
      },
      orderBy: { fecha: 'asc' },
    });
  },

  /** El movimiento apuntado más antiguo (sin contar el saldo inicial). */
  primerMovimiento() {
    return prisma.movimientoCaja.findFirst({
      where: { tipo: { in: ['ENTRADA', 'SALIDA'] } },
      orderBy: { fecha: 'asc' },
      select: { fecha: true },
    });
  },

  contarAntesDe(dia) {
    return prisma.movimientoCaja.count({
      where: { tipo: { in: ['ENTRADA', 'SALIDA'] }, fecha: { lt: comoFecha(dia) } },
    });
  },

  buscar(id) {
    return prisma.movimientoCaja.findUnique({ where: { id } });
  },

  crear(data) {
    return prisma.movimientoCaja.create({ data });
  },

  actualizar(id, data) {
    return prisma.movimientoCaja.update({ where: { id }, data });
  },

  borrar(id) {
    return prisma.movimientoCaja.delete({ where: { id } });
  },
};

module.exports = cajaRepository;
