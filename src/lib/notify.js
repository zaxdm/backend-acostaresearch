'use strict';

const env = require('../config/env');
const logger = require('../config/logger');

/**
 * Avisos al móvil del administrador.
 *
 * El correo ya avisa, pero un correo se lee cuando uno decide abrir el correo, y
 * un comprobante de Yape espera a que alguien lo mire: cada hora de retraso es
 * una hora que alguien que ya pagó pasa sin su acceso. Esto es la campanita.
 *
 * Va aparte del `mailer` porque no es correo: no tiene destinatario, ni asunto,
 * ni plantilla HTML. Es un empujón a un teléfono.
 *
 * ── Canal: ntfy ─────────────────────────────────────────────────────────────
 *
 * Se eligió porque es un POST y ya está: sin SDK, sin claves de API, sin
 * verificación de empresa, y con app propia en Android y iOS. WhatsApp haría
 * falta pasar por la Cloud API de Meta con la cuenta verificada y una plantilla
 * aprobada; se puede, pero es trámite, y esto tenía que estar hoy.
 *
 * Se publica en JSON contra la raíz, no con cabeceras: los títulos llevan
 * tildes y «·», y las cabeceras HTTP no son sitio para UTF-8.
 *
 * ── Lo que NO se manda ──────────────────────────────────────────────────────
 *
 * En el plan gratuito de ntfy los tópicos no se reservan: cualquiera que
 * acierte el nombre puede leerlos. El nombre es largo y aleatorio justo por
 * eso, pero un aviso que viaja por ahí no es sitio para el correo del
 * comprador. Va lo justo para decidir si merece la pena mirarlo ahora: nombre
 * de pila, importe y plan. El resto está detrás del panel, que pide sesión.
 */

/** Segundos que se espera al servidor de avisos. Pasados, se abandona. */
const TIEMPO_LIMITE_MS = 5000;

/**
 * Manda un aviso, sin bloquear y sin poder tumbar nada.
 *
 * Se llama sin `await` a propósito: quien la invoca está en mitad de una
 * petición del comprador, y que su Yape se registre no puede depender de que un
 * servidor de notificaciones responda. Si falla, se registra en el log —donde
 * se mira cuando alguien dice que no le llegó— y se sigue.
 *
 * Sin `NTFY_TOPIC` configurado no se llama a nadie, igual que el mailer sin
 * SMTP: el aviso se escribe en el log y en desarrollo eso es lo que hace falta.
 */
function avisarAlAdmin({ titulo, mensaje, etiquetas = [], prioridad = 4, enlace }) {
  if (!env.NTFY_TOPIC) {
    logger.info({ titulo, mensaje }, 'Aviso al administrador (ntfy sin configurar)');
    return;
  }

  const cuerpo = {
    topic: env.NTFY_TOPIC,
    title: titulo,
    message: mensaje,
    tags: etiquetas,
    priority: prioridad,
    ...(enlace ? { click: enlace } : {}),
  };

  const cabeceras = { 'Content-Type': 'application/json' };
  if (env.NTFY_TOKEN) cabeceras.Authorization = `Bearer ${env.NTFY_TOKEN}`;

  fetch(env.NTFY_URL, {
    method: 'POST',
    headers: cabeceras,
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
  })
    .then(async (respuesta) => {
      if (respuesta.ok) return;

      // El cuerpo del error dice si es el tópico, el token o el cupo diario.
      const detalle = await respuesta.text().catch(() => '');
      logger.error(
        { status: respuesta.status, detalle: detalle.slice(0, 200) },
        'El servidor de avisos rechazó la notificación',
      );
    })
    .catch((error) => {
      logger.error({ err: error }, 'No se pudo enviar el aviso al administrador');
    });
}

module.exports = { avisarAlAdmin };
