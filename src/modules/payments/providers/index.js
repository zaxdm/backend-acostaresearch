'use strict';

const { paypalProvider } = require('./paypal.provider');

/**
 * Registro de pasarelas.
 *
 * Añadir Culqi o Mercado Pago es escribir un archivo hermano de
 * `paypal.provider.js` y sumarlo aquí; ni el servicio ni la base de datos
 * cambian. El contrato que debe cumplir cualquier pasarela es:
 *
 *   code                    identificador estable, se guarda en `Payment.provider`
 *   label                   nombre para la interfaz
 *   currency                moneda ISO-4217 en la que cobra ESTA pasarela
 *   isEnabled()             ¿hay credenciales configuradas?
 *   priceForPlan(plan)      importe en céntimos de `currency`, o null si el plan
 *                           no se puede cobrar aquí
 *   createOrder({ plan, amountCents, referencia })
 *                           → { orderId, approveUrl }
 *   captureOrder(orderId)   → { captured, captureId, amountCents, currency,
 *                               payerEmail, status, raw }
 *
 * Culqi y Mercado Pago sí cobran en soles, así que su `priceForPlan` devolverá
 * `plan.priceCents` y no hará falta el precio en dólares.
 */
const PROVIDERS = Object.freeze({
  [paypalProvider.code]: paypalProvider,
});

function getProvider(code) {
  return PROVIDERS[code] ?? null;
}

/** Pasarelas con credenciales puestas: las únicas que se ofrecen al usuario. */
function enabledProviders() {
  return Object.values(PROVIDERS).filter((provider) => provider.isEnabled());
}

module.exports = { getProvider, enabledProviders, PROVIDERS };
