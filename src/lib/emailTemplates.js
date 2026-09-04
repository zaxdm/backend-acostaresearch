'use strict';

const env = require('../config/env');

function layout(title, body) {
  return `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:32px;background:#f4f5f7;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#1f2933">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:12px;padding:32px">
          <tr><td>
            <p style="margin:0 0 18px;font-size:12px;font-weight:700;letter-spacing:.09em;
                      text-transform:uppercase;color:#1a56db">Acosta Research</p>
            <h1 style="margin:0 0 16px;font-size:20px">${title}</h1>
            ${body}
            <p style="margin:32px 0 0;font-size:12px;color:#7b8794">
              Acosta Research · Este es un mensaje automático, no respondas a este correo.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

/**
 * Correo con el código de verificación. El código va en el asunto además del
 * cuerpo, para que se lea desde la bandeja de entrada sin abrir el mensaje.
 */
function emailVerificationCode({ firstName, code, expiresInMinutes }) {
  return {
    subject: `${code} es tu código de verificación · Acosta Research`,
    text:
      `Hola ${firstName}:\n\n` +
      `Tu código de verificación es: ${code}\n` +
      `Caduca en ${expiresInMinutes} minutos y solo se puede usar una vez.\n\n` +
      'Si no creaste esta cuenta, ignora este mensaje.',
    html: layout(
      `Hola ${firstName}, este es tu código`,
      `<p style="margin:0 0 24px;font-size:14px;line-height:22px">
         Escribe este código en la pantalla de verificación para activar tu cuenta.
       </p>
       <p style="margin:0 0 24px;padding:18px;text-align:center;background:#eaf0fd;
                 border-radius:10px;font-size:34px;font-weight:700;letter-spacing:.32em;
                 color:#1a3fa8">${code}</p>
       <p style="margin:0;font-size:13px;color:#616e7c">
         Caduca en ${expiresInMinutes} minutos y solo se puede usar una vez.
         Si no creaste esta cuenta, ignora este mensaje.
       </p>`,
    ),
  };
}

/** Enlace a la aplicación, para el pie de los correos. */
function appUrl() {
  return env.APP_URL;
}

/**
 * Aviso de uso anómalo en una licencia del conector.
 *
 * El tono importa: la mayoría de las veces esto le llega a alguien que no ha
 * hecho nada malo —trabaja desde dos equipos, o le tocó una semana de entrega—.
 * Se le avisa y se le da salida, no se le acusa.
 */
function licenseAlert({ firstName, motivos, revocada }) {
  const lista = motivos.map((m) => `<li style="margin:0 0 6px">${m}</li>`).join('');

  const cuerpo = revocada
    ? `<p style="margin:0 0 14px;font-size:15px;line-height:1.6">Hola ${firstName}: hemos
         desactivado temporalmente el acceso de tu licencia al conector, porque el patrón de uso
         sugiere que la URL se está usando desde varias personas a la vez.</p>
       <p style="margin:0 0 14px;font-size:15px;line-height:1.6">Si es un error, respóndenos y
         te la reactivamos el mismo día. No pierdes nada de lo que ya trabajaste.</p>`
    : `<p style="margin:0 0 14px;font-size:15px;line-height:1.6">Hola ${firstName}: hemos
         detectado un uso poco habitual en tu licencia. Todavía no hemos tocado nada, es solo
         un aviso.</p>
       <p style="margin:0 0 14px;font-size:15px;line-height:1.6">Si has compartido tu URL con
         alguien, genera una nueva desde tu panel: la anterior deja de funcionar al instante.</p>`;

  return {
    subject: revocada
      ? 'Tu licencia quedó desactivada · Acosta Research'
      : 'Uso poco habitual en tu licencia · Acosta Research',
    text: [
      `Hola ${firstName}:`,
      '',
      revocada
        ? 'Hemos desactivado temporalmente tu licencia del conector por un patrón de uso que sugiere que se está compartiendo. Si es un error, respóndenos y la reactivamos el mismo día.'
        : 'Hemos detectado un uso poco habitual en tu licencia. Todavía no hemos tocado nada. Si compartiste tu URL, genera una nueva desde tu panel.',
      '',
      'Lo que vimos:',
      ...motivos.map((m) => `  · ${m}`),
    ].join('\n'),
    html: layout(revocada ? 'Licencia desactivada' : 'Uso poco habitual', `
      ${cuerpo}
      <ul style="margin:0 0 18px;padding-left:20px;font-size:14px;color:#52606d">${lista}</ul>
      <p style="margin:0;font-size:14px">
        <a href="${appUrl()}" style="color:#1a56db">Abrir mi panel</a>
      </p>`),
  };
}

module.exports = { emailVerificationCode, licenseAlert, appUrl };
