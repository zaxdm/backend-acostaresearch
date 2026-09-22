'use strict';

/**
 * El motor: parte el documento en tandas, se las pasa al modelo y comprueba lo
 * que devuelve antes de dejarlo entrar en el Word.
 *
 * POR QUÉ HAY QUE COMPROBAR
 * -------------------------
 * Porque nadie mira el resultado antes de entregarlo. En el conector, Claude
 * enseña lo que propone y el tesista dice que sí; aquí el cliente sube un .docx
 * y recibe otro .docx, y entre una cosa y la otra no hay humano. Todo lo que el
 * modelo haga mal y no se detecte aquí, se entrega.
 *
 * Lo que se comprueba es lo que un modelo estropea de verdad: devolver menos
 * párrafos de los que se le dieron, juntarlos, vaciar uno, inventarse un
 * comentario para el autor o cambiar una cifra. Un párrafo que no pasa la
 * comprobación no se descarta a la ligera: se vuelve a pedir él solo, y solo si
 * falla otra vez se deja el original intacto. El cliente ve cuántos quedaron
 * así.
 *
 * NO SE COMPRUEBA la calidad de la traducción ni de la corrección. Eso no se
 * puede comprobar con código, y prometer que sí sería mentir: por eso el
 * servicio avisa en todas partes de que lo hace una IA y de que hay que
 * revisarlo.
 */

const env = require('../../config/env');
const logger = require('../../config/logger');
const gemini = require('../../lib/gemini');
const prompt = require('./preparar.prompt');
const { palabrasDe } = require('./preparar.cuerpo');

/**
 * Cómo se llama un párrafo ante el modelo.
 *
 * En el cuerpo es su número de siempre; en las notas al pie, el encabezado o el
 * pie de página lleva delante de dónde sale («nota:3»), porque el modelo recibe
 * los de todas las partes juntos. Ver `preparar.partes`. Quien llame sin clave
 * —el conector, las pruebas— sigue usando el número a secas.
 */
const claveDe = (parrafo) => parrafo.clave ?? parrafo.id;

/**
 * Los modelos, en orden, para este servicio.
 *
 * Los suyos y no los del asistente: allí se usa un flash-lite porque la espera
 * se nota más que la calidad, y aquí es al revés. Ver `PREPARAR_MODELO`.
 */
const modelos = () =>
  [...new Set([env.PREPARAR_MODELO, env.PREPARAR_MODELO_RESPALDO].filter(Boolean))];

/** Tiempo por tanda. Largo a propósito: son novecientas palabras de salida. */
const TIMEOUT_MS = 180_000;

/**
 * Cuántos tokens puede gastar una tanda.
 *
 * Cuatro por palabra es holgado: cubre el chino —donde un carácter puede ser un
 * token y una palabra española traducida son dos o tres— y el envoltorio del
 * JSON. Quedarse corto es lo peor que puede pasar: la respuesta llega cortada a
 * la mitad, el JSON no cierra y la tanda entera se pierde.
 */
const tokensPara = (palabras) => Math.min(60_000, Math.max(2_000, Math.round(palabras * 4) + 800));

// ── Repartir el trabajo ────────────────────────────────────────────────────

/**
 * Los párrafos en tandas de como mucho `porTanda` palabras.
 *
 * Un párrafo nunca se parte: si él solo pasa del tope, va en una tanda para él.
 * Partirlo obligaría a recomponer el texto después, y recomponer es justo donde
 * se pierden los espacios y las comillas.
 */
function tandasDe(parrafos, porTanda = env.PREPARAR_PALABRAS_POR_TANDA) {
  const tandas = [];
  let actual = [];
  let cuenta = 0;

  for (const parrafo of parrafos) {
    if (actual.length > 0 && cuenta + parrafo.palabras > porTanda) {
      tandas.push(actual);
      actual = [];
      cuenta = 0;
    }
    actual.push(parrafo);
    cuenta += parrafo.palabras;
  }
  if (actual.length > 0) tandas.push(actual);

  return tandas;
}

/**
 * Ejecuta las tareas con como mucho `ala vez` en vuelo.
 *
 * El proceso de Node es UNO y lo comparten el conector, la web y esto. Soltar
 * treinta peticiones a la vez no las hace más rápidas —el tope lo pone Google—
 * y sí deja al tesista que está en el chat esperando. Ver
 * `PREPARAR_TANDAS_A_LA_VEZ`.
 */
async function enParalelo(tareas, aLaVez) {
  const resultados = new Array(tareas.length);
  let siguiente = 0;

  const obrero = async () => {
    for (;;) {
      const mio = siguiente++;
      if (mio >= tareas.length) return;
      resultados[mio] = await tareas[mio]();
    }
  };

  await Promise.all(Array.from({ length: Math.min(aLaVez, tareas.length) }, obrero));
  return resultados;
}

// ── Comprobar lo que devuelve ──────────────────────────────────────────────

/** Las tiras de dígitos del texto, en orden. «3,5 %» y «3.5%» dan lo mismo. */
const cifrasDe = (texto) => String(texto).match(/\d+/g) ?? [];

/**
 * Cuánto puede crecer o encoger un párrafo, en caracteres, según lo que se le
 * haya pedido.
 *
 * Corregir el inglés casi no cambia el largo. Traducir, sí, y mucho: el chino
 * escribe en un tercio de los caracteres lo que el español en uno entero, y al
 * revés. Los márgenes son anchos a propósito —esto busca desastres (un párrafo
 * vaciado, un párrafo sustituido por «I cannot help with that»), no
 * diferencias de estilo—.
 */
function margenes({ servicio, idioma }) {
  if (servicio === 'EDICION') return { minimo: 0.6, maximo: 1.8 };
  if (idioma === 'zh') return { minimo: 0.15, maximo: 1.2 };
  return { minimo: 0.45, maximo: 2.2 };
}

/** Frases con las que un modelo se niega o comenta. Ninguna es texto académico. */
const EXCUSAS =
  /^(i (cannot|can't|am unable|apologize)|lo siento|no puedo|as an ai|i'm sorry|nota( del| de la)? (traductor|editor)|\[?nota:)/i;

/**
 * Null si el texto nuevo sirve; si no, por qué no.
 *
 * Los motivos se escriben para el log y para el informe que ve el cliente, así
 * que dicen qué pasó y no «no válido».
 */
function comprobar(original, nuevo, opciones) {
  if (typeof nuevo !== 'string') return 'el modelo no devolvió este párrafo';

  const limpio = nuevo.trim();
  if (limpio === '') return 'el modelo devolvió el párrafo vacío';
  if (EXCUSAS.test(limpio)) return 'el modelo contestó con una excusa en vez de con el texto';

  // Una línea en blanco en medio es el modelo partiendo el párrafo en dos. En
  // el Word eso desplazaría todo lo que va detrás.
  if (/\n\s*\n/.test(limpio)) return 'el modelo partió el párrafo en dos';

  const antes = cifrasDe(original);
  const despues = cifrasDe(limpio);
  if (antes.join('|') !== despues.join('|')) {
    return `las cifras no son las mismas: «${antes.join(', ')}» → «${despues.join(', ')}»`;
  }

  const { minimo, maximo } = margenes(opciones);
  const largoAntes = original.trim().length;
  const largoDespues = limpio.length;
  if (largoAntes >= 60 && largoDespues < largoAntes * minimo) {
    return 'el texto nuevo es mucho más corto que el original';
  }
  if (largoAntes >= 40 && largoDespues > largoAntes * maximo) {
    return 'el texto nuevo es mucho más largo que el original';
  }

  return null;
}

// ── Cuando Google está saturado ────────────────────────────────────────────

/**
 * El fallo que no es culpa de nadie: el proveedor no nos deja preguntar ahora.
 *
 * Dos cosas distintas que se tratan igual porque se arreglan igual —esperando—:
 * que el modelo esté desbordado («This model is currently experiencing high
 * demand») y que hayamos llegado al tope de peticiones de nuestro plan («You
 * exceeded your current quota», 429).
 *
 * EL 22-SEP-2026 ESTO NO RECONOCÍA LA CUOTA. Un manuscrito de 12.164 palabras
 * —catorce tandas— se topó con el tope del plan gratuito (20 peticiones) y el
 * texto de Google no encajaba aquí: dice «rate-limits» con guion y esto pedía
 * «rate limit» con espacio. Así que no se esperaba, la tanda se daba por
 * perdida, y cada uno de sus párrafos se volvía a pedir POR SEPARADO contra el
 * mismo tope. El corte se multiplicaba por veinte y el cliente recibía el error
 * de Google en inglés.
 */
const SATURADO =
  /high demand|overload|unavailable|too many requests|rate.?limit|quota|resource.?exhausted|\b429\b|\b503\b/i;

const REINTENTOS = 2;
const ESPERA_MS = 6_000;

/**
 * Y de esos, el que NO se arregla esperando un poco más: se acabó el cupo.
 *
 * La diferencia importa y mucho. Un 503 es este modelo y ahora mismo: se espera
 * dos segundos, se reintenta el párrafo solo y casi siempre sale. Un 429 por
 * cuota es NUESTRO plan contra el reloj de Google, y entonces reintentar cada
 * párrafo por separado es pedir veinte veces lo que ya nos ha dicho que no y
 * quedarnos sin las peticiones que faltan para el resto del documento.
 *
 * Por eso solo esto para las tandas que quedan y da el trabajo por fallido.
 */
const AGOTADO = /exceeded your current quota|quota exceeded|resource.?exhausted|\b429\b/i;

const seAcaboElCupo = (error) =>
  error?.status === 429 || AGOTADO.test(String(error?.message ?? ''));

/** Lo más que se espera de una vez. Un trabajo puede aguantarlo; el chat no. */
const ESPERA_MAXIMA_MS = 90_000;

/**
 * Lo que se le dice al cliente cuando el proveedor nos cortó a mitad.
 *
 * El trabajo se da por FALLIDO aunque algunas tandas hubieran salido: un
 * manuscrito corregido a medias, cobrado como documento del mes, es peor que no
 * haber empezado. Que falle no le gasta cupo y puede volver a mandarlo.
 */
const SIN_CUPO_DEL_PROVEEDOR =
  'Nuestro proveedor de inteligencia artificial nos cortó por tope de uso mientras preparábamos ' +
  'tu documento, así que no lo terminamos y no te hemos descontado ningún documento de tu ' +
  'membresía. Vuelve a mandarlo en unos minutos. Si te pasa otra vez con el mismo documento, ' +
  'escríbenos y lo miramos nosotros.';

const dormir = (ms) => new Promise((listo) => setTimeout(listo, ms));

/**
 * El mismo `generar`, pero esperando y volviendo a probar si está saturado.
 *
 * Solo ante la saturación: un JSON mal formado o una respuesta que no pasa la
 * comprobación ya tienen su propio camino —se vuelve a pedir el párrafo solo—,
 * y reintentar lo que falla por su contenido es gastar dinero para obtener lo
 * mismo. La espera crece en cada vuelta porque un pico de demanda dura
 * segundos, no milisegundos.
 *
 * Sin esto, un resumen entero se perdía porque Google estaba ocupado en ese
 * instante. Al cliente no se le cobraba, pero tenía que volver a subirlo.
 */
function conReintento(generar, opciones = {}) {
  const { intentos = REINTENTOS, esperaMs = ESPERA_MS } = opciones ?? {};
  return async (peticion) => {
    let ultimo = null;
    for (let intento = 0; intento <= intentos; intento += 1) {
      try {
        return await generar(peticion);
      } catch (error) {
        ultimo = error;
        if (!SATURADO.test(String(error?.message ?? ''))) throw error;
        if (intento === intentos) break;

        // Cuando corta por cuota, Google dice cuánto hay que esperar («retry in
        // 35.7»). Esperar menos es volver a chocar contra el mismo tope.
        const espera = Math.min(
          Math.max(esperaMs * (intento + 1), error?.esperarMs ?? 0),
          ESPERA_MAXIMA_MS,
        );

        logger.warn(
          { intento: intento + 1, esperaMs: espera, err: error.message },
          'Preparar documento: el proveedor no nos deja preguntar; se espera y se vuelve a probar',
        );
        await dormir(espera);
      }
    }
    throw ultimo;
  };
}

// ── Pedirlo ────────────────────────────────────────────────────────────────

/**
 * Una tanda: se manda, se lee el JSON y se comprueba párrafo a párrafo.
 *
 * Devuelve `{ buenos: { id: texto }, malos: [{ id, motivo }] }`. Que falle la
 * llamada entera se deja subir: lo atrapa quien reintenta.
 */
async function pedirTanda(parrafos, opciones, generar) {
  const entrada = Object.fromEntries(parrafos.map((parrafo) => [claveDe(parrafo), parrafo.texto]));
  const palabras = parrafos.reduce((total, parrafo) => total + parrafo.palabras, 0);

  const { texto } = await generar({
    sistema: prompt.sistemaDe(opciones),
    mensajes: [{ rol: 'usuario', texto: JSON.stringify(entrada) }],
    modelos: modelos(),
    maxTokens: tokensPara(palabras),
    timeoutMs: TIMEOUT_MS,
    // Aquí no hay nadie mirando la pantalla: si el proveedor pide medio minuto,
    // se le da. Ver `gemini.generarConRespaldo`.
    esperaMaximaMs: ESPERA_MAXIMA_MS,
    json: true,
  });

  let devuelto;
  try {
    devuelto = JSON.parse(texto);
  } catch {
    throw new Error('El modelo no devolvió un JSON que se pueda leer.');
  }

  const buenos = {};
  const malos = [];
  for (const parrafo of parrafos) {
    const nuevo = devuelto?.[String(claveDe(parrafo))];
    const motivo = comprobar(parrafo.texto, nuevo, opciones);
    if (motivo) malos.push({ id: claveDe(parrafo), motivo });
    else buenos[claveDe(parrafo)] = String(nuevo).trim();
  }

  return { buenos, malos };
}

/**
 * Todos los párrafos preparados, con los que no salieron aparte.
 *
 * EL REINTENTO
 * ------------
 * Un párrafo que no pasa la comprobación se vuelve a pedir SOLO, en su propia
 * llamada. Casi siempre funciona, porque el fallo típico no es que el modelo no
 * sepa traducir ese párrafo: es que en una tanda de quince se dejó uno, juntó
 * dos o se quedó sin tokens. Preguntado solo, no tiene con qué confundirse.
 *
 * Si vuelve a fallar, ese párrafo se queda como estaba. Nunca se entrega un
 * párrafo que no pasó la comprobación.
 */
async function prepararParrafos({
  parrafos,
  servicio,
  idioma,
  generar = gemini.generarConRespaldo,
  aLaVez = env.PREPARAR_TANDAS_A_LA_VEZ,
  porTanda = env.PREPARAR_PALABRAS_POR_TANDA,
  reintento,
}) {
  const opciones = { servicio, idioma };
  const tandas = tandasDe(parrafos, porTanda);
  const pedir = conReintento(generar, reintento);

  // El corte del proveedor, si llega. A partir de ahí no se manda ni una
  // petición más: lo que falta es cupo, no suerte, y cada intento se lo come.
  let cortado = null;

  const resultados = await enParalelo(
    tandas.map((tanda) => async () => {
      const comoMalos = (motivo, sinCupo) => ({
        buenos: {},
        malos: tanda.map((parrafo) => ({ id: claveDe(parrafo), motivo, sinCupo })),
      });

      if (cortado) return comoMalos(cortado.message, true);

      try {
        return await pedirTanda(tanda, opciones, pedir);
      } catch (error) {
        const sinCupo = seAcaboElCupo(error);
        if (sinCupo && !cortado) {
          cortado = error;
          logger.error(
            { err: error.message, servicio, tandas: tandas.length },
            'Preparar documento: se acabó el cupo del proveedor; se paran las tandas que faltan',
          );
        } else if (!sinCupo) {
          logger.warn(
            { err: error.message, servicio, parrafos: tanda.length },
            'Preparar documento: una tanda falló entera; se reintenta párrafo a párrafo',
          );
        }
        return comoMalos(error.message, sinCupo);
      }
    }),
    aLaVez,
  );

  const buenos = Object.assign({}, ...resultados.map((r) => r.buenos));
  const primerosMalos = resultados.flatMap((r) => r.malos);
  const porClave = new Map(parrafos.map((parrafo) => [String(claveDe(parrafo)), parrafo]));

  // La segunda vuelta pide UNA llamada POR PÁRRAFO. Eso arregla que el modelo
  // se dejara uno en una tanda de quince, y con un 503 suele salir a la
  // segunda; contra un tope de peticiones es lo contrario de lo que hay que
  // hacer —veinte llamadas donde ya sobraba una—, así que lo que cayó por
  // quedarnos sin cupo no se reintenta.
  const porReintentar = primerosMalos.filter((malo) => !malo.sinCupo);
  const cortados = primerosMalos.filter((malo) => malo.sinCupo);

  const segundaVuelta = await enParalelo(
    porReintentar.map(({ id }) => async () => {
      const parrafo = porClave.get(String(id));
      try {
        return await pedirTanda([parrafo], opciones, pedir);
      } catch (error) {
        return { buenos: {}, malos: [{ id, motivo: error.message }] };
      }
    }),
    aLaVez,
  );

  for (const vuelta of segundaVuelta) Object.assign(buenos, vuelta.buenos);
  const malos = [...cortados, ...segundaVuelta.flatMap((vuelta) => vuelta.malos)];

  // Un corte a mitad no se entrega. Con la mitad del manuscrito corregida y la
  // otra mitad no, el cliente no sabe qué revisar y encima habría gastado un
  // documento del mes. Falla, no le cuesta nada y lo vuelve a mandar.
  if (cortado) {
    logger.error(
      { err: cortado.message, servicio, cortados: cortados.length, hechos: Object.keys(buenos).length },
      'Preparar documento: el trabajo se da por fallido porque el proveedor nos cortó',
    );
    throw new Error(SIN_CUPO_DEL_PROVEEDOR);
  }

  // Que TODO falle no es «un documento con párrafos intactos»: es que el
  // servicio no funcionó, y entregar el mismo Word que se subió cobrando un
  // documento del cupo sería estafar al cliente.
  if (Object.keys(buenos).length === 0 && parrafos.length > 0) {
    throw new Error(malos[0]?.motivo ?? 'El modelo no devolvió ningún párrafo utilizable.');
  }

  const cambios = {};
  for (const [id, texto] of Object.entries(buenos)) {
    const parrafo = porClave.get(id);
    // Un párrafo devuelto igual no es un cambio: no hace falta tocar su XML.
    if (parrafo && texto !== parrafo.texto) cambios[id] = { original: parrafo.texto, texto };
  }

  return { cambios, malos, tandas: tandas.length };
}

// ── Resúmenes ──────────────────────────────────────────────────────────────

/**
 * Qué parte del documento se le enseña al modelo para escribir el resumen.
 *
 * El principio y el final, no el documento entero. En el principio están el
 * problema, el objetivo y la justificación; en el final, los resultados y las
 * conclusiones. El marco teórico de en medio —que en una tesis es la mitad del
 * documento— no entra en un resumen de 250 palabras y costaría el triple.
 */
function extractoPara(parrafos, presupuesto = 6000) {
  const total = parrafos.reduce((suma, parrafo) => suma + parrafo.palabras, 0);
  if (total <= presupuesto) return { parrafos, recortado: false };

  const mitad = Math.floor(presupuesto / 2);
  const principio = [];
  const final = [];

  let cuenta = 0;
  for (const parrafo of parrafos) {
    if (cuenta + parrafo.palabras > mitad) break;
    principio.push(parrafo);
    cuenta += parrafo.palabras;
  }

  cuenta = 0;
  for (let i = parrafos.length - 1; i >= principio.length; i -= 1) {
    if (cuenta + parrafos[i].palabras > mitad) break;
    final.unshift(parrafos[i]);
    cuenta += parrafos[i].palabras;
  }

  return { parrafos: [...principio, ...final], recortado: true };
}

/** Un campo del resumen que llegó y no está vacío. */
function exigir(valor, campo) {
  const texto = typeof valor === 'string' ? valor.trim() : '';
  if (texto === '') throw new Error(`El modelo no devolvió «${campo}».`);
  return texto;
}

/** El resumen, el abstract y las palabras clave del documento. */
async function resumenDe({ parrafos, generar = gemini.generarConRespaldo, reintento }) {
  const { parrafos: elegidos, recortado } = extractoPara(parrafos);

  const cuerpo = elegidos.map((parrafo) => parrafo.texto).join('\n\n');
  const aviso = recortado
    ? '\n\n[Se te ha dado el principio y el final del trabajo, no el texto completo.]'
    : '';

  const { texto } = await conReintento(generar, reintento)({
    sistema: prompt.RESUMEN,
    mensajes: [{ rol: 'usuario', texto: cuerpo + aviso }],
    modelos: modelos(),
    maxTokens: 4_000,
    timeoutMs: TIMEOUT_MS,
    json: true,
  });

  let devuelto;
  try {
    devuelto = JSON.parse(texto);
  } catch {
    throw new Error('El modelo no devolvió un JSON que se pueda leer.');
  }

  return {
    resumen: exigir(devuelto?.resumen, 'resumen'),
    abstract: exigir(devuelto?.abstract, 'abstract'),
    palabrasClave: exigir(devuelto?.palabrasClave, 'palabras clave'),
    keywords: exigir(devuelto?.keywords, 'keywords'),
    palabrasDelResumen: palabrasDe(devuelto?.resumen ?? ''),
  };
}

module.exports = {
  tandasDe,
  enParalelo,
  comprobar,
  cifrasDe,
  margenes,
  prepararParrafos,
  extractoPara,
  resumenDe,
  conReintento,
  modelos,
  tokensPara,
  seAcaboElCupo,
  SATURADO,
  AGOTADO,
  SIN_CUPO_DEL_PROVEEDOR,
};
