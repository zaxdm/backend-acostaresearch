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

function emailVerification({ firstName, verificationUrl, expiresInHours }) {
  return {
    subject: 'Confirma tu correo · Acosta Research',
    text:
      `Hola ${firstName}:\n\n` +
      `Confirma tu correo abriendo este enlace (válido ${expiresInHours} horas):\n${verificationUrl}\n\n` +
      'Si no creaste esta cuenta, puedes ignorar este mensaje.',
    html: layout(
      `Hola ${firstName}, confirma tu correo`,
      `<p style="margin:0 0 24px;font-size:14px;line-height:22px">
         Para activar tu cuenta en Acosta Research confirma tu dirección de correo.
         El enlace caduca en ${expiresInHours} horas.
       </p>
       <p style="margin:0 0 24px">
         <a href="${verificationUrl}"
            style="display:inline-block;background:#1a56db;color:#ffffff;text-decoration:none;
                   padding:12px 22px;border-radius:8px;font-size:14px;font-weight:600">
           Confirmar mi correo
         </a>
       </p>
       <p style="margin:0;font-size:12px;color:#616e7c;word-break:break-all">
         Si el botón no funciona, copia este enlace: ${verificationUrl}
       </p>`,
    ),
  };
}

function buildVerificationUrl(token) {
  const url = new URL('/auth/verificar-email', env.APP_URL);
  url.searchParams.set('token', token);
  return url.toString();
}

module.exports = { emailVerification, buildVerificationUrl };
