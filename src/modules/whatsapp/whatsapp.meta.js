'use strict';

const crypto = require('node:crypto');
const env = require('../../config/env');
const logger = require('../../config/logger');

/**
 * La Cloud API de WhatsApp (Meta): recibir, comprobar y mandar.
 *
 * Sin SDK, como Gemini: son dos llamadas y una firma.
 *
 * ── Modo maqueta ────────────────────────────────────────────────────────────
 *
 * Sin las cuatro claves de Meta (`env.whatsappMetaEnabled`), `enviarTexto` no
 * llama a nadie y devuelve `{ simulado: true }`. Todo lo demás —guardar, pensar
 * la respuesta, el panel— funciona igual, así que el bot se prueba entero
 * desde «Probar el bot» antes de tener la cuenta de Meta. El día que estén las
 * claves no hay que tocar código.
 */

const GRAPH = 'https://graph.facebook.com';

/** WhatsApp corta en 4096 caracteres. Se deja margen para el «…». */
const MAX_TEXTO = 4000;

/**
 * El aviso viene de Meta y no de cualquiera que conozca la dirección.
 *
 * Meta firma el cuerpo EXACTO con la clave secreta de la app (HMAC-SHA256) y
 * manda la firma en `X-Hub-Signature-256: sha256=<hex>`. Se compara en tiempo
 * constante. Sin clave secreta no se acepta nada: un webhook sin comprobar
 * dejaría a cualquiera hacerle gastar Gemini al bot en nombre de otro número.
 */
function firmaValida(cuerpoCrudo, cabecera, secreto = env.WHATSAPP_APP_SECRET) {
  if (!secreto || !Buffer.isBuffer(cuerpoCrudo) || typeof cabecera !== 'string') return false;
  const [algoritmo, recibida] = cabecera.split('=');
  if (algoritmo !== 'sha256' || !/^[a-f0-9]{64}$/i.test(recibida ?? '')) return false;

  const esperada = crypto.createHmac('sha256', secreto).update(cuerpoCrudo).digest();
  return crypto.timingSafeEqual(esperada, Buffer.from(recibida, 'hex'));
}

/**
 * Lo que cuenta como texto de un mensaje. Los botones y las listas llegan con
 * su propio tipo pero son una respuesta escrita más.
 */
function textoDe(mensaje) {
  switch (mensaje.type) {
    case 'text':
      return mensaje.text?.body ?? '';
    case 'button':
      return mensaje.button?.text ?? '';
    case 'interactive':
      return (
        mensaje.interactive?.button_reply?.title ?? mensaje.interactive?.list_reply?.title ?? ''
      );
    default:
      return '';
  }
}

/**
 * Los mensajes que trae un aviso de Meta, ya aplanados.
 *
 * Un aviso puede traer varias entradas y varios cambios; también trae los
 * «entregado» y «leído» de lo que mandamos (`statuses`), que aquí no interesan.
 * Solo se aceptan los del número propio: si la app tuviera un segundo número
 * de pruebas, sus mensajes no se mezclan.
 */
function extraerMensajes(cuerpo, numeroPropio = env.WHATSAPP_PHONE_NUMBER_ID) {
  if (cuerpo?.object !== 'whatsapp_business_account') return [];

  const mensajes = [];
  for (const entrada of cuerpo.entry ?? []) {
    for (const cambio of entrada.changes ?? []) {
      if (cambio.field !== 'messages') continue;
      const valor = cambio.value ?? {};
      if (numeroPropio && valor.metadata?.phone_number_id !== numeroPropio) continue;

      const nombres = new Map(
        (valor.contacts ?? []).map((c) => [String(c.wa_id), String(c.profile?.name ?? '')]),
      );
      for (const mensaje of valor.messages ?? []) {
        const telefono = String(mensaje.from ?? '').replace(/\D/g, '');
        if (!telefono || !mensaje.id) continue;
        mensajes.push({
          waId: String(mensaje.id),
          telefono,
          nombre: nombres.get(telefono) ?? '',
          tipo: String(mensaje.type ?? 'unknown'),
          texto: textoDe(mensaje).trim(),
        });
      }
    }
  }
  return mensajes;
}

/**
 * Lo que el equipo contestó DESDE EL CELULAR, ya aplanado.
 *
 * Con la coexistencia el mismo número vive en la app WhatsApp Business y en la
 * API. Lo que se escribe desde la app no pasa por aquí, pero Meta lo avisa en
 * el campo `smb_message_echoes` (hay que suscribirlo en el webhook). Ahí `to`
 * es el cliente. Sirve para que el bot sepa que una persona tomó la
 * conversación y se calle, como cuando se contesta desde el panel.
 */
function extraerEcos(cuerpo, numeroPropio = env.WHATSAPP_PHONE_NUMBER_ID) {
  if (cuerpo?.object !== 'whatsapp_business_account') return [];

  const ecos = [];
  for (const entrada of cuerpo.entry ?? []) {
    for (const cambio of entrada.changes ?? []) {
      if (cambio.field !== 'smb_message_echoes') continue;
      const valor = cambio.value ?? {};
      if (numeroPropio && valor.metadata?.phone_number_id !== numeroPropio) continue;

      for (const eco of valor.message_echoes ?? []) {
        const telefono = String(eco.to ?? '').replace(/\D/g, '');
        if (!telefono || !eco.id) continue;
        ecos.push({
          waId: String(eco.id),
          telefono,
          tipo: String(eco.type ?? 'unknown'),
          texto: textoDe(eco).trim(),
        });
      }
    }
  }
  return ecos;
}

/** Recorta a lo que cabe en un mensaje de WhatsApp. */
function recortar(texto) {
  return texto.length > MAX_TEXTO ? `${texto.slice(0, MAX_TEXTO - 1)}…` : texto;
}

/**
 * Meta explica sus errores con un código. El que más va a salir es el de la
 * ventana de 24 horas: pasado un día desde el último mensaje del cliente, solo
 * se le puede escribir con una plantilla aprobada.
 */
function explicarError(cuerpo, status) {
  const error = cuerpo?.error ?? {};
  if (error.code === 131047 || /re-engagement/i.test(error.message ?? '')) {
    return 'Pasaron más de 24 horas desde su último mensaje: WhatsApp solo deja escribirle con una plantilla aprobada.';
  }
  if (error.code === 190) return 'El token de Meta caducó o no vale (WHATSAPP_TOKEN).';
  return (error.error_data?.details ?? error.message ?? `Meta respondió ${status}`).slice(0, 480);
}

/**
 * Manda un texto. Nunca lanza: devuelve qué pasó para guardarlo con el mensaje.
 *
 * @returns {Promise<{ simulado: true } | { waId: string } | { error: string }>}
 */
async function enviarTexto(telefono, texto, { fetchImpl = fetch } = {}) {
  if (!env.whatsappMetaEnabled) return { simulado: true };

  try {
    const respuesta = await fetchImpl(
      `${GRAPH}/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: telefono,
          type: 'text',
          text: { preview_url: true, body: recortar(texto) },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const cuerpo = await respuesta.json().catch(() => null);
    if (!respuesta.ok) return { error: explicarError(cuerpo, respuesta.status) };
    return { waId: String(cuerpo?.messages?.[0]?.id ?? '') || null };
  } catch (error) {
    logger.warn({ err: error }, 'WhatsApp: no se pudo mandar el mensaje');
    return { error: 'No hubo respuesta de Meta. Inténtalo otra vez.' };
  }
}

/**
 * Marca el mensaje como leído y enseña «escribiendo…» mientras el bot piensa.
 * Es cortesía: si falla, no pasa nada y no se espera.
 */
function marcarLeido(waId, { fetchImpl = fetch } = {}) {
  if (!env.whatsappMetaEnabled || !waId) return;
  fetchImpl(`${GRAPH}/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.WHATSAPP_TOKEN}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: waId,
      typing_indicator: { type: 'text' },
    }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}

module.exports = { firmaValida, extraerMensajes, extraerEcos, enviarTexto, marcarLeido, recortar, MAX_TEXTO };
