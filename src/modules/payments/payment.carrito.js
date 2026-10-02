'use strict';

const { ERROR_CODES } = require('../../config/constants');
const billingRepository = require('../billing/billing.repository');
const { enPrueba } = require('../billing/plan.visibilidad');
const discountService = require('../billing/discount.service');
const { AppError, NotFoundError } = require('../../shared/errors/AppError');

/**
 * Compra con carrito: varios productos pagados de una vez.
 *
 * CÓMO SE GUARDA
 * --------------
 * Cada producto sigue siendo su propia fila de `payments`, con su plan, su
 * importe, su descuento y su constancia. Lo único que las une es `cartId`. Así
 * todo lo que ya leía pagos —«Mis compras», la constancia en PDF, las ventas
 * del mes, la entrega— sigue funcionando sin saber que existe el carrito.
 *
 * Lo que se cobra de una vez es la suma: una sola orden de PayPal, un solo
 * cargo de Culqi o un solo Yape con una sola captura.
 *
 * El precio de cada línea lo pone el servidor, igual que en la compra suelta:
 * el navegador manda códigos de plan y de descuento, nunca importes.
 *
 * DOS CLASES DE CÓDIGO
 * --------------------
 * - El de un producto (los anunciados en su tarjeta) va en su línea y rebaja
 *   solo esa línea.
 * - El del carrito (`discountCode` junto a `items`) rebaja el TOTAL una sola
 *   vez: «S/ 50» en un carrito de tres productos son S/ 50, no S/ 150. Para
 *   que cada fila siga cuadrando con lo cobrado, la rebaja se reparte entre
 *   las filas en proporción a lo que paga cada una. El código queda enlazado a
 *   UNA sola fila, que es la que gasta su uso al entregarse.
 */

const { MAX_PRODUCTOS } = require('./payment.schema');

/** El nombre del carrito para la pasarela y los avisos: «A + B». */
function nombreDelCarrito(planes) {
  return planes.map((plan) => plan.name).join(' + ');
}

/** Un plan con el mismo aspecto que lee la pasarela, para el carrito entero. */
function planDelCarrito(planes) {
  return { code: 'CARRITO', name: nombreDelCarrito(planes), words: 0 };
}

function noComprable(mensaje) {
  return new AppError(mensaje, { statusCode: 409, code: ERROR_CODES.PLAN_NOT_PURCHASABLE });
}

/**
 * Comprueba las líneas y pone precio a cada una.
 *
 * `precio(plan)` da el importe en la moneda del cobro (o null si ese plan no
 * se cobra ahí) y `rebaja(descuento)` lo que le quita el código en esa misma
 * moneda. Así sirve igual para PayPal (dólares) que para Culqi y Yape (soles).
 * `discountCode` es el código del carrito entero, si lo hay.
 *
 * Se rechaza el carrito entero si una línea falla: cobrar una parte de lo que
 * eligió no es lo que pidió.
 */
async function resolverLineas(items, { precio, rebaja, medio, discountCode }) {
  if (!Array.isArray(items) || items.length < 2) {
    throw noComprable('Un carrito necesita al menos dos productos.');
  }
  if (items.length > MAX_PRODUCTOS) {
    throw noComprable(`En el carrito caben hasta ${MAX_PRODUCTOS} productos.`);
  }

  const lineas = [];
  const productos = new Set();

  for (const item of items) {
    const plan = await billingRepository.findPlanByCode(item.planCode);
    // Igual que en la compra suelta: uno en prueba no se vende aunque esté activo.
    if (!plan || !plan.active || enPrueba(plan)) {
      throw new NotFoundError(`No existe un plan activo con el código ${item.planCode}.`);
    }

    // El mismo producto dos veces no suma nada: la segunda licencia sería una
    // renovación de la primera pagada en el mismo instante. Si quiere más
    // tiempo, lo renueva cuando le toque.
    const producto = plan.kind === 'DOCUMENTO' ? 'DOCUMENTO' : (plan.productCode ?? plan.code);
    if (productos.has(producto)) {
      throw noComprable(`«${plan.name}» ya está en el carrito.`);
    }
    productos.add(producto);

    const base = precio(plan);
    if (!base || base <= 0) {
      throw noComprable(`El plan ${plan.name} no se puede pagar con ${medio}.`);
    }

    const descuento = await discountService.resolve({ code: item.discountCode, plan });
    const menos = descuento ? rebaja(descuento) : 0;

    lineas.push({ plan, base, descuento, rebaja: menos, amountCents: base - menos, parteDelTotal: 0 });
  }

  const delCarrito = await codigoDelCarrito(discountCode, lineas);
  if (!delCarrito) return { lineas, delTotal: null };

  if (delCarrito.linea) {
    // Un código de un solo producto escrito en el campo del carrito: rebaja esa
    // línea y nada más, igual que si hubiera venido en ella.
    const linea = delCarrito.linea;
    linea.descuento = delCarrito.descuento;
    linea.rebaja = rebaja(delCarrito.descuento);
    linea.amountCents = linea.base - linea.rebaja;
    return { lineas, delTotal: null };
  }

  const portadora = lineas.find((linea) => !linea.descuento);
  if (!portadora) {
    throw new AppError('Cada producto ya lleva su código: no se puede sumar otro al total.', {
      statusCode: 400,
      code: ERROR_CODES.DISCOUNT_INVALID,
    });
  }

  const total = rebaja(delCarrito.descuento);
  repartir(lineas, total);
  portadora.portaCodigoDelTotal = true;

  return { lineas, delTotal: { descuento: delCarrito.descuento, rebaja: total } };
}

/**
 * El código del carrito, resuelto. Si es de un producto, dice de qué línea;
 * si es general, calcula la rebaja sobre la suma de lo que ya se iba a pagar.
 */
async function codigoDelCarrito(code, lineas) {
  if (!code) return null;

  const registro = await discountService.encontrar(code);

  if (registro.planCode) {
    const linea = lineas.find((l) => l.plan.code === registro.planCode);
    if (!linea) {
      throw new AppError('Ese código no vale para ningún producto del carrito.', {
        statusCode: 400,
        code: ERROR_CODES.DISCOUNT_INVALID,
      });
    }
    return { linea, descuento: await discountService.resolve({ code, plan: linea.plan }) };
  }

  const priceCents = lineas.reduce(
    (suma, l) => suma + l.plan.priceCents - (l.descuento?.amountCents ?? 0),
    0,
  );
  const priceUsdCents = lineas.every((l) => l.plan.priceUsdCents)
    ? lineas.reduce(
        (suma, l) => suma + l.plan.priceUsdCents - (l.descuento?.discountUsdCents ?? 0),
        0,
      )
    : null;

  return { descuento: discountService.aplicarAlTotal(registro, { priceCents, priceUsdCents }) };
}

/**
 * Reparte la rebaja del total entre las líneas, en proporción a lo que paga
 * cada una. Lo que sobra del redondeo va a la más cara, para que la suma de
 * las filas sea exactamente lo que se cobra.
 */
function repartir(lineas, total) {
  const suma = lineas.reduce((s, l) => s + l.amountCents, 0);
  let repartido = 0;

  for (const linea of lineas) {
    linea.parteDelTotal = Math.floor((total * linea.amountCents) / suma);
    repartido += linea.parteDelTotal;
  }

  const mayor = lineas.reduce((a, b) => (b.amountCents > a.amountCents ? b : a));
  mayor.parteDelTotal += total - repartido;

  for (const linea of lineas) {
    linea.rebaja += linea.parteDelTotal;
    linea.amountCents -= linea.parteDelTotal;
  }
}

/** Con qué código se guarda cada fila: el suyo, o el del total en la portadora. */
function codigoDeLaFila(linea, delTotal) {
  if (linea.descuento) return linea.descuento.id;
  return linea.portaCodigoDelTotal && delTotal ? delTotal.descuento.id : null;
}

/** El descuento del total tal como se le devuelve al navegador. */
function resumenDelTotal(delTotal) {
  return delTotal ? { code: delTotal.descuento.code, amountCents: delTotal.rebaja } : null;
}

/**
 * Comprueba el código del carrito antes de pagar, para enseñarlo en la ventana.
 *
 * Calcula en soles, que es lo que se anuncia; la cifra que se cobra la vuelve
 * a sacar `resolverLineas` al abrir la orden. Dice si rebaja el total o un
 * solo producto, porque la ventana los enseña en sitios distintos.
 */
async function validarCodigoDelCarrito(items, code) {
  const { lineas, delTotal } = await resolverLineas(items, {
    precio: (plan) => plan.priceCents,
    rebaja: (descuento) => descuento.amountCents,
    medio: 'esta web',
    discountCode: code,
  });

  if (delTotal) return { alcance: 'TOTAL', planCode: null, discount: delTotal.descuento };

  const registro = await discountService.encontrar(code);
  const linea = lineas.find((l) => l.plan.code === registro.planCode);
  return { alcance: 'PLAN', planCode: linea.plan.code, discount: linea.descuento };
}

/** Lo que se le devuelve al navegador de cada línea: nunca el plan entero. */
function resumenDeLineas(lineas) {
  return lineas.map(({ plan, descuento, rebaja, parteDelTotal, amountCents }) => ({
    plan: { code: plan.code, name: plan.name },
    amountCents,
    // Solo lo del código de la línea: lo del total se devuelve aparte, una vez.
    discount: descuento ? { code: descuento.code, amountCents: rebaja - parteDelTotal } : null,
  }));
}

/**
 * Las filas del carrito con la que abrió la orden primero.
 *
 * Solo esa lleva el identificador real de la pasarela: las demás llevan
 * `<orden>#2`, `#3`… porque la pareja (pasarela, orden) es única en la base y
 * esa unicidad es la que impide entregar dos veces un mismo cobro.
 */
function ordenarFilas(filas, orderId) {
  return [...filas].sort((a, b) => {
    if (a.providerOrderId === orderId) return -1;
    if (b.providerOrderId === orderId) return 1;
    return a.providerOrderId.localeCompare(b.providerOrderId);
  });
}

module.exports = {
  MAX_PRODUCTOS,
  nombreDelCarrito,
  planDelCarrito,
  resolverLineas,
  resumenDeLineas,
  codigoDeLaFila,
  resumenDelTotal,
  validarCodigoDelCarrito,
  ordenarFilas,
};
