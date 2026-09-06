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
 * Fecha larga en español, para el comprador. `null` = sin caducidad.
 *
 * Se fija la zona horaria de Lima en vez de dejar la del servidor: una
 * caducidad guardada a medianoche se leería un día antes o después según dónde
 * corra el proceso, y el comprador está en Perú aunque el VPS esté en Alemania.
 * Es la misma hora con la que `license.limits` cuenta los días.
 */
function fecha(valor) {
  if (!valor) return null;
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) return null;

  try {
    return d.toLocaleDateString('es-PE', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'America/Lima',
    });
  } catch {
    // Si el Node de turno viniera sin datos de idioma, mejor una fecha fea que
    // un correo roto.
    return d.toISOString().slice(0, 10);
  }
}

/**
 * Cómo empieza un correo de entrega según de dónde vino la compra.
 *
 * Un Yape se aprueba a mano y horas después, así que ahí la frase tiene que
 * decir que ya lo comprobamos: es la respuesta a una espera. En una pasarela el
 * cobro fue instantáneo, y en un canje no hubo cobro ninguno.
 *
 * Devuelve la frase en minúscula porque casi siempre va detrás de «Hola
 * Fulano:». Cuando abre párrafo, `enMayuscula` la ajusta.
 */
function confirmacionDePago(via, planName) {
  const producto = `«${planName}»`;

  if (via === 'yape') return `hemos comprobado tu pago de ${producto}`;
  if (via === 'codigo') return `hemos activado tu código de ${producto}`;
  return `hemos confirmado tu pago de ${producto}`;
}

/** Primera letra en mayúscula, para cuando la frase abre la oración. */
function enMayuscula(frase) {
  return frase.charAt(0).toUpperCase() + frase.slice(1);
}

/**
 * Al comprador: su acceso al método está activo, con la URL del conector.
 *
 * La URL viaja por correo aun siendo la credencial completa del acceso, y es
 * una decisión, no un descuido. La alternativa —mandarlo al panel a generarla
 * él— mete un paso justo en el momento en que acaba de pagar; y quien paga por
 * Yape ni siquiera está delante de la pantalla cuando aprobamos el
 * comprobante, así que el correo es la única superficie que le alcanza.
 *
 * Lo que hace asumible el riesgo es que rotarla es gratis y está a un botón:
 * si el correo se reenvía sin pensar, «Nueva URL» invalida la anterior al
 * instante.
 *
 * El aviso de «guárdala» no es una fórmula de cortesía: del token solo se
 * guarda su SHA-256, así que este correo es —junto al Claude del comprador— el
 * único sitio del mundo donde esa URL existe.
 */
function licenseReady({ firstName, planName, connectorUrl, expiresAt, via }) {
  const panel = `${appUrl()}/perfil`;
  const guia = `${appUrl()}/guias/guia-instalacion.pdf`;
  const vence = fecha(expiresAt);
  const vigencia = vence ? `Lo tienes hasta el ${vence}.` : 'No caduca.';
  const confirmacion = confirmacionDePago(via, planName);

  return {
    subject: 'Tu acceso al método está activo · Acosta Research',
    // El preheader repite que la URL va dentro. Es lo que hace que este correo
    // se reconozca dentro de un mes, buscando «url» en la bandeja.
    text: [
      `Hola ${firstName}:`,
      '',
      `${enMayuscula(confirmacion)} y tu acceso ya está activo. ${vigencia}`,
      '',
      'Esta es tu URL personal del conector:',
      '',
      connectorUrl,
      '',
      // Sin cortar la frase a mitad: el cliente de correo ya envuelve solo, y
      // una línea partida a mano no se encuentra al buscar en la bandeja.
      'GUÁRDALA. Por seguridad no la almacenamos en claro, así que no podemos volver a enviártela. Si la pierdes, genera una nueva desde tu panel.',
      '',
      'Cómo conectarla a Claude:',
      '  1. Abre Claude y entra en Configuración → Conectores.',
      '  2. Pulsa «Añadir conector personalizado» y pega la URL de arriba.',
      '  3. Escríbele «trabajemos mi tesis» y pídele que use el conector.',
      '',
      `Guía de instalación con capturas (PDF): ${guia}`,
      `Tu panel: ${panel}`,
      '',
      'Esta licencia es individual. Compartir la URL puede provocar que se desactive.',
    ].join('\n'),
    html: layout(
      'Tu acceso al método está activo',
      `<p style="margin:0 0 20px;font-size:15px;line-height:1.6">Hola ${firstName}:
         ${confirmacion} y tu acceso ya está activo. ${vigencia}</p>

       <p style="margin:0 0 8px;font-size:13px;font-weight:650;color:#52606d">
         TU URL PERSONAL DEL CONECTOR
       </p>
       <p style="margin:0 0 14px;padding:14px 16px;background:#101a2e;border-radius:10px;
                 font-family:Consolas,'Courier New',monospace;font-size:13px;line-height:1.5;
                 color:#dbe6ff;word-break:break-all">${connectorUrl}</p>

       <p style="margin:0 0 24px;padding:12px 16px;background:#fdf3e3;border-radius:10px;
                 font-size:13.5px;line-height:1.6;color:#96590d">
         <strong>Guárdala.</strong> Por seguridad no la almacenamos en claro, así que no podemos
         volver a enviártela. Si la pierdes, generas una nueva desde tu panel en un segundo.
       </p>

       <p style="margin:0 0 10px;font-size:15px;font-weight:650">Cómo conectarla a Claude</p>
       <table role="presentation" cellpadding="0" cellspacing="0" border="0"
              style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#52606d">
         <tr>
           <td style="padding:0 10px 8px 0;color:#1a56db;font-weight:700">1</td>
           <td style="padding:0 0 8px">Abre Claude y entra en <strong>Configuración → Conectores</strong>.</td>
         </tr>
         <tr>
           <td style="padding:0 10px 8px 0;color:#1a56db;font-weight:700">2</td>
           <td style="padding:0 0 8px">Pulsa <strong>Añadir conector personalizado</strong> y pega la URL de arriba.</td>
         </tr>
         <tr>
           <td style="padding:0 10px 0 0;color:#1a56db;font-weight:700">3</td>
           <td>Escríbele «trabajemos mi tesis» y pídele que use el conector.</td>
         </tr>
       </table>

       <p style="margin:0 0 10px;font-size:14px">
         <a href="${guia}" style="color:#1a56db">Descargar la guía de instalación (PDF)</a>
       </p>
       <p style="margin:0 0 22px;font-size:14px">
         <a href="${panel}" style="color:#1a56db">Abrir mi panel</a>
       </p>

       <p style="margin:0;font-size:13px;line-height:1.6;color:#8b95a6">
         Esta licencia es individual. Compartir la URL puede provocar que se desactive.
       </p>`,
      { preheader: 'Dentro va tu URL personal del conector. Guárdala: no podemos reenviártela.' },
    ),
  };
}

/**
 * Al comprador: renovó, y su acceso se alargó.
 *
 * Este correo NO lleva URL, y no por prudencia: es que no existe una nueva.
 * Renovar alarga la misma licencia y conserva el token, precisamente para que
 * no tenga que reinstalar el conector cada trimestre. Mandarle una dirección
 * aquí —aunque fuera la misma— le haría pensar que la que tiene dejó de
 * servir, y acabaría reinstalando sin necesidad.
 */
function licenseRenewed({ firstName, planName, expiresAt, via }) {
  const panel = `${appUrl()}/perfil`;
  const vence = fecha(expiresAt);
  const hasta = vence ? `hasta el ${vence}` : 'sin fecha de caducidad';
  const confirmacion = confirmacionDePago(via, planName);

  return {
    subject: 'Tu acceso al método se renovó · Acosta Research',
    text: [
      `Hola ${firstName}:`,
      '',
      `${enMayuscula(confirmacion)}. Tu acceso queda ampliado ${hasta}.`,
      '',
      'No tienes que tocar nada en Claude: sigue funcionando la misma URL que ya tienes instalada. No hace falta volver a añadir el conector.',
      '',
      `Tu panel: ${panel}`,
    ].join('\n'),
    html: layout(
      'Tu acceso se renovó',
      `<p style="margin:0 0 18px;font-size:15px;line-height:1.6">Hola ${firstName}:
         ${confirmacion}. Tu acceso queda
         ampliado <strong>${hasta}</strong>.</p>

       <p style="margin:0 0 22px;padding:14px 16px;background:#e7f6ef;border-radius:10px;
                 font-size:14px;line-height:1.6;color:#12734b">
         <strong>No tienes que tocar nada en Claude.</strong> Sigue funcionando la misma URL que
         ya tienes instalada; no hace falta volver a añadir el conector.
       </p>

       <p style="margin:0;font-size:14px">
         <a href="${panel}" style="color:#1a56db">Abrir mi panel</a>
       </p>`,
      { preheader: 'Tu acceso queda ampliado. La URL que ya tienes instalada sigue sirviendo.' },
    ),
  };
}

/**
 * Al comprador: su bolsa de palabras ya está cargada.
 *
 * Antes este correo solo salía en los pagos por Yape. Ahora sale también en los
 * de pasarela, que hasta hoy no recibían nada: quien pagaba con PayPal se
 * quedaba sin una sola línea en su bandeja que demostrara la compra.
 */
function wordsReady({ firstName, planName, words, expiresAt, via }) {
  const enlace = `${appUrl()}/humanizador`;
  const vence = fecha(expiresAt);
  const caduca = vence ? ` Puedes usarlas hasta el ${vence}.` : '';
  const cantidad = new Intl.NumberFormat('es-PE').format(words);
  const confirmacion = confirmacionDePago(via, planName);

  return {
    subject: 'Tu bolsa de palabras está activa · Acosta Research',
    text: [
      `Hola ${firstName}:`,
      '',
      `${enMayuscula(confirmacion)} y ya tienes ${cantidad} palabras cargadas en tu cuenta.${caduca}`,
      '',
      `Empezar a usarlas: ${enlace}`,
    ].join('\n'),
    html: layout(
      'Tu bolsa de palabras está activa',
      `<p style="margin:0 0 20px;font-size:15px;line-height:1.6">Hola ${firstName}:
         ${confirmacion} y ya tienes
         <strong>${cantidad} palabras</strong> cargadas en tu cuenta.${caduca}</p>

       <p style="margin:0;font-size:14px">
         <a href="${enlace}" style="color:#1a56db">Empezar a usarlas</a>
       </p>`,
      { preheader: `${cantidad} palabras cargadas en tu cuenta.` },
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

/**
 * Al comprador que pagó fuera de la web: aquí está tu código de activación.
 *
 * Es el correo de quien pagó por Western Union, por transferencia o por un Yape
 * que llegó al WhatsApp, y todavía no tiene cuenta. No puede recibir la URL del
 * conector —esa nace al canjear, y el canje necesita una cuenta—, así que lo que
 * recibe es el código y el camino para llegar a ella.
 *
 * EL CÓDIGO VA TAMBIÉN EN EL ASUNTO
 * ----------------------------------
 * Por lo mismo que el de verificación: entre que se paga y se crea la cuenta
 * pasan horas o días, y este correo se busca en la bandeja mucho después. Con
 * el código en el asunto se encuentra sin abrir nada.
 *
 * EL ORDEN DE LOS PASOS IMPORTA
 * ------------------------------
 * Primero crear la cuenta, después canjear. Al revés no existe: el código se
 * pega en el perfil, y al perfil solo se entra con sesión iniciada. Decirlo en
 * ese orden evita el mensaje de «no encuentro dónde meterlo».
 */
function activationCode({ codes, planName, expiresAt }) {
  const registro = `${appUrl()}/auth/registro`;
  const panel = `${appUrl()}/perfil`;
  const vence = fecha(expiresAt);
  const caduca = vence ? ` Tienes hasta el ${vence} para canjearlo.` : '';
  const varios = codes.length > 1;
  const titulo = varios ? 'Tus códigos de activación' : 'Tu código de activación';

  const bloques = codes
    .map(
      (codigo) => `<tr>
           <td align="center" style="background:#f2f6fe;border:1px solid #d7e3fb;border-radius:12px;
                     padding:22px 16px">
             <div style="font-family:Consolas,'Courier New',monospace;font-size:23px;font-weight:700;
                         letter-spacing:.06em;color:#1a3fa8;word-break:break-all">${codigo}</div>
           </td>
         </tr>
         <tr><td style="height:10px;line-height:10px">&nbsp;</td></tr>`,
    )
    .join('');

  return {
    // Con un solo código —que es el caso normal— va en el asunto. Con varios no
    // cabe, y quien compra un lote no lo busca de memoria.
    subject: varios
      ? `${titulo} · Acosta Research`
      : `${codes[0]} es tu código de activación · Acosta Research`,
    text: [
      'Hola:',
      '',
      `Recibimos tu pago de «${planName}». Este es tu código de activación:`,
      '',
      ...codes.map((codigo) => `  ${codigo}`),
      '',
      `Guárdalo: es de un solo uso y no podemos volver a mostrártelo.${caduca}`,
      '',
      'Cómo activarlo, en dos pasos:',
      `  1. Crea tu cuenta en ${registro} (te pedimos un código de 6 cifras por correo para verificarla).`,
      `  2. Entra en tu perfil, ${panel}, pega el código en «¿Compraste por Yape o transferencia?» y pulsa Canjear.`,
      '',
      'En cuanto lo canjees te llega otro correo con tu URL personal del conector, que es lo que se pega en Claude.',
      '',
      'Si algo no te cuadra, respóndenos a este mensaje.',
    ].join('\n'),
    html: layout(
      titulo,
      `<p style="margin:0 0 20px;font-size:15px;line-height:1.6">Hola: recibimos tu pago de
         <strong>${planName}</strong>. ${varios ? 'Estos son tus códigos' : 'Este es tu código'}
         de activación.</p>

       <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
         ${bloques}
       </table>

       <p style="margin:12px 0 24px;font-size:13.5px;line-height:1.65;color:#7b8794">
         Guárda${varios ? 'los' : 'lo'}: ${varios ? 'son de un solo uso' : 'es de un solo uso'} y
         no podemos volver a mostrár${varios ? 'telos' : 'telo'}.${caduca}
       </p>

       <p style="margin:0 0 10px;font-size:13px;font-weight:650;color:#52606d">
         CÓMO ACTIVARLO, EN DOS PASOS
       </p>
       <p style="margin:0 0 10px;font-size:14.5px;line-height:1.65">
         <strong>1.</strong> Crea tu cuenta en
         <a href="${registro}" style="color:#1a56db">acostaresearch.com</a>. Te pedimos un código
         de 6 cifras por correo para verificarla.
       </p>
       <p style="margin:0 0 22px;font-size:14.5px;line-height:1.65">
         <strong>2.</strong> Entra en <a href="${panel}" style="color:#1a56db">tu perfil</a>, pega
         el código en «¿Compraste por Yape o transferencia?» y pulsa Canjear.
       </p>

       <p style="margin:0 0 18px;font-size:14px;line-height:1.65;color:#52606d">
         En cuanto lo canjees te llega otro correo con tu URL personal del conector, que es lo que
         se pega en Claude.
       </p>

       <p style="margin:0;font-size:13.5px;line-height:1.65;color:#7b8794">
         Si algo no te cuadra, responde a este mensaje y lo miramos.
       </p>`,
      {
        preheader: varios
          ? `${codes.length} códigos de activación de ${planName}.`
          : `Tu código es ${codes[0]}. Se canjea desde tu perfil.`,
      },
    ),
  };
}

module.exports = {
  emailVerificationCode,
  licenseAlert,
  manualPaymentReceived,
  // Los tres de entrega salen de `payment.delivery`, que es el punto por donde
  // pasan por igual la pasarela y la aprobación de un Yape.
  licenseReady,
  licenseRenewed,
  wordsReady,
  manualPaymentRejected,
  // Al comprador que pagó fuera de la web y todavía no tiene cuenta.
  activationCode,
  appUrl,
};
