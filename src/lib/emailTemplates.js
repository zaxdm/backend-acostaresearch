'use strict';

const env = require('../config/env');

/**
 * Marco de todos los correos.
 *
 * Se escribe con tablas y estilos en línea porque los clientes de correo no
 * son navegadores: Outlook ignora flexbox y grid, y muchos borran las hojas de
 * estilo. Lo que aquí parece anticuado es lo único que se ve igual en Gmail,
 * Outlook y el correo del móvil.
 *
 * `preheader` es el texto que Gmail enseña en la bandeja junto al asunto. Sin
 * él, ese hueco lo rellena la primera frase visible —que suele ser el nombre de
 * la marca— y se desperdicia la única línea que decide si alguien abre.
 */
function layout(title, body, { preheader = '' } = {}) {
  const contacto = env.SUPPORT_WHATSAPP_URL
    ? `<a href="${env.SUPPORT_WHATSAPP_URL}" style="color:#1a56db;text-decoration:none">WhatsApp</a> ·`
    : '';

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <title>${title}</title>
  </head>
  <body style="margin:0;padding:0;background:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a2233;-webkit-font-smoothing:antialiased">

    <!-- Vista previa de la bandeja de entrada. Invisible en el mensaje. -->
    <div style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef0f4">
      <tr>
        <td align="center" style="padding:32px 16px">

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">

            <!-- Marca -->
            <tr>
              <td style="padding:0 4px 16px">
                <span style="font-size:17px;font-weight:700;color:#1a2233;letter-spacing:-0.01em">Acosta</span>
                <span style="font-size:17px;font-weight:600;color:#1a56db"> IA &amp; Research</span>
              </td>
            </tr>

            <!-- Contenido -->
            <tr>
              <td style="background:#ffffff;border:1px solid #e2e5ea;border-radius:14px;padding:34px 32px">
                <h1 style="margin:0 0 20px;font-size:21px;line-height:1.3;font-weight:650;color:#1a2233">${title}</h1>
                ${body}
              </td>
            </tr>

            <!-- Pie -->
            <tr>
              <td style="padding:22px 8px 0;font-size:12.5px;line-height:1.7;color:#8b95a6">
                ${contacto}
                <a href="${appUrl()}" style="color:#1a56db;text-decoration:none">acostaresearch.com</a>
                <br />
                Benicio Gonzalo Acosta Enríquez · Trujillo, Perú
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Correo con el código de verificación.
 *
 * El código va también en el ASUNTO. Es lo que permite leerlo desde la lista de
 * mensajes, sin abrir nada, y con eso mucha gente ya puede volver a la pestaña
 * y teclearlo. Cuando el correo tarda, esa diferencia decide si termina el
 * registro o lo deja.
 *
 * Los dígitos van separados en tres grupos: seis cifras seguidas se copian mal
 * de memoria, y el error se descubre después de teclear, cuando ya frustra.
 */
function emailVerificationCode({ firstName, code, expiresInMinutes }) {
  const grupos = code.slice(0, 3) + '<span style="color:#c3cbd8"> · </span>' + code.slice(3);

  return {
    subject: `${code} es tu código de verificación · Acosta Research`,
    text:
      `Hola ${firstName}:

` +
      `Tu código de verificación es: ${code}
` +
      `Caduca en ${expiresInMinutes} minutos y solo se puede usar una vez.

` +
      'Si no creaste esta cuenta, ignora este mensaje.',
    html: layout(
      `Hola ${firstName}, este es tu código`,
      `<p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#52606d">
         Escríbelo en la pantalla de verificación y tu cuenta queda activa.
       </p>

       <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
         <tr>
           <td align="center" style="background:#f2f6fe;border:1px solid #d7e3fb;border-radius:12px;padding:26px 16px">
             <div style="font-size:38px;font-weight:700;letter-spacing:.14em;color:#1a3fa8;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif">${grupos}</div>
             <div style="margin-top:10px;font-size:12.5px;color:#7b8794">Caduca en ${expiresInMinutes} minutos</div>
           </td>
         </tr>
       </table>

       <p style="margin:22px 0 0;font-size:13.5px;line-height:1.65;color:#7b8794">
         Solo se puede usar una vez. Si no creaste esta cuenta, ignora este mensaje: sin el
         código no se llega a crear nada.
       </p>`,
      { preheader: `Tu código es ${code}. Caduca en ${expiresInMinutes} minutos.` },
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

/** Importe en soles, para los correos del pago manual. */
function soles(cents) {
  return `S/ ${(cents / 100).toFixed(2)}`;
}

/**
 * Aviso al administrador: hay un comprobante de Yape esperando.
 *
 * Va con todo lo que hace falta para decidir —quién, qué plan, cuánto y qué
 * número de operación— porque quien lo lee suele estar en el móvil: si el
 * correo obliga a abrir el panel para saber siquiera de qué va, el comprador
 * espera más.
 */
function manualPaymentReceived({ buyer, planName, amountCents, operationCode, paymentId }) {
  const enlace = `${appUrl()}/admin?seccion=yape`;
  const operacion = operationCode || 'no lo indicó';

  return {
    subject: `Yape por revisar: ${buyer.firstName} · ${soles(amountCents)} · ${planName}`,
    text: [
      'Hay un comprobante esperando revisión.',
      '',
      `Comprador:  ${buyer.firstName} ${buyer.lastName} <${buyer.email}>`,
      `Plan:       ${planName}`,
      `Importe:    ${soles(amountCents)}`,
      `Operación:  ${operacion}`,
      `Pago:       ${paymentId}`,
      '',
      `Revísalo aquí: ${enlace}`,
    ].join('\n'),
    html: layout(
      'Un Yape esperando revisión',
      `<p style="margin:0 0 18px;font-size:15px;line-height:1.6">
         <strong>${buyer.firstName} ${buyer.lastName}</strong> dice haber pagado
         <strong>${soles(amountCents)}</strong> por «${planName}».
       </p>
       <table role="presentation" cellpadding="0" cellspacing="0"
              style="margin:0 0 22px;font-size:14px;color:#52606d">
         <tr><td style="padding:3px 14px 3px 0">Correo</td><td>${buyer.email}</td></tr>
         <tr><td style="padding:3px 14px 3px 0">Nº de operación</td><td>${operacion}</td></tr>
         <tr><td style="padding:3px 14px 3px 0">Pago</td><td>${paymentId}</td></tr>
       </table>
       <p style="margin:0 0 18px;font-size:14px;line-height:1.6">
         Compruébalo contra tu Yape antes de aprobarlo: la captura demuestra que existe una
         pantalla, no que el dinero haya entrado.
       </p>
       <p style="margin:0;font-size:14px">
         <a href="${enlace}" style="color:#1a56db">Ver el comprobante</a>
       </p>`,
    ),
  };
}

/**
 * Al comprador: su pago quedó aprobado.
 *
 * NO lleva la URL del conector. Un correo se reenvía, se queda en la bandeja y
 * pasa por servidores que no son nuestros; esa URL es la credencial completa
 * del acceso. Se le manda a su panel, que es donde puede generarla él.
 */
function manualPaymentApproved({ firstName, planName, esLicencia }) {
  const enlace = `${appUrl()}/perfil`;
  // La guía SÍ puede viajar por correo: no es una credencial, es un manual.
  // Explica cómo instalar el conector, no da acceso a ninguno.
  const guia = `${appUrl()}/guias/guia-instalacion.pdf`;

  const siguiente = esLicencia
    ? 'Entra en tu panel y pulsa «Nueva URL» en tu licencia: esa es la dirección que se conecta a tu Claude.'
    : 'Ya tienes las palabras cargadas en tu cuenta. Puedes empezar cuando quieras.';

  return {
    subject: 'Pago confirmado · Acosta Research',
    text: [
      `Hola ${firstName}:`,
      '',
      `Hemos comprobado tu pago de «${planName}» y tu acceso ya está activo.`,
      '',
      siguiente,
      '',
      `Tu panel: ${enlace}`,
      ...(esLicencia ? ['', `Guía de instalación (PDF): ${guia}`] : []),
    ].join('\n'),
    html: layout(
      'Pago confirmado',
      `<p style="margin:0 0 14px;font-size:15px;line-height:1.6">Hola ${firstName}: hemos
         comprobado tu pago de <strong>${planName}</strong> y tu acceso ya está activo.</p>
       <p style="margin:0 0 22px;font-size:15px;line-height:1.6">${siguiente}</p>
       <p style="margin:0 0 12px;font-size:14px">
         <a href="${enlace}" style="color:#1a56db">Abrir mi panel</a>
       </p>
       ${
         esLicencia
           ? `<p style="margin:0;font-size:14px">
         <a href="${guia}" style="color:#1a56db">Descargar la guía de instalación (PDF)</a>
       </p>`
           : ''
       }`,
    ),
  };
}

/**
 * Al comprador: no pudimos dar el pago por bueno.
 *
 * El motivo lo escribe el administrador y se le enseña tal cual, así que el
 * correo no lo adorna: lo que hace falta es que sepa exactamente qué corregir.
 */
function manualPaymentRejected({ firstName, planName, motivo }) {
  const enlace = `${appUrl()}/checkout`;

  return {
    subject: 'No pudimos confirmar tu pago · Acosta Research',
    text: [
      `Hola ${firstName}:`,
      '',
      `Revisamos el comprobante que enviaste para «${planName}» y no hemos podido darlo por bueno.`,
      '',
      `Motivo: ${motivo}`,
      '',
      'No se te ha cobrado nada por nuestra parte. Si crees que es un error, respóndenos y lo miramos.',
      '',
      `Volver a intentarlo: ${enlace}`,
    ].join('\n'),
    html: layout(
      'No pudimos confirmar tu pago',
      `<p style="margin:0 0 14px;font-size:15px;line-height:1.6">Hola ${firstName}: revisamos el
         comprobante que enviaste para <strong>${planName}</strong> y no hemos podido darlo
         por bueno.</p>
       <p style="margin:0 0 18px;padding:14px 16px;background:#fdf1f1;border-radius:10px;
                 font-size:14px;line-height:1.6;color:#8b2c2c">${motivo}</p>
       <p style="margin:0 0 22px;font-size:14px;line-height:1.6;color:#52606d">
         Por nuestra parte no se te ha cobrado nada. Si crees que es un error, respóndenos a este
         mensaje y lo miramos contigo.
       </p>
       <p style="margin:0;font-size:14px">
         <a href="${enlace}" style="color:#1a56db">Volver a intentarlo</a>
       </p>`,
    ),
  };
}

module.exports = {
  emailVerificationCode,
  licenseAlert,
  manualPaymentReceived,
  manualPaymentApproved,
  manualPaymentRejected,
  appUrl,
};
