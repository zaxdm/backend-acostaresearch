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

  /**
   * Las compras que dan crédito en el mes: las facturas por su fecha y las del
   * extranjero por el día en que se pagó su IGV con el 1662.
   */
  comprasDelMes(periodo) {
    const enElMes = { gte: diaUno(periodo), lt: diaUno(siguiente(periodo)) };
    return prisma.compraRegistrada.findMany({
      where: {
        OR: [
          { tipo: 'FACTURA', fecha: enElMes },
          { tipo: 'EXTRANJERO', igvPagadoEn: enElMes },
        ],
      },
      orderBy: [{ fecha: 'asc' }, { creadoEn: 'asc' }],
    });
  },

  /** Las del extranjero cuyo IGV aún no se pagó con el 1662, de cualquier mes. */
  extranjerasPorPagar() {
    return prisma.compraRegistrada.findMany({
      where: { tipo: 'EXTRANJERO', igvPagadoEn: null },
      orderBy: [{ fecha: 'asc' }, { creadoEn: 'asc' }],
    });
  },

  buscarCompra(id) {
    return prisma.compraRegistrada.findUnique({ where: { id } });
  },

  actualizarCompra(id, data) {
    return prisma.compraRegistrada.update({ where: { id }, data });
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
