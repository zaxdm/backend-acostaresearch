'use strict';

const { NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const ventasService = require('../ventas/ventas.service');
const sunatRepository = require('../sunat/sunat.repository');
const datos = require('./caja.datos');
const cajaRepository = require('./caja.repository');

/**
 * Flujo de caja del panel (/admin → Accesos → «Flujo de caja»).
 *
 * Entran solas las ventas de la web (las mismas que «Ventas mensuales») y los
 * servicios registrados con boleta. Lo demás —gastos, entradas por fuera, el
 * saldo inicial— se apunta a mano. El cálculo día por día está en `caja.datos`.
 */

function formatoInicio(fila) {
  if (!fila) return null;
  return { ...datos.movimientoManual(fila), dia: datos.diaDeColumna(fila.fecha) };
}

function datosDeMovimiento(entrada) {
  return {
    tipo: entrada.tipo,
    montoCents: entrada.montoCents,
    moneda: entrada.moneda,
    solesCents: datos.aSoles(entrada.montoCents, entrada.moneda),
    concepto: entrada.concepto.trim(),
    categoria: entrada.categoria?.trim() || null,
    medio: entrada.medio?.trim() || null,
  };
}

function comprobarDia(dia, hoy) {
  if (dia > hoy) throw new ValidationError('No se puede apuntar en un día que todavía no llega.');
}

async function exigirInicio(dia) {
  const inicio = await cajaRepository.saldoInicial();
  if (!inicio) {
    throw new ValidationError('Primero pon el saldo con el que empieza la caja.');
  }
  const desde = datos.diaDeColumna(inicio.fecha);
  if (dia < desde) {
    throw new ValidationError(
      `La caja empieza el ${desde}. Para apuntar antes, cambia primero la fecha del saldo inicial.`,
    );
  }
}

const cajaService = {
  /** La caja de un mes (por defecto, el actual), día por día. */
  async mes({ anio, mes } = {}, ahora = new Date()) {
    const hoy = datos.diaDeLima(ahora);
    const actual = { anio: Number(hoy.slice(0, 4)), mes: Number(hoy.slice(5, 7)) };
    const periodo = anio && mes ? { anio, mes } : actual;

    const inicio = formatoInicio(await cajaRepository.saldoInicial());
    if (!inicio) return datos.armarCaja({ inicio: null, movimientos: [], ...periodo, hoy });

    const { ultimo } = datos.diasDelMes(periodo.anio, periodo.mes);
    let movimientos = [];
    if (ultimo >= inicio.dia) {
      const desde = datos.inicioDelDia(inicio.dia);
      const hasta = datos.inicioDelDia(datos.diaSiguiente(ultimo));
      const [ventas, servicios, manuales] = await Promise.all([
        ventasService.ventasEntre(desde, hasta),
        sunatRepository.serviciosCobrados(desde, hasta),
        cajaRepository.movimientosEntre(inicio.dia, ultimo),
      ]);
      movimientos = [
        ...ventas.map(datos.entradaDeVenta),
        ...servicios.map(datos.entradaDeServicio),
        ...manuales.map(datos.movimientoManual),
      ];
    }

    return datos.armarCaja({ inicio, movimientos, ...periodo, hoy });
  },

  /** Fija (o corrige) el día y el saldo con que empieza la caja. */
  async fijarInicio(entrada, adminId, ahora = new Date()) {
    comprobarDia(entrada.fecha, datos.diaDeLima(ahora));
    const antes = await cajaRepository.contarAntesDe(entrada.fecha);
    if (antes > 0) {
      throw new ValidationError(
        `Hay ${antes} movimiento(s) apuntados antes de esa fecha. Bórralos o elige un día anterior.`,
      );
    }

    const data = {
      ...datosDeMovimiento({ ...entrada, tipo: 'SALDO_INICIAL', concepto: 'Saldo inicial' }),
      fecha: cajaRepository.comoFecha(entrada.fecha),
    };
    const actual = await cajaRepository.saldoInicial();
    const fila = actual
      ? await cajaRepository.actualizar(actual.id, data)
      : await cajaRepository.crear({ ...data, creadoPorId: adminId });
    return formatoInicio(fila);
  },

  async crear(entrada, adminId, ahora = new Date()) {
    comprobarDia(entrada.fecha, datos.diaDeLima(ahora));
    await exigirInicio(entrada.fecha);
    const fila = await cajaRepository.crear({
      ...datosDeMovimiento(entrada),
      fecha: cajaRepository.comoFecha(entrada.fecha),
      creadoPorId: adminId,
    });
    return datos.movimientoManual(fila);
  },

  async actualizar(id, entrada, ahora = new Date()) {
    const actual = await cajaRepository.buscar(id);
    if (!actual || actual.tipo === 'SALDO_INICIAL') throw new NotFoundError('Ese movimiento no existe.');
    comprobarDia(entrada.fecha, datos.diaDeLima(ahora));
    await exigirInicio(entrada.fecha);
    const fila = await cajaRepository.actualizar(id, {
      ...datosDeMovimiento(entrada),
      fecha: cajaRepository.comoFecha(entrada.fecha),
    });
    return datos.movimientoManual(fila);
  },

  async borrar(id) {
    const actual = await cajaRepository.buscar(id);
    if (!actual || actual.tipo === 'SALDO_INICIAL') throw new NotFoundError('Ese movimiento no existe.');
    await cajaRepository.borrar(id);
    return { id };
  },
};

module.exports = cajaService;
