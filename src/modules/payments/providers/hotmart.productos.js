'use strict';

/**
 * Qué producto de Hotmart vende cada plan.
 *
 * En Hotmart cada plan es un producto propio, de pago único, con su precio fijo
 * y su página de pago. Aquí se enlazan los dos lados:
 *
 *   productId   el «ID» que Hotmart enseña bajo el nombre del producto. Es lo
 *               que trae el webhook (`data.product.id`) y lo que decide qué
 *               plan se entrega.
 *   checkout    el código del «link de pago» (`pay.hotmart.com/<checkout>`).
 *
 * Un plan que no está aquí no se puede pagar con Hotmart: la pasarela no se
 * ofrece para él. Añadir uno es sumar su línea con los dos datos de Hotmart.
 *
 * El precio NO va aquí: lo fija Hotmart y no se puede cambiar después de crear
 * el producto. La fila del pago guarda el que Hotmart dice que cobró.
 */
const PRODUCTOS = Object.freeze({
  METODO_DE_TESIS_HUMANIZADOR: { productId: 8674715, checkout: 'S107921285K' },
  ARTICULO_SCIENTIFICOS: { productId: 8674925, checkout: 'S107921644U' },
  ARTICULOS_REVIEW: { productId: 8674979, checkout: 'X107921736P' },
  // En análisis en Hotmart: con `checkout: null` la web no los ofrece hasta que
  // estén aprobados, pero el webhook ya reconoce sus ventas.
  TSP_SUFICIENCIA_PROFESIONAL: { productId: 8675039, checkout: null }, // H107921854B
  HUMANIZADOR_ACADEMICO: { productId: 8675102, checkout: null }, // link por confirmar
});

/**
 * El producto de Hotmart de un plan, o null si ese plan no se puede pagar
 * allí desde la web: sin el código del link de pago no hay adónde llevarlo.
 */
function productoDelPlan(planCode) {
  const producto = PRODUCTOS[planCode];
  return producto?.checkout ? producto : null;
}

/** El plan que vende un producto de Hotmart, por el ID que trae el webhook. */
function planDelProducto(productId) {
  const id = Number(productId);
  const encontrado = Object.entries(PRODUCTOS).find(([, producto]) => producto.productId === id);
  return encontrado ? encontrado[0] : null;
}

module.exports = { PRODUCTOS, productoDelPlan, planDelProducto };
