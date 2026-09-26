'use strict';

const logger = require('../../config/logger');
const { NotFoundError } = require('../../shared/errors/AppError');
const datos = require('./ventas.datos');
const pdf = require('./ventas.pdf');
const ventasRepository = require('./ventas.repository');

/**
 * Ventas mensuales: el cierre de cada mes en PDF y el mes en curso.
 *
 * Un mes se cierra en cuanto termina (hora de Lima): lo hace el servidor solo,
 * cada pocas horas (`server.js`), y también al abrir la lista en el panel, por
 * si el servidor estaba apagado justo el día 1. Cerrar guarda una foto —PDF y
 * detalle— que ya no cambia aunque luego se borre un pago del historial.
 *
 * El detalle estructurado de cada cierre es lo que usará la integración con
 * SUNAT cuando llegue; hoy no se envía nada a ningún sitio.
 */

/** Las ventas de un mes, ya normalizadas y ordenadas. */
async function ventasDe(periodo) {
  const desde = datos.inicioDelMes(periodo.anio, periodo.mes);
  const siguiente = datos.siguiente(periodo);
  const hasta = datos.inicioDelMes(siguiente.anio, siguiente.mes);

  const [pagos, codigos] = await Promise.all([
    ventasRepository.pagosCobrados(desde, hasta),
    ventasRepository.codigosVendidos(desde, hasta),
  ]);
  const [idsDeCodigos, nombresDeProducto] = await Promise.all([
    ventasRepository.codigosEntre(pagos.map((p) => p.providerOrderId).filter(Boolean)),
    ventasRepository.nombresDeProducto([...new Set(codigos.map((c) => c.productCode))]),
  ]);

  return datos.ventasDelMes({ pagos, codigos, idsDeCodigos, nombresDeProducto });
}

/** Cierra un mes terminado. Si otro proceso ya lo cerró, no hace nada. */
async function cerrarMes(periodo) {
  const ventas = await ventasDe(periodo);
  const resumen = datos.resumir(ventas);
  const generado = new Date();

  const documento = await pdf.generarReporte({
    periodo,
    ventas,
    resumen,
    solesPorDolar: datos.SOLES_POR_DOLAR,
    generado,
    borrador: false,
  });

  try {
    const cierre = await ventasRepository.crearCierre({
      anio: periodo.anio,
      mes: periodo.mes,
      ventas: resumen.ventas,
      totalSolesCents: resumen.totalSolesCents,
      totalesPorMoneda: resumen.totalesPorMoneda,
      detalle: ventas,
      solesPorDolar: datos.SOLES_POR_DOLAR,
      pdf: documento,
      creadoEn: generado,
    });
    logger.info(
      { anio: periodo.anio, mes: periodo.mes, ventas: resumen.ventas, total: resumen.totalSolesCents },
      'Mes de ventas cerrado',
    );
    return cierre;
  } catch (error) {
    // Dos cierres a la vez (el temporizador y el panel): gana el primero.
    if (error?.code === 'P2002') return null;
    throw error;
  }
}

const ventasService = {
  /**
   * Cierra todos los meses terminados que aún no tienen cierre, desde el de la
   * primera venta. Devuelve cuántos cerró.
   */
  async cerrarPendientes(ahora = new Date()) {
    const primera = await ventasRepository.primeraVenta();
    if (!primera) return 0;

    const cerrados = new Set(
      (await ventasRepository.listarCierres()).map((c) => `${c.anio}-${c.mes}`),
    );
    const pendientes = datos
      .mesesTerminados(datos.mesDeLima(primera), ahora)
      .filter((m) => !cerrados.has(`${m.anio}-${m.mes}`));

    let n = 0;
    for (const periodo of pendientes) {
      if (await cerrarMes(periodo)) n += 1;
    }
    return n;
  },

  /** Los meses cerrados y el resumen del mes en curso. */
  async listar(ahora = new Date()) {
    await this.cerrarPendientes(ahora);

    const actual = datos.mesDeLima(ahora);
    const [cierres, ventas] = await Promise.all([
      ventasRepository.listarCierres(),
      ventasDe(actual),
    ]);
    const resumen = datos.resumir(ventas);

    return {
      enCurso: {
        anio: actual.anio,
        mes: actual.mes,
        ventas: resumen.ventas,
        totalSolesCents: resumen.totalSolesCents,
        totalesPorMoneda: resumen.totalesPorMoneda,
      },
      cierres,
    };
  },

  /**
   * El PDF de un mes: el guardado si ya se cerró, o un borrador generado al
   * momento si es el mes en curso.
   */
  async pdfDelMes({ anio, mes }, ahora = new Date()) {
    const periodo = { anio, mes };
    const actual = datos.mesDeLima(ahora);

    if (anio === actual.anio && mes === actual.mes) {
      const ventas = await ventasDe(periodo);
      const documento = await pdf.generarReporte({
        periodo,
        ventas,
        resumen: datos.resumir(ventas),
        solesPorDolar: datos.SOLES_POR_DOLAR,
        generado: ahora,
        borrador: true,
      });
      return { nombre: pdf.nombreDeArchivo(periodo, true), pdf: documento };
    }

    let cierre = await ventasRepository.buscarCierre(anio, mes);
    if (!cierre) {
      // Un mes terminado sin cierre todavía: se cierra ahora mismo.
      await this.cerrarPendientes(ahora);
      cierre = await ventasRepository.buscarCierre(anio, mes);
    }
    if (!cierre) throw new NotFoundError('No hay ventas registradas para ese mes.');

    return { nombre: pdf.nombreDeArchivo(periodo), pdf: Buffer.from(cierre.pdf) };
  },
};

module.exports = ventasService;
