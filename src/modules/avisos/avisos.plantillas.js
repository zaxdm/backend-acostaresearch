'use strict';

const { layout, escapar, fecha, appUrl } = require('../../lib/emailTemplates');

/**
 * Los correos según el avance del tesista. Viven aquí y no en
 * `lib/emailTemplates` porque solo los manda `avisos.service`.
 *
 * El tono es el de un compañero que se acuerda de ti, no el de un cobrador: la
 * mayoría de quienes se paran lo hacen por la semana de exámenes o el trabajo,
 * no porque el método no les sirva. Cada correo dice UNA cosa que hacer, con
 * las palabras exactas que tiene que escribirle a Claude.
 *
 * Todos llevan al pie cómo dejar de recibirlos: sin eso Gmail acaba mandando
 * al spam también los correos de compra, que salen del mismo remitente.
 */

const P = 'margin:0 0 18px;font-size:15px;line-height:1.6';
const CAJA =
  'margin:0 0 22px;padding:14px 16px;background:#eef3ff;border-radius:10px;' +
  'font-size:14.5px;line-height:1.6;color:#1a3a8a';
const BOTON =
  'display:inline-block;padding:11px 20px;background:#1a56db;color:#ffffff;' +
  'border-radius:9px;text-decoration:none;font-weight:600';

/** «tu tesis» → «mi tesis»: lo que el tesista le escribe a Claude. */
function enPrimera(obra) {
  return String(obra).replace(/^tu /, 'mi ');
}

function boton(href, texto) {
  return `<p style="margin:0 0 14px;font-size:14px"><a href="${href}" style="${BOTON}">${escapar(texto)}</a></p>`;
}

function pieDeBaja(baja) {
  return `<p style="margin:22px 0 0;font-size:12.5px;line-height:1.6;color:#8b95a6">
    Te escribimos porque tienes el método activo. Si prefieres no recibir estos recordatorios,
    <a href="${baja}" style="color:#8b95a6;text-decoration:underline">desactívalos aquí</a>.
    Los correos de tus compras te seguirán llegando.</p>`;
}

function armar({ asunto, titulo, preheader, parrafos, caja, accion, baja }) {
  const texto = [
    ...parrafos,
    caja ? `→ ${caja}` : null,
    accion ? `${accion.texto}: ${accion.href}` : null,
    '',
    `No quiero más recordatorios: ${baja}`,
  ].filter((linea) => linea !== null);

  const html = [
    ...parrafos.map((p) => `<p style="${P}">${escapar(p)}</p>`),
    caja ? `<p style="${CAJA}">${escapar(caja)}</p>` : '',
    accion ? boton(accion.href, accion.texto) : '',
    pieDeBaja(baja),
  ].join('\n');

  return {
    subject: `${asunto} · Acosta Research`,
    text: texto.join('\n\n'),
    html: layout(escapar(titulo), html, { preheader: escapar(preheader) }),
  };
}

/** Compró hace unos días y todavía no ha conectado Claude. */
function sinConectar({ firstName, planName, obra, dias, baja }) {
  return armar({
    asunto: 'Tu método está listo y aún no lo has estrenado',
    titulo: 'Te falta un paso para empezar',
    preheader: 'Conectar Claude lleva unos dos minutos. Te decimos cómo.',
    parrafos: [
      `Hola ${firstName}:`,
      `Hace ${dias} días que tienes ${planName}, pero todavía no has conectado Claude. Sin ese paso el método no puede ayudarte.`,
      'Es pegar una URL en Claude una sola vez. Tu URL del conector está en tu panel, y la guía te lleva con capturas.',
    ],
    caja: `Cuando esté conectado, abre un chat nuevo en Claude y escribe: «empecemos ${enPrimera(obra)}».`,
    accion: { href: `${appUrl()}/guias-de-instalacion`, texto: 'Ver cómo conectarlo' },
    baja,
  });
}

/** Lo usó, pero lleva días sin volver. */
function sinAvanzar({ firstName, obra, dias, fase, baja }) {
  const donde = fase ? ` Te quedaste en «${fase}».` : '';
  return armar({
    asunto: `Llevas ${dias} días sin avanzar ${obra}`,
    titulo: `¿Seguimos con ${obra}?`,
    preheader: 'Todo lo que hiciste está guardado. Retomas donde lo dejaste.',
    parrafos: [
      `Hola ${firstName}:`,
      `Hace ${dias} días que no trabajas en ${obra}.${donde} No se ha perdido nada: lo que decidiste y lo que escribiste sigue guardado.`,
      'Un rato de 30 minutos basta para cerrar una sección. Lo difícil suele ser volver a abrir el chat.',
    ],
    caja: `Abre un chat nuevo en Claude y escribe: «continuar con ${enPrimera(obra)}». Claude recuerda dónde te quedaste.`,
    accion: { href: `${appUrl()}/perfil`, texto: 'Ver por dónde voy' },
    baja,
  });
}

/** Ya avanza y no ha subido el formato de su universidad. */
function faltaFormato({ firstName, obra, baja }) {
  return armar({
    asunto: 'Te falta subir el formato de tu universidad',
    titulo: 'Tu Word puede salir con el formato de tu universidad',
    preheader: 'Sube la plantilla una vez y el Word sale con su portada y sus márgenes.',
    parrafos: [
      `Hola ${firstName}:`,
      `Vas avanzando con ${obra}, pero aún no nos diste el formato de tu universidad. Sin él, el Word sale con un formato por defecto (Times New Roman 12, márgenes de tesis) y te tocaría ajustarlo a mano.`,
      'Con la plantilla o el esquema de tu facultad, el documento sale con su portada, su orden de capítulos y sus márgenes.',
    ],
    caja: 'En tu chat con Claude escribe: «quiero subir el formato de mi universidad». Te dará un enlace para subir el archivo.',
    accion: null,
    baja,
  });
}

/** Su acceso termina en pocos días (el aviso corto). */
function vencePronto({ firstName, planName, dias, expiresAt, baja }) {
  const cuando = dias <= 1 ? 'mañana' : `en ${dias} días`;
  const vence = fecha(expiresAt);
  return armar({
    asunto: `Tu acceso termina ${cuando}`,
    titulo: `Tu acceso termina ${cuando}`,
    preheader: 'Si renuevas, la misma URL de Claude sigue funcionando.',
    parrafos: [
      `Hola ${firstName}:`,
      `Tu acceso a ${planName} termina ${cuando}${vence ? `, el ${vence}` : ''}.`,
      'Si renuevas antes, no tienes que tocar nada: la URL que tienes en Claude sigue funcionando y todo tu avance sigue guardado.',
    ],
    caja: null,
    accion: { href: `${appUrl()}/planes`, texto: 'Renovar mi acceso' },
    baja,
  });
}

module.exports = { sinConectar, sinAvanzar, faltaFormato, vencePronto };
