'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const prisma = require('../../lib/prisma');
const { sendMail } = require('../../lib/mailer');
const { avisarAlAdmin } = require('../../lib/notify');
const { layout, escapar, appUrl } = require('../../lib/emailTemplates');

/**
 * Los rebotes de Brevo: un correo que salió y no llegó porque la cuenta no
 * existe.
 *
 * Antes de vender se pregunta por el buzón (`shared/utils/correo`), pero eso
 * tiene huecos: ZeroBounce da 100 comprobaciones al mes, y hay servidores que
 * aceptan cualquier dirección o no contestan. Lo que se escapa por ahí rebota,
 * y Brevo lo cuenta por este webhook. El administrador se entera en segundos y
 * corrige el correo con el comprador, en vez de enterarse cuando el comprador
 * escribe días después que nunca le llegó su acceso.
 *
 * Al móvil va el correo a medias —el tópico de ntfy no es privado, ver
 * `lib/notify`—; el correo al administrador lo lleva entero.
 */

/** Los eventos que dicen «no llegó ni va a llegar». El rebote suave se reintenta solo. */
const EVENTOS = {
  hard_bounce: 'La cuenta no existe o el servidor rechazó el correo para siempre.',
  invalid_email: 'La dirección no es válida.',
  blocked: 'Brevo ya no le manda nada a esta dirección porque rebotó antes.',
};

/** Seis horas: un registro que reintenta no puede llenar el móvil de avisos. */
const SILENCIO_MS = 6 * 60 * 60 * 1000;
const avisados = new Map();

/** `juan1234@gmail.com` → `ju…34@gmail.com`: basta para reconocerlo, no para leerlo. */
function aMedias(correo) {
  const [usuario, dominio] = String(correo).split('@');
  if (!dominio) return '…';
  const visible = usuario.length > 4 ? `${usuario.slice(0, 2)}…${usuario.slice(-2)}` : `${usuario[0] ?? ''}…`;
  return `${visible}@${dominio}`;
}

async function correoDelAdministrador() {
  if (env.ADMIN_NOTIFY_EMAIL) return env.ADMIN_NOTIFY_EMAIL;
  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN', status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    select: { email: true },
  });
  return admin?.email ?? null;
}

function correoRebotado({ email, nombre, asunto, motivo, explicacion, cuando }) {
  const enlace = `${appUrl()}/perfil`;
  const titulo = 'Un correo no llegó';
  const quien = nombre ? `${nombre} <${email}>` : email;

  return {
    subject: `${titulo}: ${email}`,
    text: [
      titulo,
      '',
      `Para:    ${quien}`,
      `Asunto:  ${asunto || '(sin asunto)'}`,
      `Cuándo:  ${cuando || '—'}`,
      '',
      explicacion,
      ...(motivo ? ['', `Lo que dijo su servidor: ${motivo}`] : []),
      '',
      'Si era una compra, confirma el correo con el comprador y vuelve a mandarle el acceso.',
      '',
      `Panel: ${enlace}`,
    ].join('\n'),
    html: layout(
      titulo,
      `<p style="margin:0 0 14px;font-size:15px;line-height:1.6">
         El correo <strong>«${escapar(asunto || 'sin asunto')}»</strong> no le llegó a
         <strong>${escapar(quien)}</strong>.
       </p>
       <p style="margin:0 0 14px;font-size:15px;line-height:1.6">${escapar(explicacion)}</p>
       ${
         motivo
           ? `<p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:#52606d">
                Lo que dijo su servidor: ${escapar(motivo)}</p>`
           : ''
       }
       <p style="margin:0;padding:14px 16px;background:#fdf3e3;border-radius:10px;
                 font-size:14px;line-height:1.6;color:#96590d">
         Si era una compra, confirma el correo con el comprador letra por letra y vuelve a
         mandarle el acceso.
       </p>
       <p style="margin:18px 0 0;font-size:14px">
         <a href="${enlace}" style="color:#1a56db">Abrir el panel</a>
       </p>`,
    ),
  };
}

/**
 * Procesa lo que mandó Brevo: un evento suelto o, con «batched», una lista.
 * Devuelve cuántos avisos salieron. Nunca lanza por un evento raro.
 */
async function procesarEventos(
  cuerpo,
  {
    ahora = Date.now,
    silencio = avisados,
    buscarUsuario = (email) =>
      prisma.user.findUnique({ where: { email }, select: { firstName: true, lastName: true } }),
    destinoAdmin = correoDelAdministrador,
    mandar = sendMail,
    avisar = avisarAlAdmin,
  } = {},
) {
  const eventos = Array.isArray(cuerpo) ? cuerpo : [cuerpo];
  let avisos = 0;

  for (const evento of eventos) {
    const tipo = String(evento?.event ?? '').toLowerCase();
    const email = String(evento?.email ?? '').trim().toLowerCase();
    if (!EVENTOS[tipo] || !email.includes('@')) continue;

    const ultimo = silencio.get(email);
    if (ultimo && ahora() - ultimo < SILENCIO_MS) continue;
    silencio.set(email, ahora());

    const usuario = await buscarUsuario(email).catch(() => null);
    const nombre = usuario ? `${usuario.firstName ?? ''} ${usuario.lastName ?? ''}`.trim() : '';
    const asunto = String(evento.subject ?? '').slice(0, 200);
    const motivo = String(evento.reason ?? '').slice(0, 300);

    logger.warn({ evento: tipo, asunto }, 'Brevo avisó que un correo no llegó');

    avisar({
      titulo: 'Un correo no llegó',
      mensaje: [
        `${usuario?.firstName ?? 'Destinatario'} · ${aMedias(email)}`,
        asunto ? `«${asunto}»` : null,
        'El detalle está en tu correo.',
      ]
        .filter(Boolean)
        .join('\n'),
      etiquetas: ['email', 'warning'],
    });

    const destino = await destinoAdmin().catch(() => null);
    // Si el que rebota es el propio administrador, avisarle por correo
    // volvería a rebotar y Brevo lo contaría otra vez: basta con el móvil.
    if (destino && destino.toLowerCase() !== email) {
      mandar({
        to: destino,
        ...correoRebotado({
          email,
          nombre,
          asunto,
          motivo,
          explicacion: EVENTOS[tipo],
          cuando: evento.date ? String(evento.date) : '',
        }),
      }).catch((error) => logger.error({ err: error }, 'No salió el aviso de rebote al administrador'));
    }
    avisos += 1;
  }
  return avisos;
}

module.exports = { procesarEventos, aMedias, EVENTOS };
