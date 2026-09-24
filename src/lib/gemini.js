'use strict';

const env = require('../config/env');
const logger = require('../config/logger');
const vectoresGuardados = require('./vectoresGuardados');

/**
 * El cliente de Gemini que usa el Asistente Acosta.
 *
 * Sin SDK a propósito: es una sola llamada a `generateContent` y el SDK de
 * Google trae detrás medio ecosistema de dependencias para eso. Node 22 ya
 * tiene `fetch`.
 *
 * Sin clave la función queda apagada, igual que el reescritor sin la de
 * Anthropic: el arranque no se rompe y la web simplemente no enseña el panel.
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

if (!env.asistenteEnabled) {
  logger.warn('GEMINI_API_KEY sin configurar: el Asistente Acosta está desactivado');
}

/**
 * Fallo de Gemini.
 *
 * `bloqueado` separa dos cosas que al visitante hay que contarle distinto: que
 * el servicio no contestó —«inténtalo en un momento»— y que contestó negándose
 * por sus filtros, que no se arregla reintentando.
 */
class GeminiError extends Error {
  constructor(message, { status, bloqueado = false, esperarMs = null } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.bloqueado = bloqueado;
    // Cuánto pide el proveedor que se espere, cuando lo dice él. Ver `esperaPedida`.
    this.esperarMs = esperarMs;
  }
}

/**
 * Cuánto dice Google que hay que esperar antes de volver a preguntar.
 *
 * Cuando corta por cuota manda un `RetryInfo` con `retryDelay: "36s"`, y lo
 * repite en el texto («Please retry in 35.72315»). Hasta ahora se tiraba: se
 * esperaban dos segundos y se volvía a preguntar, con lo que el corte se
 * convertía en más peticiones contra el mismo tope.
 *
 * Devuelve null si no lo dice, que es lo normal en un 503 pasajero.
 */
function esperaPedida(cuerpo, mensaje) {
  for (const detalle of cuerpo?.error?.details ?? []) {
    const segundos = Number.parseFloat(String(detalle?.retryDelay ?? '').replace(/s$/, ''));
    if (Number.isFinite(segundos) && segundos > 0) return Math.round(segundos * 1000);
  }

  const enElTexto = String(mensaje ?? '').match(/retry in ([\d.]+)/i);
  const segundos = enElTexto ? Number.parseFloat(enElTexto[1]) : NaN;
  return Number.isFinite(segundos) && segundos > 0 ? Math.round(segundos * 1000) : null;
}

/**
 * Pide una respuesta a un modelo.
 *
 * `mensajes` va en el formato del asistente —`{ rol, texto }`— y aquí se
 * traduce al de Google. `fetchImpl` existe para las pruebas.
 *
 * El razonamiento va al mínimo por defecto: para responder preguntas de una
 * ficha no aporta nada, y medido con estos modelos se comía 190 tokens de
 * pensamiento para una frase de 7.
 */
async function generar({
  sistema,
  mensajes,
  modelo = env.GEMINI_MODEL,
  maxTokens = 900,
  timeoutMs = 20_000,
  json = false,
  fetchImpl = fetch,
  /**
   * Con qué clave se pregunta. Vacío = la de la casa.
   *
   * La cuota de Google se cuenta POR CLAVE, así que dos servicios con la misma
   * clave se quitan las peticiones el uno al otro: el 23-sep-2026 la del
   * asistente estaba agotada (429 en todos los modelos) y con ella se caía
   * también «Preparar documento», que es lo único de los dos por lo que alguien
   * pagó. Ver `PREPARAR_GEMINI_API_KEY`.
   */
  clave = env.GEMINI_API_KEY,
  /**
   * Cuánto se le deja pensar. `auto` = no se manda y decide el modelo.
   *
   * No todos aceptan todos los niveles, y el que no acepta NO avisa de otra
   * forma que con un 400: `gemini-3.8-flash` —el modelo principal de «Preparar
   * documento»— rechaza `minimal`, que es justo lo que mandaba esto para todo
   * el mundo. Comprobado contra la API el 23-sep-2026. Ver `PREPARAR_THINKING`.
   */
  thinking = env.GEMINI_THINKING,
}) {
  const url = `${BASE}/models/${encodeURIComponent(modelo)}:generateContent`;

  const respuesta = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': clave ?? '' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sistema }] },
      contents: mensajes.map((mensaje) => ({
        role: mensaje.rol === 'asistente' ? 'model' : 'user',
        parts: [{ text: mensaje.texto }],
      })),
      generationConfig: {
        maxOutputTokens: maxTokens,
        ...(thinking && thinking !== 'auto' ? { thinkingConfig: { thinkingLevel: thinking } } : {}),
        // Con `json`, Google garantiza que la respuesta sea JSON bien formado.
        // Sin esto, de vez en cuando llegaba con texto alrededor o cortado, y
        // quien lo leía se quedaba sin nada que enseñar.
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const cuerpo = await respuesta.json().catch(() => null);

  if (!respuesta.ok) {
    const mensaje = cuerpo?.error?.message ?? `Gemini respondió ${respuesta.status}`;
    throw new GeminiError(mensaje, {
      status: respuesta.status,
      esperarMs: esperaPedida(cuerpo, mensaje),
    });
  }

  if (cuerpo?.promptFeedback?.blockReason) {
    throw new GeminiError(`Pregunta bloqueada: ${cuerpo.promptFeedback.blockReason}`, {
      bloqueado: true,
    });
  }

  const candidato = cuerpo?.candidates?.[0];
  // Las partes de pensamiento llegan marcadas con `thought`: no son respuesta.
  const texto = (candidato?.content?.parts ?? [])
    .filter((parte) => !parte.thought && typeof parte.text === 'string')
    .map((parte) => parte.text)
    .join('')
    .trim();

  if (!texto) {
    const motivo = candidato?.finishReason ?? 'desconocido';
    throw new GeminiError(`Gemini no devolvió texto (${motivo})`, {
      bloqueado: ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'].includes(motivo),
    });
  }

  return {
    texto,
    finishReason: candidato.finishReason,
    uso: cuerpo.usageMetadata ?? null,
  };
}

/**
 * Los proveedores que hablan el dialecto de OpenAI: mismo cuerpo, misma
 * respuesta, solo cambian la dirección y la clave. Se les pide por el prefijo
 * del modelo (`groq:openai/gpt-oss-120b`).
 *
 * `esfuerzoBajo` es para los que aceptan `reasoning_effort`, que no es de
 * OpenAI sino un añadido de cada casa: Groq y NVIDIA lo documentan, y en OVH no
 * está comprobado, así que allí no se manda (un parámetro que no conocen puede
 * volver como un 400 y tirar la petición entera). Hoy solo se activa en Groq:
 * lo pide el modelo, no el proveedor, y el único gpt-oss que queda es el suyo
 * (NVIDIA lo retiró el 3-sep-2026). Los demás que razonan devuelven lo pensado
 * en `reasoning_content`, aparte del texto, así que no se nos cuela en la
 * respuesta; pero sí cuenta contra `max_completion_tokens`, y por eso el margen
 * de mil tokens de abajo vale para todos.
 */
const COMPATIBLES = {
  groq: {
    nombre: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    clave: () => env.GROQ_API_KEY,
    esfuerzoBajo: true,
  },
  nvidia: {
    nombre: 'NVIDIA NIM',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    clave: () => env.NVIDIA_API_KEY,
    esfuerzoBajo: true,
  },
  ovh: {
    nombre: 'OVHcloud',
    url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
    // Anónimo a propósito: el tier sin clave existe y no caduca. Ver `OVH_MODEL`.
    clave: () => null,
    esfuerzoBajo: false,
  },
};

/** Los motivos de parada de OpenAI, con el nombre de Gemini. */
const PARADA_COMPATIBLE = { stop: 'STOP', length: 'MAX_TOKENS', content_filter: 'SAFETY' };

/**
 * Lo mismo que `generar`, pero en un proveedor compatible con OpenAI: mismas
 * entradas, misma salida y el mismo GeminiError, para que quien lo usa no sepa
 * quién contestó.
 *
 * gpt-oss piensa antes de contestar y ese pensamiento cuenta dentro del tope
 * de salida: se le da el esfuerzo más bajo y mil tokens más de margen, o una
 * respuesta corta podría quedarse sin sitio.
 */
async function generarEnCompatible({
  sistema,
  mensajes,
  modelo,
  proveedor = 'groq',
  maxTokens = 900,
  timeoutMs = 20_000,
  json = false,
  fetchImpl = fetch,
}) {
  const quien = COMPATIBLES[proveedor];
  if (!quien) throw new GeminiError(`Proveedor desconocido: ${proveedor}`);
  const clave = quien.clave();

  const respuesta = await fetchImpl(quien.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(clave ? { Authorization: `Bearer ${clave}` } : {}),
    },
    body: JSON.stringify({
      model: modelo,
      messages: [
        { role: 'system', content: sistema },
        ...mensajes.map((m) => ({ role: m.rol === 'asistente' ? 'assistant' : 'user', content: m.texto })),
      ],
      max_completion_tokens: maxTokens + 1_000,
      ...(quien.esfuerzoBajo && modelo.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const cuerpo = await respuesta.json().catch(() => null);
  if (!respuesta.ok) {
    const mensaje = cuerpo?.error?.message ?? `${quien.nombre} respondió ${respuesta.status}`;
    throw new GeminiError(mensaje, {
      status: respuesta.status,
      esperarMs: esperaPedida(cuerpo, mensaje),
    });
  }

  const eleccion = cuerpo?.choices?.[0];
  const finishReason = PARADA_COMPATIBLE[eleccion?.finish_reason] ?? eleccion?.finish_reason ?? 'desconocido';
  const texto = String(eleccion?.message?.content ?? '').trim();
  if (!texto) {
    throw new GeminiError(`${quien.nombre} no devolvió texto (${finishReason})`, {
      bloqueado: finishReason === 'SAFETY',
    });
  }

  const uso = cuerpo.usage;
  return {
    texto,
    finishReason,
    uso: uso
      ? {
          promptTokenCount: uso.prompt_tokens,
          candidatesTokenCount: uso.completion_tokens,
          totalTokenCount: uso.total_tokens,
        }
      : null,
  };
}

/**
 * Pide a quien toque: `<proveedor>:<modelo>` va a ese proveedor, lo demás a
 * Gemini. Un prefijo que no conocemos NO se parte: se le pasa entero a Gemini,
 * que dirá que ese modelo no existe, en vez de irse a un sitio equivocado.
 */
const generarCon = (modelo, opciones) => {
  const corte = modelo.indexOf(':');
  const prefijo = corte > 0 ? modelo.slice(0, corte) : null;
  return prefijo && COMPATIBLES[prefijo]
    ? generarEnCompatible({ ...opciones, proveedor: prefijo, modelo: modelo.slice(corte + 1) })
    : generar({ ...opciones, modelo });
};

/**
 * Los modelos de texto en su orden: el Gemini principal, los de fuera que
 * tengan clave, el Gemini de respaldo y, si acaso, OVH.
 *
 * Groq, segundo y no primero: su plan gratuito cuenta peticiones por día, y
 * así solo se le pregunta cuando el principal falla o, con la carrera de
 * `ventajaMs`, tarda. Y segundo y no tercero: cuando Gemini se satura suelen
 * ir lentos los dos a la vez (el 21-sep-2026), y de tercero habría que esperar
 * dos ventajas antes de preguntarle.
 *
 * NVIDIA detrás de Groq por lo mismo, y porque su tier gratuito es más ancho
 * (10.000 al día frente a 1.000): aguanta mejor ser el que queda cuando los
 * demás se caen a la vez.
 *
 * OVH el último de todos, después incluso del respaldo de Gemini: es anónimo y
 * cuenta 2 peticiones por minuto por IP, y la IP es la del servidor entero. Con
 * dos personas escribiendo a la vez ya da 429, así que sirve de último recurso
 * y no de corredor.
 *
 * Esto NO lo usa Preparar documento, que tiene su propia lista (`PREPARAR_MODELO`):
 * lo que sale de ahí es el documento de un cliente y no va a proveedores gratuitos.
 */
const modelosDeTexto = () => [
  ...new Set(
    [
      env.GEMINI_MODEL,
      env.GROQ_API_KEY ? `groq:${env.GROQ_MODEL}` : null,
      env.NVIDIA_API_KEY ? `nvidia:${env.NVIDIA_MODEL}` : null,
      env.GEMINI_MODEL_RESPALDO,
      env.OVH_MODEL ? `ovh:${env.OVH_MODEL}` : null,
    ].filter(Boolean),
  ),
];

/**
 * Prueba los modelos en orden hasta que uno conteste.
 *
 * NO ES UN LUJO. El 13 de septiembre de 2026, probando este asistente,
 * `gemini-3.5-flash` tardaba 25 segundos y devolvía «This model is currently
 * experiencing high demand» a la mitad de las peticiones, mientras el modelo de
 * al lado respondía en dos. Y ese mismo día los `gemini-2.5` ya daban 404: Google
 * los había retirado para clientes nuevos. Con un solo modelo, cualquiera de las
 * dos cosas deja el chat de la web muerto sin que nadie toque nada.
 *
 * Se pasa al siguiente con cualquier fallo MENOS un rechazo por contenido: si un
 * modelo se negó a responder algo, preguntárselo a otro es buscar el que diga
 * que sí.
 */
/**
 * Un pico pasajero de Google: saturado (503) o el tope del minuto (429).
 *
 * «This model is currently experiencing high demand. Spikes in demand are
 * usually temporary»: lo dice el propio error. Un tiempo agotado NO cuenta:
 * ese ya se comió sus quince o treinta segundos, y reintentarlo dejaría al
 * tesista mirando la pantalla cargando más de un minuto.
 */
const esPicoPasajero = (error) =>
  error instanceof GeminiError &&
  (error.status === 503 ||
    error.status === 429 ||
    /high demand|overloaded|try again later|exceeded your current quota|resource.?exhausted/i.test(
      error.message,
    ));

/**
 * Y de esos, el que NO se arregla volviendo a preguntar en dos segundos.
 *
 * Un 503 es «este modelo, ahora»: se pregunta otra vez y contesta. Un 429 por
 * cuota es nuestro plan contra el reloj de Google, y él mismo dice que hay que
 * esperar medio minuto. Reintentarlo aquí gasta otra petición de las que ya no
 * hay, y encima quien llama volverá a intentarlo por su cuenta: el 22-sep-2026
 * un documento de dos tandas gastó TREINTA Y SEIS peticiones contra un tope de
 * veinte, porque se reintentaba en tres sitios a la vez.
 *
 * Así que aquí no se reintenta. Se devuelve el error con su `esperarMs` y
 * quien pueda esperar de verdad —`preparar.motor`— decide.
 */
const esCupoAgotado = (error) =>
  error instanceof GeminiError &&
  (error.status === 429 ||
    /exceeded your current quota|quota exceeded|resource.?exhausted/i.test(error.message ?? ''));

/** Lo que se espera entre vuelta y vuelta cuando todos los modelos están en un pico. */
const ESPERAS_TRAS_PICO = [2_000, 4_000];

const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

/**
 * Los modelos que hace poco se quedaron sin contestar, y hasta cuándo se les
 * pregunta al final.
 *
 * El 21-sep-2026, desde las nueve de la mañana, `gemini-3.5-flash-lite` agotaba
 * sus quince segundos en TODAS las peticiones y el respaldo contestaba en dos:
 * el copiloto de Scopus pasó de uno o dos segundos a veinte. Cada tesista
 * volvía a pagar la espera entera por un modelo que ya se sabía caído. Ahora,
 * el que se agota se va al final de la lista unos minutos; sigue ahí como
 * último recurso, y pasado el reposo vuelve a su sitio solo.
 *
 * Solo el tiempo agotado: un «high demand» vuelve en un segundo y no hace
 * esperar a nadie.
 */
const REPOSO_MS = 5 * 60_000;
const enReposo = new Map();

const esTiempoAgotado = (error) => error?.name === 'TimeoutError' || /aborted due to timeout/i.test(error?.message ?? '');

/** Los modelos en su orden, con los que están en reposo al final. */
function enOrdenDeConfianza(modelos, ahora) {
  const descansa = (m) => (enReposo.get(m) ?? 0) > ahora;
  return [...modelos.filter((m) => !descansa(m)), ...modelos.filter(descansa)];
}

/** Para las pruebas: que ninguna herede el reposo de otra. */
const olvidarReposos = () => enReposo.clear();

/**
 * Una vuelta por la lista de modelos, y el primero que conteste gana.
 *
 * Sin `ventajaMs`, en fila: el siguiente solo si el anterior falló. Con ella,
 * además, si el que está preguntado tarda más que eso, se le pregunta también
 * al siguiente sin soltar al primero. El 21-sep a las 10:25 el copiloto tardó
 * 32 s: el principal se colgó 15, y el respaldo, que en otros momentos contesta
 * en uno, tardó 12 en decir «high demand». En fila, las esperas se suman; en
 * carrera, cuenta la del más rápido.
 *
 * Devuelve `{ resultado }` o `{ fallos }` en el orden en que llegaron; un
 * rechazo por contenido corta la vuelta y se lanza.
 */
function unaVuelta(modelos, opciones, { ventajaMs, alFallar }) {
  return new Promise((resolver, rechazar) => {
    const fallos = [];
    let siguiente = 0;
    let enCurso = 0;
    let terminada = false;
    let reloj = null;

    const terminar = (accion, valor) => {
      terminada = true;
      clearTimeout(reloj);
      accion(valor);
    };

    const preguntarAlSiguiente = () => {
      clearTimeout(reloj);
      if (terminada) return;
      if (siguiente >= modelos.length) {
        if (enCurso === 0) terminar(resolver, { fallos });
        return;
      }

      const modelo = modelos[siguiente];
      siguiente += 1;
      enCurso += 1;
      generarCon(modelo, opciones).then(
        (respuesta) => {
          enCurso -= 1;
          if (!terminada) terminar(resolver, { resultado: { ...respuesta, modelo } });
        },
        (error) => {
          enCurso -= 1;
          // Aunque ya haya ganado otro: que el colgado quede en reposo igual.
          alFallar(modelo, error);
          if (terminada) return;
          if (error instanceof GeminiError && error.bloqueado) return terminar(rechazar, error);
          fallos.push({ modelo, error });
          preguntarAlSiguiente();
        },
      );

      if (Number.isFinite(ventajaMs) && siguiente < modelos.length) {
        reloj = setTimeout(preguntarAlSiguiente, ventajaMs);
      }
    };

    preguntarAlSiguiente();
  });
}

async function generarConRespaldo({
  modelos,
  esperar = dormir,
  ahora = Date.now,
  ventajaMs = Infinity,
  esperaMaximaMs = 0,
  ...opciones
}) {
  let ultimoError;
  modelos = enOrdenDeConfianza(modelos, ahora());

  const alFallar = (modelo, error) => {
    if (error instanceof GeminiError && error.bloqueado) return;
    logger.warn({ modelo, err: error.message }, 'Gemini: el modelo falló, se prueba el siguiente');
    if (esTiempoAgotado(error)) enReposo.set(modelo, ahora() + REPOSO_MS);
  };

  /**
   * Y si TODOS están en un pico, se espera un poco y se vuelve a probar la lista.
   *
   * Pasar al modelo de respaldo cubre que uno se caiga; no cubre un pico de
   * Google, que tumba a los dos a la vez. El 21-sep-2026 el generador de
   * consultas respondió «la IA no contestó» porque los dos modelos dieron
   * «high demand» en cuatro segundos. Dos vueltas más, con dos y cuatro
   * segundos de espera: como estos errores vuelven en uno o dos segundos, lo
   * peor son unos doce segundos más, y casi siempre sale a la primera espera.
   *
   * En la vuelta siguiente solo entran los que dieron pico: el que agotó su
   * tiempo o se rompió no se arregla esperando. Antes, uno así bastaba para no
   * reintentar ninguno, y el 21-sep a las 10:13 el tesista vio «la IA no
   * contestó» porque el principal se colgó y el respaldo dio «high demand» una
   * sola vez.
   *
   * CUÁNTO SE ESPERA
   * ----------------
   * Dos y cuatro segundos, que es lo que dura un pico. Pero cuando Google corta
   * por cuota dice él mismo cuánto hay que esperar —«retry in 35.7»— y esperar
   * dos segundos es volver a chocar contra el mismo tope, gastando otra
   * petición de las que ya no hay. Quien pueda permitirse la espera larga pasa
   * `esperaMaximaMs` y se respeta hasta ese techo; quien no —el chat, donde hay
   * alguien mirando la pantalla— no lo pasa y se queda con los dos segundos.
   */
  for (let vuelta = 0; ; vuelta += 1) {
    const { resultado, fallos } = await unaVuelta(modelos, opciones, { ventajaMs, alFallar });
    if (resultado) return resultado;

    if (fallos.length > 0) ultimoError = fallos[fallos.length - 1].error;
    const enPico = fallos
      .filter((f) => esPicoPasajero(f.error) && !esCupoAgotado(f.error))
      .map((f) => f.modelo);

    if (enPico.length === 0 || vuelta >= ESPERAS_TRAS_PICO.length) break;

    const pedida = Math.max(0, ...fallos.map((f) => f.error?.esperarMs ?? 0));
    const espera = Math.min(Math.max(ESPERAS_TRAS_PICO[vuelta], pedida), esperaMaximaMs || ESPERAS_TRAS_PICO[vuelta]);

    logger.info(
      { vuelta: vuelta + 1, modelos: enPico, esperaMs: espera },
      'Gemini: modelos en un pico, se espera y se reintenta',
    );
    await esperar(espera);
    modelos = enPico;
  }

  throw ultimoError ?? new GeminiError('No hay ningún modelo de Gemini configurado');
}

/**
 * Los vectores que ya se pidieron una vez, para no volver a pagarlos.
 *
 * El vector de un artículo no cambia: mismo título y mismo resumen dan el
 * mismo vector siempre. Y el tope del plan gratuito de Gemini se cuenta por
 * TEXTO, no por petición —cien al minuto—, así que cada artículo que se
 * recuerda es uno que no se gasta. Importa cuando alguien mira un tema, vuelve
 * y prueba el siguiente: los temas hermanos comparten literatura, y la segunda
 * búsqueda se ordena sin pedir casi nada.
 *
 * Vive en el proceso y se pierde al reiniciar, que es justo lo que hace falta:
 * no es un dato del tesista, es el resultado de una cuenta.
 */
const MEMORIA_MAXIMA = 1500;
const memoria = new Map();

const claveDelVector = (modelo, tarea, texto) => `${modelo}\u0000${tarea}\u0000${texto}`;

/** Guarda el vector y, de paso, deja al final el que se acaba de usar. */
function recordarVector(clave, vector) {
  memoria.delete(clave);
  memoria.set(clave, vector);
  // Los primeros del Map son los que llevan más tiempo sin usarse.
  while (memoria.size > MEMORIA_MAXIMA) memoria.delete(memoria.keys().next().value);
}

/**
 * Los vectores de unos textos, para comparar su significado.
 *
 * Los usa la búsqueda semántica de Scopus: la pregunta va con la tarea
 * `RETRIEVAL_QUERY` y los artículos con `RETRIEVAL_DOCUMENT`, que es como
 * Google entrena el modelo para que se encuentren. De cien en cien, que es lo
 * que admite `batchEmbedContents`; 768 dimensiones, que para ordenar sobran.
 *
 * Solo se piden los que no se recuerdan de antes, y se devuelven en el orden
 * en que llegaron: quien llama compara por posición.
 */
async function embeber(
  textos,
  {
    tarea = 'RETRIEVAL_DOCUMENT',
    modelo = env.GEMINI_EMBEDDING_MODEL,
    fetchImpl = fetch,
    // Los vectores de la base. `null` = sin base, para las pruebas que no la tienen.
    guardados = vectoresGuardados,
  } = {},
) {
  const recortados = textos.map((texto) => String(texto).slice(0, 8000));
  const vectores = new Array(recortados.length);
  const pendientes = [];

  const enMemoria = [];
  recortados.forEach((texto, posicion) => {
    const clave = claveDelVector(modelo, tarea, texto);
    const guardado = memoria.get(clave);
    if (guardado) {
      vectores[posicion] = guardado;
      recordarVector(clave, guardado);
    } else {
      enMemoria.push({ texto, posicion });
    }
  });

  /**
   * Lo que no está en memoria, se busca en la base antes de pedírselo a Gemini.
   *
   * La memoria se vacía en cada reinicio y la base no: un artículo que buscó
   * cualquier tesista, cualquier día, ya no gasta cuota. Ver `vectoresGuardados`.
   */
  const deLaBase = guardados
    ? await guardados.leer(enMemoria.map(({ texto }) => guardados.claveDe(modelo, tarea, texto)))
    : new Map();
  for (const pendiente of enMemoria) {
    const vector = guardados ? deLaBase.get(guardados.claveDe(modelo, tarea, pendiente.texto)) : null;
    if (vector) {
      vectores[pendiente.posicion] = vector;
      recordarVector(claveDelVector(modelo, tarea, pendiente.texto), vector);
    } else {
      pendientes.push(pendiente);
    }
  }

  for (let i = 0; i < pendientes.length; i += 100) {
    const lote = pendientes.slice(i, i + 100);
    const url = `${BASE}/models/${encodeURIComponent(modelo)}:batchEmbedContents`;
    const respuesta = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY ?? '' },
      body: JSON.stringify({
        requests: lote.map(({ texto }) => ({
          model: `models/${modelo}`,
          content: { parts: [{ text: texto }] },
          taskType: tarea,
          outputDimensionality: 768,
        })),
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const cuerpo = await respuesta.json().catch(() => null);
    if (!respuesta.ok || !Array.isArray(cuerpo?.embeddings)) {
      throw new GeminiError(cuerpo?.error?.message ?? `Gemini respondió ${respuesta.status}`, {
        status: respuesta.status,
      });
    }

    const nuevos = [];
    lote.forEach(({ texto, posicion }, n) => {
      const vector = cuerpo.embeddings[n]?.values ?? [];
      vectores[posicion] = vector;
      if (vector.length > 0) {
        recordarVector(claveDelVector(modelo, tarea, texto), vector);
        if (guardados) nuevos.push({ clave: guardados.claveDe(modelo, tarea, texto), modelo, vector });
      }
    });
    // Cada lote que llega se guarda ya: si el siguiente choca con el tope, lo
    // que sí se calculó no se vuelve a pedir.
    if (guardados) await guardados.guardar(nuevos);
  }

  return vectores;
}

/** Vaciar lo recordado. Para las pruebas: cada una empieza sin memoria. */
const olvidarVectores = () => memoria.clear();

module.exports = { generar, generarEnCompatible, generarConRespaldo, modelosDeTexto, olvidarReposos, embeber, olvidarVectores, esperaPedida, esPicoPasajero, esCupoAgotado, GeminiError };
