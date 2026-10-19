'use strict';

/**
 * El cálculo del Formulario 621 de un mes (RER: IGV 18 % + renta 1.5 %), sin
 * base de datos de por medio.
 *
 *  - Ventas gravadas: las boletas aceptadas del mes menos las notas de crédito
 *    del mes (una boleta anulada y su nota del mismo mes se cancelan), más el
 *    ajuste manual de ventas que no pasaron por boletas.
 *  - Compras gravadas: las facturas de compra del mes (crédito fiscal).
 *  - IGV = IGV de ventas − IGV de compras − saldo a favor del mes anterior. Si
 *    sale negativo no se paga y la diferencia pasa como saldo a favor.
 *  - Renta = 1.5 % de las ventas sin IGV.
 *
 * Los importes van en céntimos; el 621 se llena en soles enteros (`soles`). Los
 * números de casilla son los que se usan normalmente: los confirma el contador.
 */

const TASA_IGV = 0.18;
const TASA_RENTA_RER = 0.015;

/** Primer mes con IGV: la Ficha RUC lo da desde el 17-oct-2026. */
const MES_INICIAL = { anio: 2026, mes: 10 };

/** Soles enteros, como pide el formulario. */
function soles(cents) {
  return Math.round(cents / 100);
}

/**
 * @param {object} p
 * @param {{ tipo: string, valorCents: number, igvCents: number }[]} p.comprobantes  aceptados del mes
 * @param {{ baseCents: number, igvCents: number }[]} p.compras
 * @param {number} [p.ajusteBaseCents]
 * @param {number} [p.saldoAnteriorCents]
 */
function calcularMes({ comprobantes, compras, ajusteBaseCents = 0, saldoAnteriorCents = 0 }) {
  let boletas = 0;
  let notas = 0;
  let baseBoletas = 0;
  let igvBoletas = 0;
  for (const c of comprobantes) {
    const signo = c.tipo === '07' ? -1 : 1;
    if (signo < 0) notas += 1;
    else boletas += 1;
    baseBoletas += signo * c.valorCents;
    igvBoletas += signo * c.igvCents;
  }
  const ajusteIgvCents = Math.round(ajusteBaseCents * TASA_IGV);
  const ventasBaseCents = baseBoletas + ajusteBaseCents;
  const ventasIgvCents = igvBoletas + ajusteIgvCents;

  const comprasBaseCents = compras.reduce((s, c) => s + c.baseCents, 0);
  const comprasIgvCents = compras.reduce((s, c) => s + c.igvCents, 0);

  const igvResultanteCents = ventasIgvCents - comprasIgvCents - saldoAnteriorCents;
  const igvAPagarCents = Math.max(0, igvResultanteCents);
  const saldoSiguienteCents = Math.max(0, -igvResultanteCents);
  const rentaCents = Math.max(0, Math.round(ventasBaseCents * TASA_RENTA_RER));

  return {
    ventas: { boletas, notas, baseCents: ventasBaseCents, igvCents: ventasIgvCents, ajusteBaseCents, ajusteIgvCents },
    compras: { cantidad: compras.length, baseCents: comprasBaseCents, igvCents: comprasIgvCents },
    saldoAnteriorCents,
    igvAPagarCents,
    saldoSiguienteCents,
    rentaCents,
    totalAPagarCents: igvAPagarCents + rentaCents,
    casillas: [
      { casilla: '100', texto: 'Ventas gravadas: base imponible', soles: soles(ventasBaseCents) },
      { casilla: '101', texto: 'Ventas gravadas: IGV', soles: soles(ventasIgvCents) },
      { casilla: '107', texto: 'Compras gravadas: base imponible', soles: soles(comprasBaseCents) },
      { casilla: '108', texto: 'Compras gravadas: IGV (crédito fiscal)', soles: soles(comprasIgvCents) },
      { casilla: null, texto: 'Saldo a favor del mes anterior', soles: soles(saldoAnteriorCents) },
      { casilla: null, texto: 'IGV a pagar', soles: soles(igvAPagarCents) },
      { casilla: '301', texto: 'Renta: ingresos netos del mes', soles: soles(ventasBaseCents) },
      { casilla: null, texto: 'Renta a pagar (1.5 %)', soles: soles(rentaCents) },
    ],
  };
}

/** `a` va antes que `b`. */
function antes(a, b) {
  return a.anio < b.anio || (a.anio === b.anio && a.mes < b.mes);
}

function siguiente({ anio, mes }) {
  return mes === 12 ? { anio: anio + 1, mes: 1 } : { anio, mes: mes + 1 };
}

function anterior({ anio, mes }) {
  return mes === 1 ? { anio: anio - 1, mes: 12 } : { anio, mes: mes - 1 };
}

/** Los meses desde el inicial hasta `hasta` (incluido). */
function mesesHasta(hasta) {
  const meses = [];
  for (let m = MES_INICIAL; !antes(hasta, m); m = siguiente(m)) meses.push(m);
  return meses;
}

/** `aaaa-mm-dd` de hoy en Lima (UTC−5 todo el año). */
function hoyEnLima(ahora = new Date()) {
  return new Date(ahora.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Días que faltan para una fecha (`Date` de una columna DATE). Negativo si ya pasó. */
function diasHasta(vencimiento, ahora = new Date()) {
  const hoy = Date.parse(`${hoyEnLima(ahora)}T00:00:00Z`);
  const venc = Date.parse(`${new Date(vencimiento).toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((venc - hoy) / (24 * 3600 * 1000));
}

module.exports = {
  calcularMes,
  soles,
  MES_INICIAL,
  TASA_RENTA_RER,
  antes,
  siguiente,
  anterior,
  mesesHasta,
  hoyEnLima,
  diasHasta,
};
