'use strict';

/** Los avisos de la declaración del 621: al móvil (ntfy) y por correo. */

const { layout, escapar, appUrl } = require('../../lib/emailTemplates');

function soles(cents) {
  return `S/ ${(cents / 100).toFixed(2)}`;
}

/** `2026-11-18` → `18 de noviembre`. */
function fechaCorta(iso) {
  if (!iso) return null;
  return new Intl.DateTimeFormat('es-PE', { timeZone: 'UTC', day: 'numeric', month: 'long' }).format(new Date(`${iso}T00:00:00Z`));
}

function enlace() {
  return `${appUrl()}/admin/declaraciones`;
}

function titulo({ nombre, vencimiento, tipo }) {
  if (tipo === 'sinFecha') return `Pon la fecha de vencimiento del 621 de ${nombre}`;
  if (tipo === 'ultimo') return `Último aviso: declara ${nombre} (vence el ${fechaCorta(vencimiento)})`;
  return `Declara ${nombre} antes del ${fechaCorta(vencimiento)}`;
}

/** Para ntfy: corto, sin datos de clientes. */
function avisoMovil(datos) {
  const { calculo, tipo } = datos;
  const mensaje =
    tipo === 'sinFecha'
      ? 'Entra a Declaraciones y escribe el día que vence según el cronograma de SUNAT (RUC terminado en 0).'
      : `IGV ${soles(calculo.igvAPagarCents)} + renta ${soles(calculo.rentaCents)} = ${soles(calculo.totalAPagarCents)}. ` +
        'Las casillas están en el panel y en tu correo.';
  return {
    titulo: titulo(datos),
    mensaje,
    etiquetas: ['receipt'],
    prioridad: tipo === 'ultimo' ? 5 : 4,
    enlace: enlace(),
  };
}

/** El correo, con cada casilla del 621 y su monto en soles enteros. */
function avisoCorreo(datos) {
  const { nombre, calculo, tipo } = datos;
  const asunto = `${titulo(datos)} · Acosta Research`;
  if (tipo === 'sinFecha') {
    return {
      subject: asunto,
      text: `Falta la fecha de vencimiento del 621 de ${nombre}. Ponla en ${enlace()} para que lleguen los avisos.`,
      html: layout(
        'Falta la fecha de vencimiento',
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.6">Falta la fecha de vencimiento del
           621 de <strong>${escapar(nombre)}</strong>. Escríbela según el cronograma de SUNAT (RUC
           terminado en 0) para que lleguen los avisos con las cifras.</p>
         <p style="margin:0;font-size:14px"><a href="${enlace()}" style="color:#1a56db">Abrir Declaraciones</a></p>`,
      ),
    };
  }

  const filas = calculo.casillas
    .map((c) => `${c.casilla ? `[${c.casilla}] ` : ''}${c.texto}: S/ ${c.soles}`)
    .join('\n');
  const filasHtml = calculo.casillas
    .map(
      (c) =>
        `<tr><td style="padding:6px 10px;color:#52606d;font-size:13px">${c.casilla ?? ''}</td>` +
        `<td style="padding:6px 10px;font-size:14px">${escapar(c.texto)}</td>` +
        `<td style="padding:6px 10px;font-size:14px;text-align:right"><strong>S/ ${c.soles}</strong></td></tr>`,
    )
    .join('');
  return {
    subject: asunto,
    text: [
      `Declaración del 621 de ${nombre}.`,
      '',
      filas,
      '',
      `Total a pagar: ${soles(calculo.totalAPagarCents)} (IGV ${soles(calculo.igvAPagarCents)} + renta ${soles(calculo.rentaCents)}).`,
      '',
      'Preséntalo en SOL → Declara Fácil (621), comprueba que coincida y luego marca «Ya declaré» en:',
      enlace(),
    ].join('\n'),
    html: layout(
      titulo(datos),
      `<p style="margin:0 0 14px;font-size:15px;line-height:1.6">Estas son las cifras del 621 de
         <strong>${escapar(nombre)}</strong>, en soles enteros:</p>
       <table style="width:100%;border-collapse:collapse;margin:0 0 16px">${filasHtml}</table>
       <p style="margin:0 0 14px;font-size:15px">Total a pagar: <strong>${soles(calculo.totalAPagarCents)}</strong>
         (IGV ${soles(calculo.igvAPagarCents)} + renta ${soles(calculo.rentaCents)}).</p>
       <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#52606d">Preséntalo en SOL →
         Declara Fácil (621), comprueba que las cifras coincidan y después marca «Ya declaré» en el
         panel para que no lleguen más avisos de este mes.</p>
       <p style="margin:0;font-size:14px"><a href="${enlace()}" style="color:#1a56db">Abrir Declaraciones</a></p>`,
    ),
  };
}

module.exports = { avisoMovil, avisoCorreo };
