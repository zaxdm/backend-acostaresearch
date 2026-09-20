'use strict';

/**
 * Los enlaces que el conector le da al asistente para el tesista, como «haz
 * clic aquí».
 *
 * Antes iban sueltos, con la instrucción «dáselo tal cual», y en la conversación
 * aparecía la dirección entera: cientos de caracteres de token firmado que el
 * tesista no tiene por qué ver, que asustan y que a veces copiaba a medias. En
 * claude.ai un enlace en Markdown se enseña como texto que se pulsa, así que se
 * le da hecho: `[Haz clic aquí para descargar tu Word](https://…)`, y se le dice
 * al asistente que lo copie así, sin escribir la dirección.
 *
 * EN CHATGPT ESO ROMPE EL ENLACE. Pedirle que lo ponga en Markdown hace que el
 * modelo escriba una dirección suya al dominio —`https://acostaresearch.com`,
 * sin ruta y sin token— y el tesista acaba en la portada. Pedida en texto
 * plano, la misma dirección sale entera. Así que ahí se hace al revés: la
 * dirección sola en su línea y prohibido convertirla en enlace. Con quién se
 * está hablando lo decide `mcp.cliente`, que también explica cómo se comprobó.
 *
 * Los dos textos comparten el final: llamar otra vez a la herramienta en vez de
 * repetir un enlace anterior. ChatGPT repetía uno de horas antes y el
 * estudiante leía «este enlace venció».
 */

/** Los corchetes y paréntesis del texto romperían el Markdown del enlace. */
const limpiarTexto = (texto) => String(texto).replace(/[[\]()]/g, '').trim();

/** Común a los dos: no reutilizar, pedir otro. */
const NO_REPITAS =
  'Si más adelante vuelve a necesitarlo, o dice que no le abre, llama otra vez a la herramienta ' +
  'para darle uno nuevo: NUNCA repitas este enlace ni uno anterior de la conversación.';

/**
 * Las líneas que van en la respuesta de la herramienta: el enlace listo, cuánto
 * dura y cómo dárselo. `cliente` viene del conector: `'chatgpt'` u `'otro'`.
 */
function enlaceClic({ texto, url, minutos, cliente = 'otro' }) {
  const caduca = minutos ? ` Caduca en ${minutos} minutos.` : '';

  if (cliente === 'chatgpt') {
    return (
      `${limpiarTexto(texto)}:\n${url}\n` +
      `Dale la dirección ENTERA, tal cual, sola en su línea y sin cambiar ni un carácter.${caduca} ` +
      'NO la conviertas en un enlace con un texto encima, NO la acortes y NO escribas solo el ' +
      'dominio: en esta interfaz eso la rompe y el tesista aterriza en la portada sin saber por ' +
      `qué. ${NO_REPITAS}`
    );
  }

  return (
    `[${limpiarTexto(texto)}](${url})\n` +
    `Dáselo EXACTAMENTE con esa línea, como enlace que se pulsa.${caduca} NO escribas la dirección ` +
    'completa en la conversación, no la pongas en un bloque de código y no cambies el enlace. ' +
    `${NO_REPITAS}`
  );
}

module.exports = { enlaceClic };
