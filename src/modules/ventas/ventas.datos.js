'use strict';

/**
 * Las ventas de un mes, sin base de datos de por medio.
 *
 * Aquí vive la regla de QUÉ es una venta, y es la misma que usan los gráficos
 * de ingresos del panel (`acostaresearch-frontend/src/app/features/admin/admin.ts`,
 * `entradasDeDinero`). Si cambia allí, cambia aquí: el PDF del mes y el
 * gráfico no pueden dar cifras distintas.
 *
 *  - Un pago cobrado (PAID, importe > 0), con la fecha en que se cobró.
 *  - Un código de activación vendido a mano (no anulado, con medio de cobro que
 *    no sea cortesía e importe > 0), con la fecha en que se generó: es cuando
 *    entró el dinero, no cuando el cliente lo canjeó.
 *  - El pago que nace al canjear un código NO cuenta: esa venta ya está en su
 *    código. Se reconoce porque lleva el id del código como número de orden.
 *
 * Los meses son de Lima (UTC−5 todo el año: Perú no cambia de hora).
 */

/** Perú: UTC−5 sin horario de verano. */
const DESFASE_LIMA_HORAS = 5;

/**
 * Tipo de cambio de REFERENCIA para sumar dólares y soles en una cifra. Es el
 * mismo con el que se ponen los precios en la web (`SOLES_POR_DOLAR` del
 * panel). No es el tipo oficial del día: para declarar a SUNAT habrá que usar
 * el de la SBS de la fecha de cada cobro. Por eso cada venta guarda también su
 * moneda y su importe originales.
 */
const SOLES_POR_DOLAR = 3.75;

const MEDIOS = {
  PAYPAL: 'PayPal',
  CULQI: 'Tarjeta o Yape (Culqi)',
  YAPE: 'Yape',
  PLIN: 'Plin',
  TRANSFERENCIA: 'Transferencia bancaria',
  WESTERN_UNION: 'Western Union',
};

const NOMBRES_DE_MES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** Primer instante del mes en Lima, como fecha UTC. `mes` va de 1 a 12. */
function inicioDelMes(anio, mes) {
  return new Date(Date.UTC(anio, mes - 1, 1, DESFASE_LIMA_HORAS));
}

/** El mes siguiente. */
function siguiente({ anio, mes }) {
  return mes === 12 ? { anio: anio + 1, mes: 1 } : { anio, mes: mes + 1 };
}

/** El mes de Lima al que pertenece una fecha. */
function mesDeLima(fecha) {
  const enLima = new Date(new Date(fecha).getTime() - DESFASE_LIMA_HORAS * 3600 * 1000);
  return { anio: enLima.getUTCFullYear(), mes: enLima.getUTCMonth() + 1 };
}

/** `a` es anterior a `b`. */
function antes(a, b) {
  return a.anio < b.anio || (a.anio === b.anio && a.mes < b.mes);
}

/** Meses ya terminados desde `desde` (incluido) hasta el mes de `ahora` (excluido). */
function mesesTerminados(desde, ahora = new Date()) {
  const actual = mesDeLima(ahora);
  const meses = [];
  for (let m = desde; antes(m, actual); m = siguiente(m)) meses.push(m);
  return meses;
}

function nombreDelMes({ anio, mes }) {
  return `${NOMBRES_DE_MES[mes - 1]} ${anio}`;
}

function aSoles(cents, moneda) {
  return moneda === 'USD' ? Math.round(cents * SOLES_POR_DOLAR) : cents;
}

function nombreDe(user) {
  const nombre = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
  return nombre || null;
}

/** Un pago cobrado por la web, como venta. */
function ventaDePago(pago) {
  return {
    fecha: new Date(pago.paidAt).toISOString(),
    origen: 'PAGO',
    origenId: pago.id,
    via: MEDIOS[pago.provider] ?? pago.provider,
    producto: pago.plan?.name ?? '—',
    cliente: nombreDe(pago.user),
    correo: pago.user?.email ?? pago.payerEmail ?? null,
    referencia: pago.operationCode ?? pago.providerCaptureId ?? pago.providerOrderId ?? null,
    moneda: pago.currency,
    importeCents: pago.amountCents,
    descuentoCents: pago.discountCents ?? 0,
    solesCents: aSoles(pago.amountCents, pago.currency),
  };
}

/** Un código de activación vendido a mano, como venta. Siempre en soles. */
function ventaDeCodigo(codigo, nombresDeProducto = {}) {
  return {
    fecha: new Date(codigo.createdAt).toISOString(),
    origen: 'CODIGO',
    origenId: codigo.id,
    via: `${MEDIOS[codigo.paymentMethod] ?? codigo.paymentMethod} (código)`,
    producto: nombresDeProducto[codigo.productCode] ?? codigo.productCode,
    cliente: null,
    correo: codigo.buyerEmail ?? null,
    referencia: codigo.paymentRef ?? `…${codigo.hint}`,
    moneda: 'PEN',
    importeCents: codigo.amountCents,
    descuentoCents: 0,
    solesCents: codigo.amountCents,
  };
}

/**
 * Junta pagos y códigos del mes en una lista ordenada por fecha.
 * `idsDeCodigos` son los códigos cuyo canje creó alguno de esos pagos.
 */
function ventasDelMes({ pagos, codigos, idsDeCodigos = new Set(), nombresDeProducto = {} }) {
  return [
    ...pagos.filter((p) => !idsDeCodigos.has(p.providerOrderId)).map(ventaDePago),
    ...codigos.map((c) => ventaDeCodigo(c, nombresDeProducto)),
  ].sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
}

/** Totales del mes: por moneda sin convertir, por vía y en soles. */
function resumir(ventas) {
  const totalesPorMoneda = {};
  const porVia = {};
  let totalSolesCents = 0;

  for (const venta of ventas) {
    totalesPorMoneda[venta.moneda] = (totalesPorMoneda[venta.moneda] ?? 0) + venta.importeCents;
    porVia[venta.via] = (porVia[venta.via] ?? 0) + venta.solesCents;
    totalSolesCents += venta.solesCents;
  }

  return { ventas: ventas.length, totalSolesCents, totalesPorMoneda, porVia };
}

module.exports = {
  SOLES_POR_DOLAR,
  inicioDelMes,
  siguiente,
  mesDeLima,
  mesesTerminados,
  nombreDelMes,
  ventaDePago,
  ventaDeCodigo,
  ventasDelMes,
  resumir,
};
