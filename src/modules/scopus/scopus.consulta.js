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
 * Y PROPONE TEMAS. Quien llega aquí casi nunca trae un tema: trae una
 * inquietud —«algo de IA y universitarios»—, y con eso lo que sale de Scopus
 * son diez mil artículos que no se parecen entre sí. Por eso, además de los
 * conceptos, vuelven de dos a cuatro temas investigables de verdad, cada uno
 * con sus variables dichas por su nombre —qué influye, sobre qué, en
 * quiénes— y con sus propios conceptos en inglés, para que elegir uno sea
 * pulsar un botón y ver esa literatura y no la del montón. No decide por él:
 * le enseña qué formas puede tomar lo que trajo.
 *
 * NO TOCA CONTENIDO DE ELSEVIER. A Gemini solo le llega lo que escribió el
 * tesista; ni títulos ni resúmenes de Scopus. Por eso esto no tiene el
 * problema de licencia que sí tendría resumir los resultados con IA. Los
 * temas salen de su propia descripción, no de los artículos encontrados.
 *
 * LA SALIDA SE LIMPIA SIEMPRE. Lo que devuelve el modelo acaba dentro de una
 * ecuación de Scopus: un paréntesis o unas comillas de más la romperían, y un
 * `OR` metido en un término cambiaría lo que se busca. Aquí se quitan, se
 * recortan y se deduplican, y lo que no pase no llega a la web.
 */

const MAXIMO_CONCEPTOS = 5;
const MAXIMO_SINONIMOS = 5;
const LARGO_MAXIMO = 80;

/** Los temas propuestos: pocos, y con lo justo para reconocerlos de un vistazo. */
const MAXIMO_TEMAS = 4;
const MAXIMO_CONCEPTOS_POR_TEMA = 3;
const LARGO_FRASE = 180;

const SISTEMA = `Eres un bibliotecario experto en búsquedas en Scopus que ayuda a tesistas de
Latinoamérica. Recibes el tema de una tesis, casi siempre en español, y devuelves dos cosas: los
conceptos que hay que buscar en Scopus, en inglés, y temas concretos que esa persona podría
investigar.

CONCEPTOS
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

TEMAS
- Entre 2 y 4 temas de investigación que salgan de lo que él describió, no de otra cosa.
  Distintos entre sí: que cada uno sea una tesis diferente y no el mismo tema dicho con otras
  palabras.
- Cada tema se titula en español como se titula una tesis, con sus variables y su población
  dentro, y sin las palabras "tesis" ni "investigación" delante.
- Di las variables con el nombre que tienen en la literatura y de forma que se puedan medir: no
  "la IA", sino "frecuencia de uso de herramientas de IA generativa en tareas académicas".
- "independiente" es lo que influye y "dependiente" lo que resulta afectado. Si el estudio no
  tiene esa forma (descriptivo, cualitativo, de revisión), deja esas dos vacías y explica en
  "relacion" qué se estudia y cómo.
- "relacion" es una frase sobre qué se busca entre esas variables; "poblacion", en quiénes se
  estudia, lo más concreto que permita lo que te contó.
- Cada tema trae además sus propios conceptos en inglés, de 2 a 3, con las mismas reglas de
  arriba: son los que se usarán para buscar ESE tema en Scopus.

Responde SOLO con un JSON, sin texto antes ni después, con esta forma:
{"conceptos":[{"nombre":"critical thinking","sinonimos":["critical reasoning"]}],
"nota":"una frase en español para el tesista",
"temas":[{"titulo":"Uso de IA generativa y pensamiento crítico en estudiantes universitarios",
"independiente":"frecuencia de uso de IA generativa en tareas académicas",
"dependiente":"nivel de pensamiento crítico",
"relacion":"si a mayor uso de estas herramientas cambia el pensamiento crítico",
"poblacion":"estudiantes de pregrado",
"conceptos":[{"nombre":"generative artificial intelligence","sinonimos":["ChatGPT"]},
{"nombre":"critical thinking","sinonimos":[]}]}]}`;

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
 * Una frase del tema propuesto, para leerla y nada más.
 *
 * No va a ninguna ecuación —el título y las variables se enseñan, no se
 * buscan—, así que aquí no se quitan operadores ni paréntesis: se junta en
 * una línea y se le pone techo, que es lo que hace falta para que quepa en su
 * tarjeta.
 */
function limpiarFrase(valor) {
  if (typeof valor !== 'string') return null;
  const limpio = valor.replace(/\s+/g, ' ').trim();
  return limpio ? limpio.slice(0, LARGO_FRASE) : null;
}

/**
 * Una lista de conceptos con sus sinónimos, sin repetidos y con techo.
 *
 * El «sin repetidos» vale DENTRO de la lista: los conceptos del segundo tema
 * pueden coincidir con los del primero —casi siempre comparten alguno— y
 * quitárselos dejaría a ese tema sin con qué buscarse.
 */
function normalizarConceptos(lista, maximo) {
  const conceptos = [];
  const vistos = new Set();

  for (const concepto of Array.isArray(lista) ? lista : []) {
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
    if (conceptos.length === maximo) break;
  }

  return conceptos;
}

/**
 * Los temas propuestos, quedándose solo con los que sirven.
 *
 * Un tema sin título no se puede enseñar y uno sin conceptos no se puede
 * buscar: los dos se caen aquí, porque una tarjeta con un botón que no lleva
 * a ninguna parte es peor que no proponer nada.
 */
function normalizarTemas(lista) {
  const temas = [];
  const titulos = new Set();

  for (const tema of Array.isArray(lista) ? lista : []) {
    const titulo = limpiarFrase(tema?.titulo);
    if (!titulo || titulos.has(titulo.toLowerCase())) continue;

    const conceptos = normalizarConceptos(tema?.conceptos, MAXIMO_CONCEPTOS_POR_TEMA);
    if (conceptos.length === 0) continue;

    titulos.add(titulo.toLowerCase());
    temas.push({
      titulo,
      independiente: limpiarFrase(tema?.independiente),
      dependiente: limpiarFrase(tema?.dependiente),
      relacion: limpiarFrase(tema?.relacion),
      poblacion: limpiarFrase(tema?.poblacion),
      conceptos,
    });
    if (temas.length === MAXIMO_TEMAS) break;
  }

  return temas;
}

/**
 * Lo que devolvió el modelo, convertido en conceptos y temas que se pueden usar.
 *
 * Exportado para las pruebas: es lo que protege la ecuación de lo que diga el
 * modelo, y tiene que poder comprobarse sin llamar a nadie.
 */
function normalizar(bruto) {
  const conceptos = normalizarConceptos(bruto?.conceptos, MAXIMO_CONCEPTOS);
  const nota = typeof bruto?.nota === 'string' ? bruto.nota.trim().slice(0, 400) : '';
  return { conceptos, nota: nota || null, temas: normalizarTemas(bruto?.temas) };
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
      // Los temas con sus variables ocupan bastante más que los conceptos
      // solos: con el techo de antes el JSON se cortaría por la mitad y no se
      // podría leer ni la parte de los conceptos.
      maxTokens: 1800,
      timeoutMs: 20_000,
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
