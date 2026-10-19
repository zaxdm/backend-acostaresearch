'use strict';

/**
 * Los correos al cliente con su boleta o su nota de crédito en PDF.
 *
 * Van aparte del correo de compra: la boleta llega unos minutos después, cuando
 * SUNAT la acepta, y el correo de compra ya salió con lo comprado.
 */

const { layout, escapar, appUrl } = require('../../lib/emailTemplates');

function soles(cents) {
  return `S/ ${(cents / 100).toFixed(2)}`;
}

function saludo(nombre) {
  const pila = String(nombre ?? '').trim().split(/\s+/)[0];
  return pila ? `Hola ${pila}:` : 'Hola:';
}

/** @param {{ nombre?: string, numero: string, productos: string, total: number }} p */
function boletaEmitida({ nombre, numero, productos, total }) {
  const perfil = `${appUrl()}/perfil/compras`;
  return {
    subject: `Tu boleta electrónica ${numero} · Acosta Research`,
    text: [
      saludo(nombre),
      '',
      `Te enviamos la boleta electrónica ${numero} de tu compra (${productos}), por ${soles(total)}, emitida ante SUNAT.`,
      '',
      'La tienes adjunta en PDF y también en «Mis compras» de tu perfil:',
      perfil,
    ].join('\n'),
    html: layout(
      `Tu boleta ${numero}`,
      `<p style="margin:0 0 14px;font-size:15px;line-height:1.6">${escapar(saludo(nombre))} te enviamos
         la boleta electrónica <strong>${escapar(numero)}</strong> de tu compra
         (${escapar(productos)}), por <strong>${soles(total)}</strong>, emitida ante SUNAT.</p>
       <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#52606d">La tienes adjunta en PDF
         y también en «Mis compras» de tu perfil.</p>
       <p style="margin:0;font-size:14px"><a href="${perfil}" style="color:#1a56db">Ver mis compras</a></p>`,
      { preheader: `Boleta ${numero} por ${soles(total)}` },
    ),
  };
}

/** @param {{ nombre?: string, numero: string, anula: string, motivo?: string }} p */
function notaEmitida({ nombre, numero, anula, motivo }) {
  return {
    subject: `Nota de crédito ${numero}: anulamos la boleta ${anula} · Acosta Research`,
    text: [
      saludo(nombre),
      '',
      `Anulamos la boleta ${anula} con la nota de crédito ${numero}, que te adjuntamos en PDF.`,
      motivo ? `Motivo: ${motivo}` : null,
      '',
      'Si corresponde una boleta nueva, te llegará en otro correo. Si tienes dudas, responde a este mensaje.',
    ]
      .filter((linea) => linea !== null)
      .join('\n'),
    html: layout(
      `Nota de crédito ${numero}`,
      `<p style="margin:0 0 14px;font-size:15px;line-height:1.6">${escapar(saludo(nombre))} anulamos la
         boleta <strong>${escapar(anula)}</strong> con la nota de crédito
         <strong>${escapar(numero)}</strong>, que te adjuntamos en PDF.</p>
       ${motivo ? `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#52606d">Motivo: ${escapar(motivo)}</p>` : ''}
       <p style="margin:0;font-size:14px;line-height:1.6;color:#52606d">Si corresponde una boleta nueva,
         te llegará en otro correo. Si tienes dudas, responde a este mensaje.</p>`,
      { preheader: `Anulación de la boleta ${anula}` },
    ),
  };
}

module.exports = { boletaEmitida, notaEmitida };
