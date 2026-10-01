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

/**
 * ── Dos tópicos: el del administrador y el del programador ─────────────────
 *
 * El administrador atiende el negocio desde el móvil: un Yape que aprobar, una
 * reseña, un reclamo, una licencia que el detector revocó. Un error de Prisma o
 * un respaldo comprobado no le dicen nada y le enseñan a no mirar los avisos.
 *
 *  · `avisarAlAdmin`: lo que tiene que resolver el administrador. Va a
 *    `NTFY_TOPIC` y también a `NTFY_TOPIC_PROGRAMADOR`.
 *  · `avisarAlProgramador`: errores, caídas, respaldos. Solo a
 *    `NTFY_TOPIC_PROGRAMADOR`.
 *
 * Así el del programador recibe todo y el del administrador solo lo suyo. Sin
 * `NTFY_TOPIC_PROGRAMADOR`, lo técnico sigue cayendo en `NTFY_TOPIC` como antes:
 * un .env sin rellenar no deja a nadie sin enterarse de una caída.
 */

/** Segundos que se espera al servidor de avisos. Pasados, se abandona. */
const TIEMPO_LIMITE_MS = 5000;

/**
 * Publica en un tópico, sin bloquear y sin poder tumbar nada.
 *
 * Se llama sin `await` a propósito: quien avisa está en mitad de una petición
 * del comprador, y que su Yape se registre no puede depender de que un
 * servidor de notificaciones responda. Si falla, se registra en el log —donde
 * se mira cuando alguien dice que no le llegó— y se sigue.
 */
function publicar(topico, { titulo, mensaje, etiquetas = [], prioridad = 4, enlace }) {
  const cuerpo = {
    topic: topico,
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

/** Manda el aviso a cada tópico de la lista, sin repetir ni dejar huecos. */
function publicarEn(topicos, aviso, quien) {
  const destinos = [...new Set(topicos.filter(Boolean))];
  if (destinos.length === 0) {
    // Sin tópicos no se llama a nadie, igual que el mailer sin SMTP: el aviso
    // se escribe en el log y en desarrollo eso es lo que hace falta.
    logger.info({ titulo: aviso.titulo, mensaje: aviso.mensaje }, `Aviso al ${quien} (ntfy sin configurar)`);
    return;
  }
  for (const topico of destinos) publicar(topico, aviso);
}

/** Lo que tiene que atender el administrador. Le llega también al programador. */
function avisarAlAdmin(aviso) {
  publicarEn([env.NTFY_TOPIC, env.NTFY_TOPIC_PROGRAMADOR], aviso, 'administrador');
}

/** Lo técnico: errores, caídas, respaldos. El administrador no lo recibe. */
function avisarAlProgramador(aviso) {
  publicarEn([env.NTFY_TOPIC_PROGRAMADOR || env.NTFY_TOPIC], aviso, 'programador');
}

module.exports = { avisarAlAdmin, avisarAlProgramador };
