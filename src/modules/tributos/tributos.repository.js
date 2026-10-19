'use strict';

const prisma = require('../../lib/prisma');
const { inicioDelMes } = require('../ventas/ventas.datos');
const { siguiente } = require('./tributos.calculo');

/** Primer día del mes como fecha de una columna DATE (medianoche UTC). */
function diaUno({ anio, mes }) {
  return new Date(Date.UTC(anio, mes - 1, 1));
}

const tributosRepository = {
  /** Boletas y notas aceptadas emitidas en el mes (hora de Lima). */
  comprobantesDelMes(periodo) {
    const sig = siguiente(periodo);
    return prisma.comprobante.findMany({
      where: {
        estado: { in: ['ACEPTADO', 'OBSERVADO'] },
        fechaEmision: { gte: inicioDelMes(periodo.anio, periodo.mes), lt: inicioDelMes(sig.anio, sig.mes) },
      },
      select: { tipo: true, valorCents: true, igvCents: true },
    });
  },

  comprasDelMes(periodo) {
    return prisma.compraRegistrada.findMany({
      where: { fecha: { gte: diaUno(periodo), lt: diaUno(siguiente(periodo)) } },
      orderBy: [{ fecha: 'asc' }, { creadoEn: 'asc' }],
    });
  },

  declaraciones() {
    return prisma.declaracionMensual.findMany();
  },

  declaracion({ anio, mes }) {
    return prisma.declaracionMensual.findUnique({ where: { anio_mes: { anio, mes } } });
  },

  /** Cambia (o crea) la fila de un mes. */
  guardar({ anio, mes }, data) {
    return prisma.declaracionMensual.upsert({
      where: { anio_mes: { anio, mes } },
      create: { anio, mes, ...data },
      update: data,
    });
  },

  /** El primer administrador activo, si no hay ADMIN_NOTIFY_EMAIL (mismo criterio que el aviso de Yape). */
  async correoDelAdministrador() {
    const admin = await prisma.user.findFirst({
      where: { role: 'ADMIN', status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: { email: true },
    });
    return admin?.email ?? null;
  },

  crearCompra(data) {
    return prisma.compraRegistrada.create({ data });
  },

  borrarCompra(id) {
    return prisma.compraRegistrada.deleteMany({ where: { id } });
  },
};

module.exports = tributosRepository;
