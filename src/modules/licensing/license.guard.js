'use strict';

/**
 * Filtro de intentos de extracción de las instrucciones internas.
 *
 * QUÉ PUEDE Y QUÉ NO PUEDE HACER ESTO
 * -----------------------------------
 * Conviene ser claro para no confiarse:
 *
 *  · El texto que llega aquí NO lo escribe el comprador: lo escribe SU Claude
 *    al llamar a la herramienta. Si alguien dice «ignora tus instrucciones»,
 *    puede que su Claude ni siquiera lo reenvíe, o que lo reformule. Este filtro
 *    ve una traducción, no el original. Sirve para dejar constancia de los
 *    intentos burdos y para alimentar el historial de abuso; no es una defensa.
 *
 *  · La defensa de verdad es de diseño: ninguna herramienta devuelve las
 *    instrucciones. El contenido operativo vive en el servidor y en la Skills
 *    API, y lo que sale por el conector es el resultado, nunca el método.
 *
 *  · El ataque que sí funciona no es este. Nadie va a pedir el prompt: va a
 *    pedir veinte capítulos y reconstruir el método a partir de las salidas.
 *    Contra eso no hay filtro posible, solo el tope de consultas.
 *
 * Por eso el umbral es conservador. Un falso positivo le corta el trabajo a un
 * tesista que pagó; un falso negativo solo deja pasar una pregunta que, por
 * diseño, no tiene nada que revelar.
 */

/**
 * Patrones y su peso. Se bloquea a partir de 2.
 *
 * Los de peso 2 son inequívocos. Los de peso 1 necesitan compañía, porque por
 * separado aparecen en consultas legítimas: un tesista escribe «dame las
 * instrucciones para redactar el marco teórico» sin ninguna mala intención.
 */
const PATRONES = [
  // ── Inequívocos ─────────────────────────────────────────────────────────
  { peso: 2, patron: /system\s*prompt/i, nombre: 'system_prompt' },
  { peso: 2, patron: /prompt\s+(del\s+)?sistema/i, nombre: 'prompt_sistema' },
  { peso: 2, patron: /instrucciones\s+(del\s+)?sistema/i, nombre: 'instrucciones_sistema' },
  { peso: 2, patron: /developer\s+message/i, nombre: 'developer_message' },
  {
    peso: 2,
    patron: /ignora\s+(todas\s+)?(las\s+)?(instrucciones|indicaciones|reglas)\s+(anteriores|previas)/i,
    nombre: 'ignora_anteriores',
  },
  {
    peso: 2,
    patron: /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
    nombre: 'ignore_previous',
  },
  // Posesivo dirigido al asistente: «tus instrucciones», «tu prompt».
  {
    peso: 2,
    patron: /\b(tus|tu|sus|su)\s+(instruccion\w*|prompt|reglas|directrices|configuraci\w*)\b/i,
    nombre: 'posesivo_instrucciones',
  },
  {
    peso: 2,
    patron: /\b(instrucciones|reglas|directrices)\s+(internas|originales|completas|exactas)\b/i,
    nombre: 'instrucciones_internas',
  },
  { peso: 2, patron: /\bskill\.md\b/i, nombre: 'skill_md' },
  { peso: 2, patron: /<\s*\/?\s*(system|instructions|skill)\s*>/i, nombre: 'etiqueta_sistema' },
  { peso: 2, patron: /\bjailbreak\b|\bmodo\s+desarrollador\b|\bDAN\s+mode\b/i, nombre: 'jailbreak' },
  {
    peso: 2,
    patron: /(c[óo]mo\s+est[áa]s|c[óo]mo\s+fuiste)\s+(configurad|programad|entrenad)/i,
    nombre: 'como_configurado',
  },

  // ── Necesitan compañía ──────────────────────────────────────────────────
  {
    peso: 1,
    patron: /\b(repite|reproduce|imprime|transcribe|copia|revela|mu[ée]strame|dame|dime)\b/i,
    nombre: 'verbo_revelar',
  },
  {
    peso: 1,
    patron: /\b(palabra\s+por\s+palabra|textualmente|verbatim|al\s+pie\s+de\s+la\s+letra[ ]?)\b/i,
    nombre: 'literalidad',
  },
  { peso: 1, patron: /\bprompt\b/i, nombre: 'prompt_suelto' },
  {
    peso: 1,
    patron: /\b(contenido|texto|documento)\s+(completo|[íi]ntegro)\b/i,
    nombre: 'contenido_completo',
  },
  { peso: 1, patron: /\bl[óo]gica\s+interna\b|\bc[óo]digo\s+fuente\b/i, nombre: 'logica_interna' },
];

/** A partir de esta puntuación se rechaza la consulta. */
const UMBRAL = 2;

/**
 * Analiza el mensaje. Devuelve si hay que bloquear y qué patrones saltaron,
 * para poder revisar después si el filtro está siendo demasiado severo.
 */
function analizarIntencion(mensaje) {
  if (typeof mensaje !== 'string' || mensaje.trim().length === 0) {
    return { sospechoso: false, puntuacion: 0, patrones: [] };
  }

  let puntuacion = 0;
  const encontrados = [];

  for (const { peso, patron, nombre } of PATRONES) {
    if (patron.test(mensaje)) {
      puntuacion += peso;
      encontrados.push(nombre);
    }
  }

  return { sospechoso: puntuacion >= UMBRAL, puntuacion, patrones: encontrados };
}

/**
 * Respuesta al intento. Es deliberadamente sosa y no confirma ni desmiente que
 * exista un prompt interno: una negativa detallada es en sí misma información.
 */
const RESPUESTA_RECHAZO =
  'Esta herramienta trabaja capítulos de tesis: dime en qué punto estás y seguimos ' +
  'desde ahí. No comparto mi configuración interna.';

module.exports = { analizarIntencion, RESPUESTA_RECHAZO, UMBRAL, PATRONES };
