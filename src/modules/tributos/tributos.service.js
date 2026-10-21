'use strict';

/**
 * La declaración mensual del 621 (RER), casi automática (20-oct-2026).
 *
 * SUNAT no tiene API para presentar ni pagar el 621: eso sigue siendo del
 * administrador en «Declara Fácil». Lo que hace esto es todo lo demás:
 *  - calcula cada mes desde las boletas y las compras cargadas;
 *  - encadena el saldo a favor de IGV de un mes al siguiente;
 *  - avisa antes del vencimiento con las cifras de cada casilla;
 *  - guarda lo declarado (y lo congela) cuando se marca «Ya declaré».
 *
 * Avisos al ADMINISTRADOR (es tema de administración), por ntfy y por correo.
 */

const env = require('../../config/env');
const logger = require('../../config/logger');
const { sendMail } = require('../../lib/mailer');
const { avisarAlAdmin, avisarAlProgramador } = require('../../lib/notify');
const { mesDeLima } = require('../ventas/ventas.datos');
const { AppError, NotFoundError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');
const repo = require('./tributos.repository');
const calc = require('./tributos.calculo');
const correos = require('./tributos.correo');
const cronograma = require('./tributos.cronograma');
const crypto = require('node:crypto');

/** Días antes del vencimiento en que llega el primer aviso. */
const DIAS_AVISO_PREVIO = 5;

const NOMBRES_DE_MES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function nombreDelMes({ anio, mes }) {
  return `${NOMBRES_DE_MES[mes - 1]} ${anio}`;
}

/** `Date` de una columna DATE → `aaaa-mm-dd`. */
/**
 * El `numero` con que se guarda una compra del extranjero: sale de su
 * proveedor y su número de factura, así la misma no entra dos veces (la tabla
 * no deja repetir RUC + serie + número).
 */
function numeroDeExtranjera(proveedor, documento) {
  const clave = `${String(proveedor).trim()}|${String(documento).trim()}`.toUpperCase();
  return crypto.createHash('sha256').update(clave).digest().readUInt32BE(0) % 99_999_999 || 1;
}

/**
 * El vencimiento que vale para un mes: el escrito a mano en el panel y, si no
 * hay, el del cronograma de SUNAT para el RUC.
 */
function vencimientoDe(periodo, fila) {
  if (fila?.vencimiento) return { fecha: fila.vencimiento, origen: 'manual' };
  const delCronograma = cronograma.vencimientoDelCronograma(periodo, env.SUNAT_RUC);
  return delCronograma ? { fecha: delCronograma, origen: 'cronograma' } : { fecha: null, origen: null };
}

/** Un mes declarado no admite cambios que lo muevan. */
async function exigirPendiente(periodo) {
  const fila = await repo.declaracion(periodo);
  if (fila && fila.estado !== 'PENDIENTE') {
    throw new AppError(`${nombreDelMes(periodo)} ya está declarado. Reábrelo para cambiarlo.`, {
      statusCode: 409,
      code: ERROR_CODES.VALIDATION_ERROR,
    });
  }
}

function diaIso(fecha) {
  return fecha ? new Date(fecha).toISOString().slice(0, 10) : null;
}

/**
 * Calcula todos los meses desde el inicial hasta `hasta`, en orden, porque el
 * saldo a favor de uno es el punto de partida del siguiente. Un mes ya
 * declarado usa su cálculo congelado.
 */
async function calcularHasta(hasta) {
  const filas = new Map((await repo.declaraciones()).map((d) => [`${d.anio}-${d.mes}`, d]));
  const resultado = [];
  let saldoAnterior = 0;
  for (const periodo of calc.mesesHasta(hasta)) {
    const fila = filas.get(`${periodo.anio}-${periodo.mes}`) ?? null;
    let calculo;
    if (fila?.calculo && fila.estado !== 'PENDIENTE') {
      calculo = fila.calculo;
    } else {
      const [comprobantes, compras] = await Promise.all([
        repo.comprobantesDelMes(periodo),
        repo.comprasDelMes(periodo),
      ]);
      calculo = calc.calcularMes({
        comprobantes,
        compras,
        ajusteBaseCents: fila?.ajusteBaseCents ?? 0,
        saldoAnteriorCents: fila?.saldoFavorInicialCents ?? saldoAnterior,
      });
    }
    saldoAnterior = calculo.saldoSiguienteCents;
    resultado.push({ periodo, fila, calculo });
  }
  return resultado;
}

/** Lo que ve el panel de un mes. */
function vista({ periodo, fila, calculo }, ahora = new Date()) {
  const actual = mesDeLima(ahora);
  const vence = vencimientoDe(periodo, fila);
  return {
    anio: periodo.anio,
    mes: periodo.mes,
    nombre: nombreDelMes(periodo),
    enCurso: periodo.anio === actual.anio && periodo.mes === actual.mes,
    estado: fila?.estado ?? 'PENDIENTE',
    vencimiento: diaIso(vence.fecha),
    /** `manual` (escrito en el panel), `cronograma` (el de SUNAT) o null. */
    vencimientoOrigen: vence.origen,
    vencimientoCronograma: diaIso(cronograma.vencimientoDelCronograma(periodo, env.SUNAT_RUC)),
    diasParaVencer: vence.fecha ? calc.diasHasta(vence.fecha, ahora) : null,
    ajusteBaseCents: fila?.ajusteBaseCents ?? 0,
    ajusteNota: fila?.ajusteNota ?? null,
    saldoFavorInicialCents: fila?.saldoFavorInicialCents ?? null,
    numeroOrden: fila?.numeroOrden ?? null,
    igvPagadoCents: fila?.igvPagadoCents ?? null,
    rentaPagadaCents: fila?.rentaPagadaCents ?? null,
    declaradaEn: fila?.declaradaEn ?? null,
    calculo,
  };
}

function validarPeriodo({ anio, mes }, ahora = new Date()) {
  const periodo = { anio, mes };
  if (calc.antes(periodo, calc.MES_INICIAL) || calc.antes(mesDeLima(ahora), periodo)) {
    throw new NotFoundError('Ese mes no tiene declaración.');
  }
  return periodo;
}

function datosDeFactura(datos) {
  return {
    tipo: 'FACTURA',
    fecha: new Date(`${datos.fecha}T00:00:00Z`),
    rucProveedor: datos.rucProveedor,
    razonSocial: datos.razonSocial || null,
    serie: datos.serie.toUpperCase(),
    numero: datos.numero,
    baseCents: datos.baseCents,
    igvCents: datos.igvCents,
  };
}

/**
 * Una compra del extranjero: lo cobrado pasa a soles con el tipo de cambio que
 * se escribe (el de venta de SUNAT del día del pago) y el IGV es el 18 % de esa
 * base. Si ya se pagó con el 1662, se registra a la vez.
 */
async function datosDeExtranjera(datos) {
  const base =
    datos.monedaOriginal === 'USD' ? Math.round(datos.importeOriginalCents * datos.tipoCambio) : datos.importeOriginalCents;
  const pagado = datos.igvPagadoEn ? new Date(`${datos.igvPagadoEn}T00:00:00Z`) : null;
  if (pagado) await exigirPendiente({ anio: pagado.getUTCFullYear(), mes: pagado.getUTCMonth() + 1 });
  return {
    tipo: 'EXTRANJERO',
    fecha: new Date(`${datos.fecha}T00:00:00Z`),
    rucProveedor: '-',
    razonSocial: datos.razonSocial,
    serie: 'EXT',
    numero: numeroDeExtranjera(datos.razonSocial, datos.documento),
    documento: datos.documento,
    monedaOriginal: datos.monedaOriginal,
    importeOriginalCents: datos.importeOriginalCents,
    tipoCambio: datos.monedaOriginal === 'USD' ? datos.tipoCambio : null,
    baseCents: base,
    igvCents: datos.igvCents ?? Math.round(base * 0.18),
    ordenPago: datos.ordenPago || null,
    igvPagadoEn: pagado,
  };
}

const tributosService = {
  /** Todos los meses, del más reciente al más antiguo. */
  async meses(ahora = new Date()) {
    const todos = await calcularHasta(mesDeLima(ahora));
    return todos.map((m) => vista(m, ahora)).reverse();
  },

  /** Un mes con su detalle: el cálculo y las compras cargadas. */
  async detalle({ anio, mes }, ahora = new Date()) {
    const periodo = validarPeriodo({ anio, mes }, ahora);
    const todos = await calcularHasta(periodo);
    const [compras, porPagar1662] = await Promise.all([repo.comprasDelMes(periodo), repo.extranjerasPorPagar()]);
    return { ...vista(todos.at(-1), ahora), compras, porPagar1662 };
  },

  /** Fecha de vencimiento, ajuste de ventas y saldo inicial. Solo en un mes pendiente. */
  async actualizar({ anio, mes }, datos, ahora = new Date()) {
    const periodo = validarPeriodo({ anio, mes }, ahora);
    const fila = await repo.declaracion(periodo);
    if (fila && fila.estado !== 'PENDIENTE') {
      throw new AppError('Ese mes ya está declarado. Reábrelo para cambiarlo.', {
        statusCode: 409,
        code: ERROR_CODES.VALIDATION_ERROR,
      });
    }
    const data = {};
    if (datos.vencimiento !== undefined) {
      data.vencimiento = datos.vencimiento ? new Date(`${datos.vencimiento}T00:00:00Z`) : null;
      // Una fecha nueva vuelve a armar los avisos.
      data.avisoPrevioEn = null;
      data.avisoUltimoEn = null;
    }
    if (datos.ajusteBaseCents !== undefined) data.ajusteBaseCents = datos.ajusteBaseCents;
    if (datos.ajusteNota !== undefined) data.ajusteNota = datos.ajusteNota || null;
    if (datos.saldoFavorInicialCents !== undefined) data.saldoFavorInicialCents = datos.saldoFavorInicialCents;
    await repo.guardar(periodo, data);
    return this.detalle(periodo, ahora);
  },

  /** «Ya declaré»: congela el cálculo y anota la orden y lo pagado. */
  async declarar({ anio, mes }, { numeroOrden, igvPagadoCents, rentaPagadaCents }, ahora = new Date()) {
    const periodo = validarPeriodo({ anio, mes }, ahora);
    const todos = await calcularHasta(periodo);
    const { calculo } = todos.at(-1);
    const pagado = igvPagadoCents != null && rentaPagadaCents != null;
    await repo.guardar(periodo, {
      estado: pagado ? 'PAGADA' : 'DECLARADA',
      numeroOrden: numeroOrden || null,
      igvPagadoCents: igvPagadoCents ?? null,
      rentaPagadaCents: rentaPagadaCents ?? null,
      declaradaEn: new Date(),
      calculo,
    });
    return this.detalle(periodo, ahora);
  },

  /** Deshace «Ya declaré» (por ejemplo, para presentar una rectificatoria). */
  async reabrir({ anio, mes }, ahora = new Date()) {
    const periodo = validarPeriodo({ anio, mes }, ahora);
    await repo.guardar(periodo, {
      estado: 'PENDIENTE',
      calculo: null,
      declaradaEn: null,
    });
    return this.detalle(periodo, ahora);
  },

  async agregarCompra(datos, creadoPorId) {
    const data = datos.tipo === 'EXTRANJERO' ? await datosDeExtranjera(datos) : datosDeFactura(datos);
    try {
      return await repo.crearCompra({ ...data, descripcion: datos.descripcion || null, creadoPorId });
    } catch (error) {
      if (error?.code === 'P2002') {
        throw new AppError('Esa factura ya está registrada.', { statusCode: 409, code: ERROR_CODES.VALIDATION_ERROR });
      }
      throw error;
    }
  },

  /**
   * «Ya pagué el IGV con el 1662» de una compra del extranjero: desde ese día
   * cuenta como crédito en el mes del pago, que no puede estar declarado.
   */
  async pagarIgvDeExtranjera(id, { ordenPago, fecha, igvCents }) {
    const compra = await repo.buscarCompra(id);
    if (!compra || compra.tipo !== 'EXTRANJERO') throw new NotFoundError('Esa compra del extranjero no existe.');
    const dia = new Date(`${fecha}T00:00:00Z`);
    await exigirPendiente({ anio: dia.getUTCFullYear(), mes: dia.getUTCMonth() + 1 });
    return repo.actualizarCompra(id, {
      ordenPago: ordenPago || null,
      igvPagadoEn: dia,
      ...(igvCents != null ? { igvCents } : {}),
    });
  },

  async borrarCompra(id) {
    const { count } = await repo.borrarCompra(id);
    if (count === 0) throw new NotFoundError('Esa compra no existe.');
  },

  /**
   * Los avisos de la declaración. Se mira cada hora (`server.js`). Para cada
   * mes ya terminado que siga pendiente:
   *  - sin fecha de vencimiento: un aviso para que la pongan;
   *  - a 5 días o menos: el primer aviso con las cifras;
   *  - a 1 día o menos (o vencido): el último.
   * Cada uno sale una vez; cambiar la fecha los vuelve a armar. La fecha es la
   * escrita en el panel o, si no hay, la del cronograma de SUNAT.
   *
   * Además, en diciembre: si el cronograma no tiene el año siguiente, un aviso
   * al programador para cargarlo (una vez; se marca en enero del año siguiente).
   */
  async pasadaDeAvisos(ahora = new Date()) {
    const actual = mesDeLima(ahora);
    let enviados = 0;
    if (actual.mes === 12 && cronograma.tieneElAnio(actual.anio, env.SUNAT_RUC) && !cronograma.tieneElAnio(actual.anio + 1, env.SUNAT_RUC)) {
      const enero = { anio: actual.anio + 1, mes: 1 };
      const fila = await repo.declaracion(enero);
      if (!fila?.avisoSinFechaEn) {
        avisarAlProgramador({
          titulo: `Falta el cronograma SUNAT ${enero.anio}`,
          mensaje:
            `Carga en backend/src/modules/tributos/tributos.cronograma.js los vencimientos de ${enero.anio} ` +
            'del dígito 0 (página «Cronograma de obligaciones mensuales» de SUNAT). Sin eso, los meses de ' +
            `${enero.anio} salen sin fecha y sin avisos.`,
          etiquetas: ['calendar'],
        });
        await repo.guardar(enero, { avisoSinFechaEn: new Date() });
        enviados += 1;
      }
    }

    const hasta = calc.anterior(actual);
    if (calc.antes(hasta, calc.MES_INICIAL)) return enviados;

    const todos = await calcularHasta(hasta);
    for (const m of todos) {
      const estado = m.fila?.estado ?? 'PENDIENTE';
      if (estado !== 'PENDIENTE') continue;
      const nombre = nombreDelMes(m.periodo);
      const fila = m.fila;
      let tipo = null;
      let marca = null;
      const vence = vencimientoDe(m.periodo, fila).fecha;
      if (!vence) {
        if (!fila?.avisoSinFechaEn) [tipo, marca] = ['sinFecha', 'avisoSinFechaEn'];
      } else {
        const dias = calc.diasHasta(vence, ahora);
        if (dias <= 1 && !fila?.avisoUltimoEn) [tipo, marca] = ['ultimo', 'avisoUltimoEn'];
        else if (dias <= DIAS_AVISO_PREVIO && !fila?.avisoPrevioEn) [tipo, marca] = ['previo', 'avisoPrevioEn'];
      }
      if (!tipo) continue;

      const datos = { nombre, vencimiento: diaIso(vence), calculo: m.calculo, tipo };
      avisarAlAdmin(correos.avisoMovil(datos));
      try {
        const para = env.ADMIN_NOTIFY_EMAIL ?? (await repo.correoDelAdministrador());
        if (para) await sendMail({ to: para, ...correos.avisoCorreo(datos) });
      } catch (error) {
        logger.error({ err: error, periodo: m.periodo }, 'No se pudo mandar el correo de la declaración');
      }
      await repo.guardar(m.periodo, { [marca]: new Date() });
      enviados += 1;
    }
    return enviados;
  },
};

module.exports = Object.assign(tributosService, { numeroDeExtranjera });
