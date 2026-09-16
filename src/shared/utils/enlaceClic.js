'use strict';

/**
 * Los enlaces que el conector le da a Claude para el tesista, como «haz clic aquí».
 *
 * Antes iban sueltos, con la instrucción «dáselo tal cual», y en la conversación
 * aparecía la dirección entera: cientos de caracteres de token firmado que el
 * tesista no tiene por qué ver, que asustan y que a veces copiaba a medias. En
 * claude.ai un enlace en Markdown se enseña como texto que se pulsa, así que se
 * le da hecho: `[Haz clic aquí para descargar tu Word](https://…)`, y se le dice
 * a Claude que lo copie así, sin escribir la dirección.
 *
 * ChatGPT, además, repetía un enlace de horas antes en vez de pedir otro, y el
 * estudiante leía «este enlace venció». Por eso la instrucción pide volver a
 * llamar a la herramienta cada vez.
 */

/** Los corchetes y paréntesis del texto romperían el Markdown del enlace. */
const limpiarTexto = (texto) => String(texto).replace(/[[\]()]/g, '').trim();

/**
 * Las líneas que van en la respuesta de la herramienta: el enlace listo, cuánto
 * dura y cómo dárselo.
 */
function enlaceClic({ texto, url, minutos }) {
  const caduca = minutos ? ` Caduca en ${minutos} minutos.` : '';
  return (
    `[${limpiarTexto(texto)}](${url})\n` +
    `Dáselo EXACTAMENTE con esa línea, como enlace que se pulsa.${caduca} NO escribas la dirección ` +
    'completa en la conversación, no la pongas en un bloque de código y no cambies el enlace. ' +
    'Si más adelante vuelve a necesitarlo, o dice que no le abre, llama otra vez a la herramienta ' +
    'para darle uno nuevo: NUNCA repitas este enlace ni uno anterior de la conversación.'
  );
}

module.exports = { enlaceClic };
