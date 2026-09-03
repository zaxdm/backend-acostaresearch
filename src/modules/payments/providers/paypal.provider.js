'use strict';

const crypto = require('node:crypto');
const env = require('../../../config/env');
const logger = require('../../../config/logger');

/**
 * Pasarela PayPal (Checkout Standard, intención CAPTURE).
 *
 * Dos avisos que condicionan todo lo demás:
 *
 *  1. PayPal NO admite soles. Su lista de monedas no incluye PEN, así que aquí
 *     se cobra en dólares y cada plan necesita su propio `priceUsdCents`. No es
 *     una conversión automática: el precio en dólares se fija a mano en el
 *     seed, con margen para la comisión internacional.
 *
 *  2. Con intención CAPTURE no se mueve un céntimo hasta que este servidor
 *     llama a capturar. Si el usuario aprueba y cierra el navegador, la orden
 *     se queda a medias y no se le ha cobrado nada.
 */

const CADUCIDAD_MARGEN_MS = 60 * 1000; // se renueva el token un minuto antes

let tokenCache = null; // { valor, expiraEn }

/** Error de la pasarela con el detalle que devolvió, para poder diagnosticar. */
class PaypalError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'PaypalError';
    this.status = status;
    this.body = body;
  }
}

/** Primer `issue` que reporta PayPal, que es el que explica el rechazo. */
function primerIssue(body) {
  return body?.details?.[0]?.issue ?? body?.name ?? null;
}

async function leerRespuesta(response) {
  const texto = await response.text();
  if (!texto) return null;
  try {
    return JSON.parse(texto);
  } catch {
    return { raw: texto };
  }
}

/**
 * Token de aplicación (client_credentials). Se guarda en memoria porque vale
 * varias horas y pedirlo en cada compra añade una llamada de red inútil.
 */
async function obtenerToken() {
  if (tokenCache && tokenCache.expiraEn > Date.now()) {
    return tokenCache.valor;
  }

  const credenciales = Buffer.from(
    `${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`,
  ).toString('base64');

  const response = await fetch(`${env.paypalApiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credenciales}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const body = await leerRespuesta(response);

  if (!response.ok) {
    tokenCache = null;
    throw new PaypalError('PayPal rechazó las credenciales de la aplicación.', {
      status: response.status,
      body,
    });
  }

  tokenCache = {
    valor: body.access_token,
    expiraEn: Date.now() + body.expires_in * 1000 - CADUCIDAD_MARGEN_MS,
  };

  return tokenCache.valor;
}

async function llamar(ruta, { method = 'GET', body, idempotencia } = {}) {
  const token = await obtenerToken();

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  // PayPal usa esta cabecera para no duplicar la operación si se reintenta.
  if (idempotencia) headers['PayPal-Request-Id'] = idempotencia;

  const response = await fetch(`${env.paypalApiBase}${ruta}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  return { status: response.status, ok: response.ok, body: await leerRespuesta(response) };
}

/** Céntimos a la cadena decimal que espera PayPal ("19.90"). */
function aImporte(cents) {
  return (cents / 100).toFixed(2);
}

/** Cadena decimal de PayPal a céntimos, para comparar sin coma flotante. */
function aCentimos(valor) {
  return Math.round(Number.parseFloat(valor) * 100);
}

/** Extrae la captura de la respuesta, venga de capturar o de consultar la orden. */
function extraerCaptura(orden) {
  const captura = orden?.purchase_units?.[0]?.payments?.captures?.[0];
  if (!captura) return null;

  return {
    captured: captura.status === 'COMPLETED',
    captureId: captura.id,
    amountCents: aCentimos(captura.amount.value),
    currency: captura.amount.currency_code,
    payerEmail: orden?.payer?.email_address ?? null,
    status: captura.status,
  };
}

const paypalProvider = {
  code: 'PAYPAL',
  label: 'PayPal',
  currency: 'USD',

  isEnabled: () => env.paypalEnabled,

  /** Importe a cobrar por este plan, o null si no tiene precio en dólares. */
  priceForPlan(plan) {
    return plan.priceUsdCents ?? null;
  },

  /**
   * Crea la orden. Devuelve el identificador que el botón de PayPal necesita
   * en el navegador y el enlace de aprobación, por si algún día se prefiere
   * redirigir en vez de abrir la ventana.
   */
  async createOrder({ plan, amountCents, referencia }) {
    const { ok, status, body } = await llamar('/v2/checkout/orders', {
      method: 'POST',
      idempotencia: crypto.randomUUID(),
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: plan.code,
            // Sirve para reconciliar desde el panel de PayPal sin abrir la BD.
            custom_id: referencia,
            description: `${plan.name} · ${plan.words} palabras`,
            amount: { currency_code: this.currency, value: aImporte(amountCents) },
          },
        ],
        application_context: {
          brand_name: 'Acosta Research',
          locale: 'es-PE',
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
        },
      },
    });

    if (!ok) {
      throw new PaypalError('PayPal no pudo crear la orden de pago.', { status, body });
    }

    return {
      orderId: body.id,
      approveUrl: body.links?.find((link) => link.rel === 'approve')?.href ?? null,
    };
  },

  /**
   * Cobra una orden ya aprobada. Es idempotente: si PayPal responde que ya
   * estaba capturada, se consulta la orden y se devuelve esa misma captura en
   * lugar de tratarlo como un fallo.
   */
  async captureOrder(orderId) {
    const captura = await llamar(`/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      idempotencia: `capture-${orderId}`,
    });

    if (captura.ok) {
      const datos = extraerCaptura(captura.body);
      if (!datos) {
        throw new PaypalError('PayPal confirmó el cobro pero no devolvió la captura.', {
          status: captura.status,
          body: captura.body,
        });
      }
      return { ...datos, raw: captura.body };
    }

    if (primerIssue(captura.body) === 'ORDER_ALREADY_CAPTURED') {
      logger.warn({ orderId }, 'La orden ya estaba capturada: se consulta su estado');

      const consulta = await llamar(`/v2/checkout/orders/${orderId}`);
      const datos = consulta.ok ? extraerCaptura(consulta.body) : null;

      if (datos) return { ...datos, raw: consulta.body };
    }

    throw new PaypalError('PayPal no pudo completar el cobro.', {
      status: captura.status,
      body: captura.body,
    });
  },
};

module.exports = { paypalProvider, PaypalError };
