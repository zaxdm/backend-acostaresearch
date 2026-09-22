'use strict';

const crypto = require('node:crypto');
const env = require('../../../config/env');

/**
 * Pasarela Culqi (cargo único con tarjeta o Yape, en soles).
 *
 * Funciona al revés que PayPal, y eso condiciona el contrato:
 *
 *  1. No hay «orden» que abrir en Culqi. `createOrder` solo inventa nuestra
 *     referencia; el importe queda fijado en la fila de `payments`, que es lo
 *     que se cobrará después.
 *
 *  2. El navegador abre el formulario de Culqi con la llave pública y recibe un
 *     token de un solo uso (`tkn_…` para tarjeta, `ype_…` para Yape). Con ese
 *     token, `captureOrder` crea el cargo desde aquí con la llave secreta. El
 *     importe sale de la fila del pago, nunca del navegador.
 *
 *  3. Si el banco pide 3-D Secure, Culqi responde 200 con `action_code:
 *     REVIEW` y NO cobra. El navegador pasa la verificación y vuelve a llamar
 *     con el mismo token y los parámetros `authentication_3DS`.
 *
 * Referencia: la especificación oficial en https://apidocs.culqi.com
 * (`/v2/charges`): 201 = cargo creado, 200 + REVIEW = falta 3DS, 402 =
 * tarjeta denegada (`card_error`), con `user_message` escrito para el cliente.
 */

const API_BASE = 'https://api.culqi.com';
/** Culqi no admite más de 50 caracteres en el correo del cargo. */
const CORREO_MAX = 50;
/** Si Culqi no contesta en este tiempo se aborta; el pago queda pendiente. */
const ESPERA_MS = 30 * 1000;

/**
 * Error de la pasarela con el detalle que devolvió.
 *
 * `reintentable` distingue el rechazo del banco —fondos, CVV, tarjeta
 * vencida—, en el que el comprador puede probar con otra tarjeta sobre el
 * mismo pago, de los fallos que no se arreglan reintentando.
 */
class CulqiError extends Error {
  constructor(message, { status, body, reintentable = false } = {}) {
    super(message);
    this.name = 'CulqiError';
    this.status = status;
    this.body = body;
    this.reintentable = reintentable;
    /** Frase de Culqi pensada para el comprador («Su tarjeta no tiene fondos…»). */
    this.userMessage = body?.user_message ?? null;
  }
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

/** Correo para el cargo: el de la cuenta, o el que escribió en el formulario. */
function correoDelCargo(payment, correoDelFormulario) {
  const candidatos = [payment.user?.email, correoDelFormulario];
  return candidatos.find((correo) => correo && correo.length <= CORREO_MAX) ?? null;
}

/** Descripción del cargo: Culqi exige entre 5 y 80 caracteres, o nada. */
function descripcionDelCargo(plan) {
  const texto = `Acosta Research · ${plan?.name ?? 'Compra'}`.slice(0, 80);
  return texto.length >= 5 ? texto : undefined;
}

/** Cuerpo del cargo. Todo lo que cuesta dinero sale de la fila del pago. */
function cuerpoDelCargo({ payment, token, email, authentication3DS, deviceFingerprint }) {
  const cuerpo = {
    amount: payment.amountCents,
    currency_code: payment.currency,
    email,
    source_id: token,
    capture: true,
    description: descripcionDelCargo(payment.plan),
    // Para cuadrar desde el panel de Culqi sin abrir la base de datos.
    metadata: {
      payment_id: payment.id,
      user_id: payment.userId,
      plan: payment.plan?.code ?? null,
    },
  };

  // Culqi pide que el segundo intento, el que ya trae 3DS, repita el mismo
  // token y la misma huella del dispositivo que el primero.
  if (deviceFingerprint) {
    cuerpo.antifraud_details = { device_finger_print_id: deviceFingerprint };
  }
  if (authentication3DS) cuerpo.authentication_3DS = authentication3DS;

  return cuerpo;
}

const culqiProvider = {
  code: 'CULQI',
  label: 'Tarjeta o Yape',
  currency: 'PEN',
  /** El cobro no se puede confirmar sin el token que da el formulario de Culqi. */
  needsToken: true,

  isEnabled: () => env.culqiEnabled,

  /** Llave pública: la necesita el navegador para abrir el formulario. */
  publicKey: () => (env.culqiEnabled ? env.CULQI_PUBLIC_KEY : null),

  /** En soles, con el mismo precio del plan que el Yape manual. */
  priceForPlan(plan) {
    return plan.priceCents ?? null;
  },

  /**
   * Culqi no tiene orden previa: se devuelve una referencia nuestra, única,
   * que es la que el navegador manda de vuelta al confirmar.
   */
  async createOrder() {
    return { orderId: `cq_${crypto.randomUUID()}`, approveUrl: null };
  },

  /**
   * Crea el cargo con el token del formulario.
   *
   * Devuelve la misma forma que PayPal cuando cobra, o `{ requiresAuthentication }`
   * cuando el banco pide 3DS (no se ha cobrado nada). No es idempotente por
   * cabecera como PayPal, pero no hace falta: el token es de un solo uso, así
   * que un reintento con el mismo token no puede cobrar dos veces.
   */
  async captureOrder(_orderId, { payment, token, email, authentication3DS, deviceFingerprint } = {}) {
    const correo = correoDelCargo(payment, email);
    if (!correo) {
      throw new CulqiError('No hay un correo de hasta 50 caracteres para el cargo.', {
        reintentable: true,
        body: {
          user_message:
            'Culqi necesita un correo de hasta 50 caracteres. Escríbelo en el formulario de pago.',
        },
      });
    }

    const response = await fetch(`${API_BASE}/v2/charges`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CULQI_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        cuerpoDelCargo({ payment, token, email: correo, authentication3DS, deviceFingerprint }),
      ),
      signal: AbortSignal.timeout(ESPERA_MS),
    });

    const body = await leerRespuesta(response);

    // Por el contenido y no por el código HTTP: la API y la guía de 3DS de
    // Culqi dicen 200 para esto, pero la página de uso de la librería dice
    // 201. Un cargo de verdad trae `object: charge`; esto no.
    if (body?.action_code === 'REVIEW' && body?.object !== 'charge') {
      return { requiresAuthentication: true, raw: body };
    }

    if (response.ok && body?.object === 'charge') {
      return {
        captured: body.outcome?.type === 'venta_exitosa',
        captureId: body.id,
        amountCents: body.amount,
        currency: body.currency_code,
        payerEmail: body.email ?? correo,
        status: body.outcome?.type ?? null,
        raw: body,
      };
    }

    // 402 es el banco diciendo que no: el comprador puede probar otra tarjeta.
    // Un token caducado o ya usado (resource_error) también se arregla abriendo
    // el formulario de nuevo, que emite otro.
    const reintentable =
      body?.type === 'card_error' || body?.type === 'resource_error' || response.status === 402;

    throw new CulqiError('Culqi no pudo completar el cobro.', {
      status: response.status,
      body,
      reintentable,
    });
  },
};

module.exports = { culqiProvider, CulqiError };
