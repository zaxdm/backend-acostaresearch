'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const { AppError, ValidationError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');
const { generarConRespaldo, modelosDeTexto, GeminiError } = require('../../lib/gemini');
const openalex = require('../references/openalex.client');

/**
 * El resumen con citas: lo que hace la «IA de Scopus», con lo que tenemos.
 *
 * El tesista busca y la IA le cuenta qué dicen los primeros artículos de la
 * lista, con cada afirmación atada a los que la sostienen —[1][2]—, y una
 * columna de referencias al lado. Después puede hacer preguntas de
 * seguimiento sobre los mismos artículos.
 *
 * DE DÓNDE SALE EL TEXTO QUE LEE LA IA
 * ------------------------------------
 * De los RESÚMENES DE OPENALEX, que es abierto, y no de Scopus: con nuestra
 * clave Scopus ni siquiera los da. De Scopus solo llegan los datos de la ficha
 * que el tesista ya tiene en pantalla —título, autores, revista, año—. Aun así
 * esto pasa por una IA metadatos de una búsqueda en Scopus, que es el tipo de
 * uso que el acuerdo de Elsevier restringe; la decisión de hacerlo la tomó
 * Benicio el 19-sep-2026 sabiéndolo.
 *
 * LA IA NO PUEDE INVENTAR CITAS
 * ----------------------------
 * Solo se le dan los artículos numerados, y se le pide un JSON en el que cada
 * punto dice qué números lo sostienen. Después, aquí, se tira todo número que
 * no sea de la lista y todo punto que se quede sin ninguno: una afirmación sin
 * cita es exactamente lo que un jurado señala, y no llega a la pantalla.
 */

const MAXIMO_FUENTES = 10;
const LARGO_DEL_RESUMEN = 1800;

const SISTEMA = `Eres un investigador que ayuda a tesistas de Latinoamérica a entender la
literatura sobre su tema. Recibes una pregunta y una lista numerada de artículos científicos con su
título, año y resumen. Respondes EN ESPAÑOL, con tono académico y claro, usando SOLO lo que dicen
esos resúmenes.

Reglas:
- Cada punto que escribas lleva las citas de los artículos que lo sostienen, por su número.
- Nunca cites un número que no esté en la lista ni afirmes algo que no esté en los resúmenes.
- Si los artículos no bastan para responder algo, dilo en "limites" en vez de rellenar.
- Entre 2 y 4 secciones, con 1 a 4 puntos cada una. Frases completas, sin viñetas dentro del texto.
- No uses Markdown: ni asteriscos, ni almohadillas.

Responde SOLO con un JSON, sin texto antes ni después, con esta forma:
{"titulo":"frase que resume la respuesta","introduccion":"2 o 3 frases",
"secciones":[{"titulo":"...","puntos":[{"texto":"...","citas":[1,3]}]}],
"conclusion":"1 o 2 frases","limites":"qué no dicen estos artículos, o cadena vacía"}`;

const noDisponible = (message) =>
  // ASSISTANT_UNAVAILABLE y no SERVICE_UNAVAILABLE: este último enciende la
  // pantalla de mantenimiento de la web.
  new AppError(message, { statusCode: 503, code: ERROR_CODES.ASSISTANT_UNAVAILABLE });

const texto = (valor, largo) =>
  typeof valor === 'string'
    ? valor.replace(/[*#`]/g, '').replace(/\s+/g, ' ').trim().slice(0, largo)
    : '';

/**
 * Los números de citas, vengan como vengan. El modelo a veces los escribe como
 * texto —"[1]", "1, 3", "Referencia 2"— en vez de como números, y leerlos así
 * tiraba puntos que sí estaban citados.
 */
function numerosDe(citas) {
  const lista = Array.isArray(citas) ? citas : citas === undefined || citas === null ? [] : [citas];
  return lista.flatMap((cita) =>
    typeof cita === 'number' ? [cita] : (String(cita).match(/\d+/g) ?? []).map(Number),
  );
}

/**
 * Lo que devolvió el modelo, en lo que se puede enseñar.
 *
 * Exportado para las pruebas: es lo que impide que llegue a la pantalla una
 * cita inventada o un punto sin cita.
 */
function normalizar(bruto, cuantas) {
  const valida = (n) => Number.isInteger(n) && n >= 1 && n <= cuantas;

  const secciones = (Array.isArray(bruto?.secciones) ? bruto.secciones : [])
    .slice(0, 5)
    .map((seccion) => ({
      titulo: texto(seccion?.titulo, 160),
      puntos: (Array.isArray(seccion?.puntos) ? seccion.puntos : [])
        .slice(0, 6)
        .map((punto) => ({
          texto: texto(punto?.texto, 900),
          citas: [...new Set(numerosDe(punto?.citas))].filter(valida).sort((a, b) => a - b),
        }))
        .filter((punto) => punto.texto && punto.citas.length > 0),
    }))
    .filter((seccion) => seccion.puntos.length > 0);

  return {
    titulo: texto(bruto?.titulo, 200),
    introduccion: texto(bruto?.introduccion, 900),
    secciones,
    conclusion: texto(bruto?.conclusion, 700),
    limites: texto(bruto?.limites, 500),
  };
}

/** La lista numerada que lee el modelo. */
function comoLista(fuentes) {
  return fuentes
    .map((fuente, i) => {
      const cabeza = `[${i + 1}] ${fuente.titulo} (${fuente.anio ?? 's. f.'})`;
      return fuente.resumen ? `${cabeza}\nResumen: ${fuente.resumen}` : `${cabeza}\nResumen: (no disponible)`;
    })
    .join('\n\n');
}

/**
 * La pregunta y los artículos, en un resumen con citas.
 *
 * `anteriores` son las preguntas ya hechas sobre estos mismos artículos, para
 * que una de seguimiento («¿y en secundaria?») se entienda. `generar` y
 * `resumenes` existen para las pruebas.
 */
async function resumir(
  { pregunta, fuentes, anteriores = [] },
  { generar = generarConRespaldo, resumenes = openalex.resumenesPorDoi } = {},
) {
  if (!env.asistenteEnabled || !env.scopusApiEnabled) {
    throw noDisponible('El resumen con IA no está disponible ahora.');
  }

  const lista = fuentes.slice(0, MAXIMO_FUENTES);

  let porDoi = new Map();
  try {
    porDoi = await resumenes(lista.map((f) => f.doi).filter(Boolean));
  } catch (fallo) {
    logger.warn({ err: fallo.message }, 'Resumen con IA: OpenAlex no dio los resúmenes');
  }

  const conResumen = lista.map((fuente) => ({
    ...fuente,
    resumen: fuente.doi ? (porDoi.get(fuente.doi.toLowerCase()) ?? '').slice(0, LARGO_DEL_RESUMEN) : '',
  }));
  const usadas = conResumen.filter((f) => f.resumen).length;

  if (usadas === 0) {
    throw new ValidationError(
      'Ninguno de estos artículos tiene resumen en el catálogo abierto, así que la IA no tendría ' +
        'qué leer. Prueba con otra página de resultados o con otro orden.',
    );
  }

  const contexto = anteriores
    .slice(-3)
    .map((turno) => `Pregunta anterior: ${turno.pregunta}\nRespuesta anterior: ${turno.respuesta}`)
    .join('\n\n');

  const mensaje =
    (contexto ? `${contexto}\n\n` : '') +
    `Pregunta: ${pregunta}\n\nArtículos:\n\n${comoLista(conResumen)}`;

  // Dos intentos. El 19-sep-2026, en producción, una petición volvió sin
  // ningún punto citable y la misma, repetida a mano 40 s después, salió
  // bien: el modelo falla de vez en cuando, y es mejor que el segundo intento
  // lo haga el servidor que el tesista.
  let resultado = null;
  let ultimaRespuesta = '';
  for (let intento = 1; intento <= 2 && !resultado; intento += 1) {
    let respuesta;
    try {
      ({ texto: respuesta } = await generar({
        modelos: modelosDeTexto(),
        sistema: SISTEMA,
        mensajes: [{ rol: 'usuario', texto: mensaje }],
        maxTokens: 3000,
        timeoutMs: 30_000,
        // Un resumen largo tarda lo suyo; pasados diez segundos sin nada, se
        // le pregunta también al siguiente y gana el que termine antes.
        ventajaMs: 10_000,
        json: true,
      }));
    } catch (fallo) {
      logger.warn({ err: fallo.message, intento }, 'Resumen con IA: Gemini no contestó');
      if (fallo instanceof GeminiError && fallo.bloqueado) {
        throw noDisponible('La IA no quiso procesar esta pregunta. Formúlala de otra forma.');
      }
      continue;
    }

    ultimaRespuesta = respuesta;
    let bruto = null;
    try {
      const json = respuesta.match(/\{[\s\S]*\}/)?.[0];
      bruto = json ? JSON.parse(json) : null;
    } catch {
      bruto = null;
    }

    const normalizado = normalizar(bruto, lista.length);
    if (normalizado.secciones.length > 0) resultado = normalizado;
  }

  if (!resultado) {
    // Lo que devolvió, recortado: es texto del modelo, no del tesista, y es
    // lo único que dice por qué no se pudo leer.
    logger.warn(
      { muestra: ultimaRespuesta.slice(0, 400), largo: ultimaRespuesta.length },
      'Resumen con IA: la respuesta no traía puntos con citas válidas',
    );
    throw noDisponible('La IA no devolvió un resumen que se pueda citar. Vuelve a intentarlo.');
  }

  return {
    ...resultado,
    /** Qué números tenían resumen: los demás se leyeron solo por el título. */
    conResumen: conResumen.map((f, i) => (f.resumen ? i + 1 : null)).filter(Boolean),
  };
}

/**
 * Los resúmenes de los artículos de una página, para «Ver resumen» en la tabla.
 *
 * Scopus no nos los da con nuestra clave; OpenAlex sí, en abierto y en una
 * sola consulta para toda la página. Se piden los de la página entera al abrir
 * el primero: abrir el segundo ya no cuesta nada.
 */
async function resumenesDeLaPagina(dois, { resumenes = openalex.resumenesPorDoi } = {}) {
  const porDoi = await resumenes(dois).catch((fallo) => {
    logger.warn({ err: fallo.message }, 'Ver resumen: OpenAlex no contestó');
    return new Map();
  });
  return Object.fromEntries(porDoi);
}

module.exports = { resumir, resumenesDeLaPagina, normalizar, MAXIMO_FUENTES };
