'use strict';

const crypto = require('node:crypto');
const env = require('../../../config/env');
const { PRODUCTOS, productoDelPlan } = require('./hotmart.productos');

/**
 * Pasarela Hotmart (pago único, en su propia página).
 *
 * Es la única en la que este servidor NO confirma el cobro, y eso cambia el
 * contrato:
 *
 *  1. `createOrder` no habla con Hotmart. Inventa nuestra referencia y la manda
 *     en el enlace de pago como `sck`; Hotmart la devuelve en el aviso
 *     (`purchase.origin.sck`) y así se sabe qué fila de `payments` se pagó.
 *
 *  2. El comprador paga en `pay.hotmart.com`. Quien confirma es el webhook
 *     (`hotmart.webhook`), no `captureOrder`: Hotmart avisa cuando aprueba, y
 *     con algunos medios (efectivo, transferencia) eso ocurre horas después.
 *
 *  3. El precio lo fija Hotmart y no se puede cambiar. Tampoco admite nuestros
 *     códigos de descuento ni cobrar varios productos de una vez: por eso
 *     `sinDescuentos` y `soloCompraSuelta`.
 */

const PAGINA_DE_PAGO = 'https://pay.hotmart.com';

const hotmartProvider = {
  code: 'HOTMART',
  label: 'Hotmart',
  currency: 'PEN',
  /** El cobro lo confirma el aviso de Hotmart, no el navegador. */
  confirmaPorAviso: true,
  /** Hotmart cobra su precio fijo: nuestros códigos no se pueden restar. */
  sinDescuentos: true,
  /** Un enlace de pago es de un solo producto: no hay carrito. */
  soloCompraSuelta: true,

  isEnabled: () => env.hotmartEnabled,

  /** Los planes que se pueden pagar aquí: la web solo ofrece Hotmart para ellos. */
  planesQueVende: () => Object.keys(PRODUCTOS).filter((code) => productoDelPlan(code)),

  /** El precio del plan, si ese plan tiene producto en Hotmart. */
  priceForPlan(plan) {
    return productoDelPlan(plan.code) ? plan.priceCents : null;
  },

  /**
   * El enlace de pago del producto, con nuestra referencia en `sck`. El
   * comprador va a la página de Hotmart; la orden de Hotmart nace allí.
   */
  async createOrder({ plan }) {
    const producto = productoDelPlan(plan.code);
    if (!producto) throw new Error(`El plan ${plan.code} no tiene producto en Hotmart.`);

    const orderId = `hm_${crypto.randomUUID()}`;
    const approveUrl = `${PAGINA_DE_PAGO}/${producto.checkout}?sck=${encodeURIComponent(orderId)}`;
    return { orderId, approveUrl };
  },

  /** No hay nada que capturar: lo confirma el webhook. */
  async captureOrder() {
    throw new Error('Hotmart confirma los pagos por su webhook, no por captura.');
  },
};

module.exports = { hotmartProvider };
