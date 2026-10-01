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
 *
 * Se rechaza el carrito entero si una línea falla: cobrar una parte de lo que
 * eligió no es lo que pidió.
 */
async function resolverLineas(items, { precio, rebaja, medio }) {
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

    lineas.push({ plan, descuento, rebaja: menos, amountCents: base - menos });
  }

  return lineas;
}

/** Lo que se le devuelve al navegador de cada línea: nunca el plan entero. */
function resumenDeLineas(lineas) {
  return lineas.map(({ plan, descuento, rebaja, amountCents }) => ({
    plan: { code: plan.code, name: plan.name },
    amountCents,
    discount: descuento ? { code: descuento.code, amountCents: rebaja } : null,
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
  ordenarFilas,
};
