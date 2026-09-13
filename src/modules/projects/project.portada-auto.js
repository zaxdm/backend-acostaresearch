'use strict';

/**
 * La portada de la plantilla, sin que el tesista escriba nada.
 *
 * POR QUÉ EXISTE
 * --------------
 * Pedirle al tesista que abra la plantilla de su facultad y escriba {{TITULO}},
 * {{AUTOR}}… donde van sus datos era trabajo, y el trabajo desanima. Así que la
 * sube tal cual y aquí se descubre dónde va cada dato: el título de ejemplo, el
 * nombre del autor de ejemplo, el asesor, la carrera, el año y las
 * instrucciones entre paréntesis («(Aquí debe ir su nombre)»). Se cambian por
 * marcas —las mismas que se rellenan al descargar— y los datos de ejemplo se
 * borran: el nombre de otra persona nunca llega a guardarse.
 *
 * CÓMO SE DESCUBRE
 * ----------------
 * Primero Gemini, con SOLO el texto de la portada, línea a línea: ni la tesis,
 * ni quién la sube, ni el resto de la plantilla. Cada portada es distinta y
 * unas reglas fijas se equivocan a la tercera universidad. Gemini devuelve qué
 * trozo exacto de qué línea es cada dato, y aquí se comprueba que ese trozo
 * existe tal cual: lo que no cuadra, se descarta.
 *
 * Si Gemini no está configurado o falla, unas reglas sencillas cubren lo común
 * en las portadas peruanas: «AUTOR» / «ASESOR» con el nombre debajo, «título
 * profesional de Licenciado en …», el año al final de «Lima – Perú».
 *
 * Si no se reconoce ni el título, ni el autor, ni el asesor, la portada no se
 * usa y el Word sale con la nuestra. Mejor eso que una portada con los datos
 * de otra persona.
 */

const env = require('../../config/env');
const logger = require('../../config/logger');
const { generarConRespaldo } = require('../../lib/gemini');
const partesDePlantilla = require('./project.plantilla-partes');

const CAMPOS = ['titulo', 'autor', 'asesor', 'carrera', 'anio', 'instruccion'];
/** Con alguno de estos, la portada ya sirve. */
const CAMPOS_QUE_BASTAN = ['titulo', 'autor', 'asesor'];
const ORDEN = ['titulo', 'autor', 'asesor', 'carrera', 'anio'];

const TEXTO_RE = /(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g;

const decodificar = (texto) =>
  texto
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
const escapar = (texto) => texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** La marca que sustituye a cada dato. La carrera guarda la de la plantilla de respaldo. */
const MARCA_DE = {
  titulo: () => '{{TITULO}}',
  autor: () => '{{AUTOR}}',
  asesor: () => '{{ASESOR}}',
  anio: () => '{{AÑO}}',
  carrera: (texto) => `{{CARRERA|${texto.replace(/[{}|]/g, '')}}}`,
  instruccion: () => '',
};

/** Las líneas con texto de la portada, numeradas por su párrafo. */
function lineasDe(xml) {
  const lineas = [];
  let numero = 0;
  for (const m of xml.matchAll(partesDePlantilla.PARRAFO_INTERIOR_RE)) {
    const texto = [...m[0].matchAll(TEXTO_RE)].map((t) => decodificar(t[2])).join('');
    if (texto.trim()) lineas.push({ linea: numero, texto });
    numero += 1;
  }
  return lineas;
}

/**
 * Cambia un tramo del texto de un párrafo, repartido en corridas.
 *
 * Lo nuevo va en la corrida donde empezaba lo que se quita, y así hereda SU
 * formato: si «(Aquí debe ir su nombre)» estaba en rojo y el nombre en negro, el
 * dato sale en negro.
 */
function reemplazarEnCorridas(textos, inicio, fin, nuevo) {
  const salida = [];
  let posicion = 0;
  let puesto = false;

  textos.forEach((texto, i) => {
    const desde = posicion;
    const hasta = posicion + texto.length;
    posicion = hasta;

    const esUltima = i === textos.length - 1;
    const empiezaAqui = !puesto && inicio >= desde && (inicio < hasta || (esUltima && inicio === hasta));
    const toca = fin > desde && inicio < hasta;

    if (!empiezaAqui && !toca) {
      salida.push(texto);
      return;
    }

    const corteInicial = Math.max(0, inicio - desde);
    const corteFinal = Math.min(texto.length, Math.max(0, fin - desde));
    if (empiezaAqui) {
      salida.push(texto.slice(0, corteInicial) + nuevo + texto.slice(corteFinal));
      puesto = true;
    } else {
      salida.push(texto.slice(0, corteInicial) + texto.slice(corteFinal));
    }
  });

  return salida;
}

/** Pone las marcas en la portada. Devuelve el XML y qué datos se pusieron. */
function marcar(xml, campos) {
  const porLinea = new Map();
  for (const campo of campos) {
    if (!porLinea.has(campo.linea)) porLinea.set(campo.linea, []);
    porLinea.get(campo.linea).push(campo);
  }

  const puestos = new Set();
  let numero = -1;

  const nuevo = xml.replace(partesDePlantilla.PARRAFO_INTERIOR_RE, (parrafo) => {
    numero += 1;
    const lista = porLinea.get(numero);
    if (!lista) return parrafo;

    let textos = [...parrafo.matchAll(TEXTO_RE)].map((t) => decodificar(t[2]));
    const junto = textos.join('');

    // Cada trozo, en su primera aparición que no pise a otro.
    const tramos = [];
    for (const campo of lista) {
      let desde = 0;
      let inicio;
      while ((inicio = junto.indexOf(campo.texto, desde)) !== -1) {
        const fin = inicio + campo.texto.length;
        if (!tramos.some((t) => inicio < t.fin && fin > t.inicio)) {
          tramos.push({ inicio, fin, campo });
          break;
        }
        desde = inicio + 1;
      }
    }
    if (tramos.length === 0) return parrafo;

    // De atrás adelante, para que cambiar uno no corra las posiciones de otro.
    tramos.sort((a, b) => b.inicio - a.inicio);
    for (const { inicio, fin, campo } of tramos) {
      textos = reemplazarEnCorridas(textos, inicio, fin, MARCA_DE[campo.campo](campo.texto));
      if (campo.campo !== 'instruccion') puestos.add(campo.campo);
    }

    let i = 0;
    return parrafo.replace(TEXTO_RE, () => `<w:t xml:space="preserve">${escapar(textos[i++] ?? '')}</w:t>`);
  });

  return { xml: nuevo, puestos: ORDEN.filter((c) => puestos.has(c)) };
}

/**
 * Se queda con lo que es verdad: campo conocido, línea que existe y un trozo
 * que está tal cual en esa línea. Un segundo título o un segundo autor —el
 * título partido en dos líneas, una portada para dos autores— se borran en vez
 * de repetir el dato: solo sabemos uno.
 */
function validar(campos, lineas) {
  const vistos = new Set();
  const validos = [];

  for (const campo of Array.isArray(campos) ? campos : []) {
    if (!campo || !CAMPOS.includes(campo.campo)) continue;
    if (!Number.isInteger(campo.linea) || typeof campo.texto !== 'string' || !campo.texto.trim()) continue;
    const linea = lineas.find((l) => l.linea === campo.linea);
    if (!linea || !linea.texto.includes(campo.texto)) continue;

    if (campo.campo !== 'instruccion' && vistos.has(campo.campo)) {
      validos.push({ ...campo, campo: 'instruccion' });
      continue;
    }
    vistos.add(campo.campo);
    validos.push({ linea: campo.linea, campo: campo.campo, texto: campo.texto });
  }
  return validos;
}

// ── Con Gemini ─────────────────────────────────────────────────────────────

const SISTEMA = [
  'Recibes las líneas de la PORTADA de una plantilla de tesis de una universidad, numeradas.',
  'La plantilla trae datos DE EJEMPLO —el título de otra tesis, el nombre de otro autor y de ' +
    'otro asesor— y a veces instrucciones para quien la rellena. Señala dónde están los datos ' +
    'que cambian de un tesista a otro.',
  '',
  'Responde SOLO con un JSON así: {"campos":[{"linea":N,"campo":"...","texto":"..."}]}',
  '',
  'campo es uno de:',
  '- titulo: el título de la tesis de ejemplo (si ocupa varias líneas, una entrada por línea).',
  '- autor: solo el nombre de quien la escribe, sin la etiqueta «AUTOR:» ni «Bach.».',
  '- asesor: solo el nombre del asesor o asesora, con su grado si va pegado («Dr. …»), sin la ' +
    'etiqueta «ASESOR:».',
  '- carrera: solo el nombre de la carrera en frases como «título profesional de Licenciado en ' +
    'Psicología» → «Psicología».',
  '- anio: el año o el trozo de año que haya («2024», «20»).',
  '- instruccion: indicaciones para quien rellena, como «(Aquí debe ir su nombre)».',
  '',
  '«texto» tiene que ser un trozo EXACTO de esa línea, copiado carácter por carácter.',
  'NO marques: la universidad, la facultad, la escuela, la ciudad, el país, «Tesis para optar…», ' +
    'las etiquetas («AUTOR», «ASESOR», «JURADO»), las líneas de investigación ni las líneas de ' +
    'puntos. Si algo no está, no lo incluyas ni lo inventes.',
].join('\n');

async function clasificarConGemini(lineas) {
  if (!env.asistenteEnabled) throw new Error('Gemini sin configurar');

  const { texto } = await generarConRespaldo({
    modelos: [env.GEMINI_MODEL, env.GEMINI_MODEL_RESPALDO].filter(Boolean),
    sistema: SISTEMA,
    mensajes: [{ rol: 'usuario', texto: lineas.map((l) => `${l.linea}: ${l.texto}`).join('\n') }],
    maxTokens: 1500,
    timeoutMs: 15_000,
  });

  const json = texto.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error('Gemini no devolvió JSON');
  const { campos } = JSON.parse(json);
  if (!Array.isArray(campos)) throw new Error('El JSON de Gemini no trae campos');
  return campos;
}

// ── Con reglas, si no hay Gemini ───────────────────────────────────────────

const INSTRUCCION_RE =
  /\(\s*(?:aqu[ií]|el nombre|nombre|escrib|coloqu|ingres|indiq|poner|consign)[^)]*\)/gi;
const ETIQUETA_RE = /^\s*(autor(?:a|es|as)?|asesor(?:a)?)\s*:?\s*$/i;
const EN_LINEA_RE = /^\s*(autor(?:a|es|as)?|asesor(?:a)?)\s*:\s*(\S.*?)\s*$/i;
const CARRERA_RE =
  /(?:optar|obtener)\b.*?\b(?:licenciad[oa]|ingenier[oa]|abogad[oa]|maestr[oa]|doctor(?:a)?|bachiller|contador(?:a)? p[uú]blic[oa]|m[eé]dic[oa] cirujan[oa]|arquitect[oa]|economista|obstetra|enfermer[oa]|cirujano dentista|profesor(?:a)?|segunda especialidad)\s+(?:en|de)\s+(.+?)\s*$/i;
const ANIO_RE = /((?:19|20)\d{0,2})\s*$/;
const FIJO_RE =
  /universidad|facultad|escuela|tesis|optar|obtener|autor|asesor|jurado|l[ií]nea|lima|per[uú]|programa|grado|t[ií]tulo profesional|investigaci[oó]n/i;
const SOLO_PUNTOS_RE = /^[.…·_\-–—\s]+$/;

function clasificarConReglas(lineas) {
  const campos = [];
  const util = new Map();

  for (const l of lineas) {
    for (const m of l.texto.matchAll(INSTRUCCION_RE)) {
      campos.push({ linea: l.linea, campo: 'instruccion', texto: m[0] });
    }
    const limpio = l.texto.replace(INSTRUCCION_RE, ' ').trim();
    util.set(l.linea, limpio && !SOLO_PUNTOS_RE.test(limpio) ? limpio : null);
  }

  let primeraEtiqueta = null;
  lineas.forEach((l, i) => {
    const texto = util.get(l.linea);
    if (!texto) return;

    const etiqueta = ETIQUETA_RE.exec(texto);
    if (etiqueta) {
      primeraEtiqueta ??= l.linea;
      const campo = /asesor/i.test(etiqueta[1]) ? 'asesor' : 'autor';
      const siguiente = lineas.slice(i + 1).find((x) => util.get(x.linea));
      const suyo = siguiente && util.get(siguiente.linea);
      if (suyo && !ETIQUETA_RE.test(suyo) && !FIJO_RE.test(suyo)) {
        campos.push({ linea: siguiente.linea, campo, texto: suyo });
      }
      return;
    }

    const enLinea = EN_LINEA_RE.exec(texto);
    if (enLinea && !SOLO_PUNTOS_RE.test(enLinea[2])) {
      primeraEtiqueta ??= l.linea;
      campos.push({ linea: l.linea, campo: /asesor/i.test(enLinea[1]) ? 'asesor' : 'autor', texto: enLinea[2] });
      return;
    }

    const carrera = CARRERA_RE.exec(texto);
    if (carrera) {
      campos.push({ linea: l.linea, campo: 'carrera', texto: carrera[1] });
      return;
    }

    const anio = ANIO_RE.exec(texto);
    if (anio && (/lima|per[uú]/i.test(texto) || texto === anio[1])) {
      campos.push({ linea: l.linea, campo: 'anio', texto: anio[1] });
    }
  });

  // El título: la línea más larga antes de «AUTOR» que no sea texto fijo. Solo
  // si hay esa etiqueta: sin ella, cualquier documento con una línea larga
  // pasaría por portada.
  const ocupadas = new Set(campos.filter((c) => c.campo !== 'instruccion').map((c) => c.linea));
  const titulo = lineas
    .filter((l) => primeraEtiqueta !== null && l.linea < primeraEtiqueta)
    .filter((l) => !ocupadas.has(l.linea))
    .map((l) => ({ linea: l.linea, texto: util.get(l.linea) }))
    .filter((l) => l.texto && l.texto.length >= 20 && !FIJO_RE.test(l.texto))
    .sort((a, b) => b.texto.length - a.texto.length)[0];
  if (titulo) campos.push({ linea: titulo.linea, campo: 'titulo', texto: titulo.texto });

  return campos;
}

/**
 * Convierte la portada candidata en una con marcas, o la descarta.
 *
 * `clasificar` existe para las pruebas. Nunca lanza: si todo falla, la portada
 * no se usa y la plantilla se guarda igual con lo demás.
 */
async function prepararPortada(partes, { clasificar = clasificarConGemini } = {}) {
  const candidata = partes?.portadaCandidata;
  if (!candidata) return partes;
  delete partes.portadaCandidata;

  const lineas = lineasDe(candidata.xml);
  let campos = [];
  let origen = 'gemini';

  try {
    campos = validar(await clasificar(lineas), lineas);
  } catch (error) {
    logger.warn({ err: error.message }, 'No se pudo leer la portada con Gemini; se usan las reglas');
  }

  if (!campos.some((c) => CAMPOS_QUE_BASTAN.includes(c.campo))) {
    campos = validar(clasificarConReglas(lineas), lineas);
    origen = 'reglas';
  }

  const { xml, puestos } = marcar(candidata.xml, campos);
  if (puestos.some((c) => CAMPOS_QUE_BASTAN.includes(c))) {
    partes.portada = { ...candidata, xml };
    partes.camposDePortada = puestos;
  } else {
    partes.portadaSinMarcas = true;
  }

  // Sin el texto: solo qué se encontró y cómo.
  logger.info({ origen, campos: partes.camposDePortada ?? [] }, 'Portada de plantilla leída');
  return partesDePlantilla.podarMedios(partes);
}

module.exports = { prepararPortada, clasificarConReglas, lineasDe, marcar, validar };
