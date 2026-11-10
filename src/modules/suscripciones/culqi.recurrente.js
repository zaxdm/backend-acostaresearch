'use strict';

const env = require('../../config/env');
const { CulqiError } = require('../payments/providers/culqi.provider');

/**
 * Lo que hace falta de Culqi para cobrar cada mes con una tarjeta guardada
 * (10-nov-2026): clientes, tarjetas, planes recurrentes y suscripciones.
 *
 * Probado contra Culqi en modo de prueba el 10-nov-2026:
 *   · una tarjeta guardada (`crd_…`) sirve como `source_id` de un cargo normal;
 *   · una suscripción a un plan SIN ciclos iniciales cobra el primer mes EN EL
 *     ACTO (unos segundos después de crearla); con un ciclo inicial sin cargo
 *     (`count: 1, has_initial_charge: false`) no cobra al crearla;
 *   · cancelar es un DELETE y desde ahí no se cobra más.
 *
 * Referencia: la especificación oficial, https://apidocs.culqi.com/apiculqi.yaml
 * (`/v2/customers`, `/v2/cards`, `/v2/recurrent/plans/create`,
 * `/v2/recurrent/subscriptions/create`, `/v2/events/{id}`).
 */

const API_BASE = 'https://api.culqi.com';
const ESPERA_MS = 30 * 1000;
/** Unidad de tiempo de Culqi para «mensual». */
const MENSUAL = 3;

async function llamar(ruta, { method = 'POST', body } = {}) {
  const response = await fetch(`${API_BASE}${ruta}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.CULQI_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(ESPERA_MS),
  });
  const texto = await response.text();
  let datos = null;
  try {
    datos = texto ? JSON.parse(texto) : null;
  } catch {
    datos = { raw: texto };
  }
  return { ok: response.ok, status: response.status, datos };
}

function fallo(mensaje, { status, datos }) {
  const reintentable = datos?.type === 'card_error' || status === 402;
  return new CulqiError(mensaje, { status, body: datos, reintentable });
}

/** Culqi solo acepta letras y espacios en nombres y apellidos. */
function soloLetras(texto, porDefecto) {
  const limpio = String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-zÑñ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
  return limpio.length >= 2 ? limpio : porDefecto;
}

/** «Visa •••• 1111» a partir de la tarjeta que devuelve Culqi. Nunca el número. */
function etiquetaDeTarjeta(tarjeta) {
  const fuente = tarjeta?.source ?? {};
  const marca = fuente.iin?.card_brand ?? fuente.card_brand ?? 'Tarjeta';
  const numero = String(fuente.card_number ?? fuente.last_four ?? '');
  const ultimos = numero.replace(/\D/g, '').slice(-4);
  return ultimos ? `${marca} •••• ${ultimos}` : marca;
}

const culqiRecurrente = {
  etiquetaDeTarjeta,

  /** El cliente de Culqi con ese correo, o uno nuevo con los datos del formulario. */
  async clienteDe({ email, nombre, apellido, telefono, ciudad, direccion }) {
    const busqueda = await llamar(`/v2/customers?email=${encodeURIComponent(email)}`, { method: 'GET' });
    const existente = busqueda.ok ? busqueda.datos?.data?.find((c) => c.email === email) : null;
    if (existente?.id) return existente.id;

    const creado = await llamar('/v2/customers', {
      body: {
        first_name: soloLetras(nombre, 'Cliente'),
        last_name: soloLetras(apellido, 'Acosta'),
        email,
        address: String(direccion ?? '').trim().slice(0, 100) || 'Sin direccion',
        address_city: String(ciudad ?? '').trim().slice(0, 30) || 'Lima',
        country_code: 'PE',
        phone_number: String(telefono ?? '').replace(/\D/g, '').slice(0, 15) || '999999999',
      },
    });
    if (creado.ok && creado.datos?.id) return creado.datos.id;
    throw fallo('Culqi no pudo registrar al cliente.', creado);
  },

  /**
   * Guarda la tarjeta del token. Si el banco pide 3-D Secure, Culqi responde
   * REVIEW y no guarda nada: el navegador verifica y se repite con
   * `authentication3DS` y el mismo token, igual que en un cargo.
   */
  async guardarTarjeta({ customerId, token, authentication3DS }) {
    const r = await llamar('/v2/cards', {
      body: {
        customer_id: customerId,
        token_id: token,
        ...(authentication3DS ? { authentication_3DS: authentication3DS } : {}),
      },
    });
    if (r.datos?.action_code === 'REVIEW' && !r.datos?.id) return { requiresAuthentication: true };
    if (r.ok && r.datos?.id) return { cardId: r.datos.id, etiqueta: etiquetaDeTarjeta(r.datos) };
    throw fallo('Culqi no pudo guardar la tarjeta.', r);
  },

  /** Crea en Culqi el plan mensual de un plan nuestro y devuelve su id (`pln_…`). */
  async crearPlanMensual(plan) {
    // Culqi rechaza tildes y signos («+», «·», comas) en el nombre y la descripción.
    const nombre = String(plan.name)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 50);
    const corto = `${plan.code}-${Date.now()}`.toLowerCase().replace(/_/g, '-').slice(0, 50);
    const r = await llamar('/v2/recurrent/plans/create', {
      body: {
        name: nombre.length >= 5 ? nombre : `Plan ${plan.code}`,
        short_name: corto,
        description: `Cobro mensual de ${nombre}`.slice(0, 200),
        amount: plan.priceCents,
        currency: plan.currency ?? 'PEN',
        interval_unit_time: MENSUAL,
        // 0 = sin fin, hasta que se cancele. El entorno de prueba solo admite 1 a 3.
        interval_count: env.CULQI_SECRET_KEY?.startsWith('sk_test_') ? 3 : 0,
        // Un ciclo inicial SIN cargo: el primer mes ya se cobró como un cargo
        // normal. Sin él, Culqi cobra el primer mes en el acto al suscribir
        // (comprobado en modo de prueba el 10-nov-2026) y se cobraría dos veces.
        initial_cycles: { count: 1, has_initial_charge: false, amount: 0, interval_unit_time: MENSUAL },
        metadata: { plan: plan.code },
      },
    });
    if (r.ok && r.datos?.id) return r.datos.id;
    throw fallo('Culqi no pudo crear el plan mensual.', r);
  },

  /** Suscribe la tarjeta al plan de Culqi. Devuelve el id y la fecha del próximo cobro. */
  async suscribir({ cardId, culqiPlanId, metadata }) {
    const r = await llamar('/v2/recurrent/subscriptions/create', {
      body: { card_id: cardId, plan_id: culqiPlanId, tyc: true, metadata },
    });
    if (!r.ok || !r.datos?.id) throw fallo('Culqi no pudo crear la suscripción.', r);
    const detalle = await this.verSuscripcion(r.datos.id).catch(() => null);
    return { id: r.datos.id, proximoCobro: detalle?.proximoCobro ?? null };
  },

  /** El estado de una suscripción, con los cobros de cada periodo. */
  async verSuscripcion(id) {
    const r = await llamar(`/v2/recurrent/subscriptions/${encodeURIComponent(id)}`, { method: 'GET' });
    if (!r.ok) throw fallo('Culqi no devolvió la suscripción.', r);
    const d = r.datos ?? {};
    return {
      id: d.id,
      status: d.status,
      proximoCobro: d.next_billing_date ? new Date(d.next_billing_date * 1000) : null,
      periodos: Array.isArray(d.periods) ? d.periods : [],
      crudo: d,
    };
  },

  /** Un cargo tal como lo tiene Culqi, para creer solo lo que Culqi dice que cobró. */
  async cargo(id) {
    const r = await llamar(`/v2/charges/${encodeURIComponent(id)}`, { method: 'GET' });
    return r.ok ? r.datos : null;
  },

  async cancelar(id) {
    const r = await llamar(`/v2/recurrent/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    // Ya no existe en Culqi: para nosotros, igual de cancelada.
    if (r.ok || r.status === 404) return true;
    throw fallo('Culqi no pudo cancelar la suscripción.', r);
  },

  /**
   * Un evento leído desde Culqi con nuestra llave secreta. El webhook no viene
   * firmado: lo que llega al servidor solo se usa para saber QUÉ evento leer, y
   * se cree lo que dice Culqi, no lo que dice el cuerpo recibido.
   */
  async evento(id) {
    const r = await llamar(`/v2/events/${encodeURIComponent(id)}`, { method: 'GET' });
    return r.ok ? r.datos : null;
  },
};

module.exports = culqiRecurrente;
