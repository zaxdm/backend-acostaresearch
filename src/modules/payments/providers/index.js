'use strict';

const { paypalProvider } = require('./paypal.provider');
const { culqiProvider } = require('./culqi.provider');

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
 *   captureOrder(orderId, contexto)
 *                           → { captured, captureId, amountCents, currency,
 *                               payerEmail, status, raw }
 *                             o { requiresAuthentication: true, raw } si el
 *                             banco pide 3-D Secure y todavía no se cobró nada.
 *                             `contexto` trae el pago (`payment`) y lo que mandó
 *                             el navegador (`token`, `email`, `authentication3DS`,
 *                             `deviceFingerprint`); PayPal no lo usa.
 *
 * Opcionales:
 *
 *   needsToken              true si el cobro no se confirma sin el token que da
 *                           el formulario de la pasarela en el navegador (Culqi)
 *   publicKey()             llave pública que el navegador necesita, o null
 *
 * Culqi cobra en soles, así que su `priceForPlan` devuelve `plan.priceCents` y
 * no necesita el precio en dólares.
 */
const PROVIDERS = Object.freeze({
  [paypalProvider.code]: paypalProvider,
  [culqiProvider.code]: culqiProvider,
});

function getProvider(code) {
  return PROVIDERS[code] ?? null;
}

/** Pasarelas con credenciales puestas: las únicas que se ofrecen al usuario. */
function enabledProviders() {
  return Object.values(PROVIDERS).filter((provider) => provider.isEnabled());
}

module.exports = { getProvider, enabledProviders, PROVIDERS };
