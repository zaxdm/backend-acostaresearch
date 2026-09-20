'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const { AppError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');
const { generarConRespaldo, GeminiError } = require('../../lib/gemini');

/**
 * El generador de consultas: del tema en español a los conceptos en inglés.
 *
 * Es el «Generador de consultas de IA» de Scopus, hecho con el Gemini que ya
 * usa el asistente. El tesista describe su tema como se lo contaría a su
 * asesor y recibe los conceptos que lo componen, cada uno con sus sinónimos
 * en inglés, que es el idioma en el que está indexada casi toda la
 * literatura. La web los pone como etiquetas y él los revisa ANTES de buscar:
 * esto no busca nada, propone.
 *
 * NO TOCA CONTENIDO DE ELSEVIER. A Gemini solo le llega lo que escribió el
 * tesista; ni títulos ni resúmenes de Scopus. Por eso esto no tiene el
 * problema de licencia que sí tendría resumir los resultados con IA.
 *
 * LA SALIDA SE LIMPIA SIEMPRE. Lo que devuelve el modelo acaba dentro de una
 * ecuación de Scopus: un paréntesis o unas comillas de más la romperían, y un
 * `OR` metido en un término cambiaría lo que se busca. Aquí se quitan, se
 * recortan y se deduplican, y lo que no pase no llega a la web.
 */

const MAXIMO_CONCEPTOS = 5;
const MAXIMO_SINONIMOS = 5;
const LARGO_MAXIMO = 80;

const SISTEMA = `Eres un bibliotecario experto en búsquedas en Scopus que ayuda a tesistas de
Latinoamérica. Recibes el tema de una tesis, casi siempre en español, y devuelves los conceptos
que hay que buscar en Scopus, en inglés.

Reglas:
- Entre 2 y 4 conceptos: las variables del estudio y, si importa, la población. Cada concepto es
  un término en inglés tal como aparece en los artículos científicos ("critical thinking",
  "generative artificial intelligence", "university students").
- Para cada concepto, de 0 a 4 sinónimos o variantes en inglés que usa de verdad la literatura
  (siglas incluidas, por ejemplo "GenAI", "ChatGPT"). Puedes usar el comodín * al final de una
  palabra cuando agrupe variantes ("undergraduate*"). Nada de sinónimos inventados.
- NO incluyas como concepto el país, la ciudad, la institución ni los años: estrechan tanto que
  no sale casi nada. Si el tema los menciona, dilo en la nota.
- NO incluyas palabras de relleno como concepto: effect, impact, relationship, influence, study,
  analysis, level.
- Nada de operadores (AND, OR), paréntesis, comillas ni códigos de campo: solo los términos.

Responde SOLO con un JSON, sin texto antes ni después, con esta forma:
{"conceptos":[{"nombre":"critical thinking","sinonimos":["critical reasoning"]}],"nota":"una frase en español para el tesista"}`;

/** Un término apto para ir dentro de una ecuación, o nada. */
function limpiarTermino(valor) {
  if (typeof valor !== 'string') return null;
  const limpio = valor
    .replace(/[()"{}[\]]/g, ' ')
    // Un operador suelto dentro de un término cambiaría la búsqueda entera.
    .replace(/\b(AND|OR|NOT|AND NOT|W\/\d+|PRE\/\d+)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!limpio || limpio.length > LARGO_MAXIMO) return null;
  return limpio;
}

/**
 * Lo que devolvió el modelo, convertido en conceptos que se pueden usar.
 *
 * Exportado para las pruebas: es lo que protege la ecuación de lo que diga el
 * modelo, y tiene que poder comprobarse sin llamar a nadie.
 */
function normalizar(bruto) {
  const conceptos = [];
  const vistos = new Set();

  for (const concepto of Array.isArray(bruto?.conceptos) ? bruto.conceptos : []) {
    const nombre = limpiarTermino(concepto?.nombre);
    if (!nombre || vistos.has(nombre.toLowerCase())) continue;
    vistos.add(nombre.toLowerCase());

    const sinonimos = [];
    for (const sinonimo of Array.isArray(concepto?.sinonimos) ? concepto.sinonimos : []) {
      const termino = limpiarTermino(sinonimo);
      if (!termino || vistos.has(termino.toLowerCase())) continue;
      vistos.add(termino.toLowerCase());
      sinonimos.push(termino);
      if (sinonimos.length === MAXIMO_SINONIMOS) break;
    }

    conceptos.push({ nombre, sinonimos });
    if (conceptos.length === MAXIMO_CONCEPTOS) break;
  }

  const nota = typeof bruto?.nota === 'string' ? bruto.nota.trim().slice(0, 400) : '';
  return { conceptos, nota: nota || null };
}

const noDisponible = (message) =>
  // ASSISTANT_UNAVAILABLE y no SERVICE_UNAVAILABLE: este último enciende la
  // pantalla de mantenimiento de la web, y que la IA no conteste no es que el
  // servicio esté caído.
  new AppError(message, { statusCode: 503, code: ERROR_CODES.ASSISTANT_UNAVAILABLE });

/**
 * Del tema a los conceptos. `generar` existe para las pruebas.
 */
async function generarConsulta(tema, { generar = generarConRespaldo } = {}) {
  // Va con el buscador: sin Scopus encendido no hay dónde usar lo que proponga,
  // y Gemini se paga.
  if (!env.asistenteEnabled || !env.scopusApiEnabled) {
    throw noDisponible(
      'El generador con IA no está disponible ahora. Escribe los conceptos a mano, separados ' +
        'por comas: use of AI, critical thinking, college students.',
    );
  }

  let texto;
  try {
    ({ texto } = await generar({
      modelos: [env.GEMINI_MODEL, env.GEMINI_MODEL_RESPALDO].filter(Boolean),
      sistema: SISTEMA,
      mensajes: [{ rol: 'usuario', texto: tema }],
      maxTokens: 700,
      timeoutMs: 15_000,
      json: true,
    }));
  } catch (fallo) {
    logger.warn({ err: fallo.message }, 'Generador de consultas: Gemini no contestó');
    throw noDisponible(
      fallo instanceof GeminiError && fallo.bloqueado
        ? 'La IA no quiso procesar ese texto. Descríbelo de otra forma o escribe los conceptos a mano.'
        : 'La IA no contestó a tiempo. Vuelve a intentarlo en un momento.',
    );
  }

  let bruto = null;
  try {
    const json = texto.match(/\{[\s\S]*\}/)?.[0];
    bruto = json ? JSON.parse(json) : null;
  } catch {
    bruto = null;
  }

  const resultado = normalizar(bruto);
  if (resultado.conceptos.length === 0) {
    logger.warn('Generador de consultas: la respuesta de Gemini no traía conceptos usables');
    throw noDisponible(
      'La IA no devolvió conceptos que se puedan buscar. Prueba a describir tu tema con otras ' +
        'palabras: qué estudias, en quiénes y qué relación buscas.',
    );
  }

  return resultado;
}

module.exports = { generarConsulta, normalizar };
