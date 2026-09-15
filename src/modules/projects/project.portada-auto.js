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

const CAMPOS = ['titulo', 'autor', 'asesor', 'carrera', 'grado', 'anio', 'instruccion'];
/**
 * Los del informe estudiantil, que se reconocen SOLO cuando la plantilla se sube
 * desde ese producto. Una portada de tesis no los lleva, y buscarlos en ella
 * podría marcar de más: por eso van aparte y no en la lista de siempre.
 */
const CAMPOS_DE_INFORME = ['curso', 'docente', 'integrantes', 'cicloSeccion'];
/** Con alguno de estos, la portada ya sirve. */
const CAMPOS_QUE_BASTAN = ['titulo', 'autor', 'asesor'];
const ORDEN = ['titulo', 'autor', 'asesor', 'carrera', 'grado', 'anio'];
const ORDEN_CON_INFORME = [...ORDEN, ...CAMPOS_DE_INFORME];

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
  // La línea entera, «Licenciada en psicología»: al rellenarla se decide si se
  // conserva «Licenciada en» o si va la carrera entera (un posgrado).
  grado: (texto) => `{{GRADO|${texto.replace(/[{}|]/g, '')}}}`,
  instruccion: () => '',
  // Del informe estudiantil (ver CAMPOS_DE_INFORME).
  curso: () => '{{CURSO}}',
  docente: () => '{{DOCENTE}}',
  integrantes: () => '{{INTEGRANTES}}',
  cicloSeccion: () => '{{CICLO}}',
};

/** Un texto o un salto de línea dentro de un párrafo. */
const PIEZA_RE = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(?:br|cr)\b[^>]*\/>/g;

/**
 * Las líneas con texto de la portada, numeradas por su párrafo.
 *
 * `partes` son los trozos que separa un salto de línea dentro del mismo
 * párrafo. La portada de la UPN escribe «Angie…», «Sindy…» y «Asesor:» en UN
 * párrafo con saltos, y leído de corrido no se distinguía ni un nombre.
 */
function lineasDe(xml) {
  const lineas = [];
  let numero = 0;
  for (const m of xml.matchAll(partesDePlantilla.PARRAFO_INTERIOR_RE)) {
    const trozos = [''];
    for (const pieza of m[0].matchAll(PIEZA_RE)) {
      if (pieza[1] === undefined) trozos.push('');
      else trozos[trozos.length - 1] += decodificar(pieza[1]);
    }
    const texto = trozos.join('');
    if (texto.trim()) lineas.push({ linea: numero, texto, partes: trozos.filter((t) => t.trim()) });
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

  return { xml: nuevo, puestos: ORDEN_CON_INFORME.filter((c) => puestos.has(c)) };
}

/**
 * Se queda con lo que es verdad: campo conocido, línea que existe y un trozo
 * que está tal cual en esa línea. Un segundo título o un segundo autor —el
 * título partido en dos líneas, una portada para dos autores— se borran en vez
 * de repetir el dato: solo sabemos uno.
 */
function validar(campos, lineas, { tipo = null } = {}) {
  const admitidos = tipo === 'informe' ? [...CAMPOS, ...CAMPOS_DE_INFORME] : CAMPOS;
  const vistos = new Set();
  const validos = [];

  for (const campo of Array.isArray(campos) ? campos : []) {
    if (!campo || !admitidos.includes(campo.campo)) continue;
    if (!Number.isInteger(campo.linea) || typeof campo.texto !== 'string' || !campo.texto.trim()) continue;
    const linea = lineas.find((l) => l.linea === campo.linea);
    if (!linea || !linea.texto.includes(campo.texto)) continue;

    // La carrera puede salir dos veces —«Carrera de Psicología» y «Licenciada en
    // Psicología»— y las dos son del tesista; un segundo autor, no.
    if (campo.campo !== 'instruccion' && campo.campo !== 'carrera' && vistos.has(campo.campo)) {
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
  '- grado: la línea ENTERA con el grado cuando va sola, debajo de «Tesis para optar…»: ' +
    '«Licenciada en psicología», «Maestro en Educación».',
  '- anio: el año o el trozo de año que haya («2024», «20»).',
  '- instruccion: indicaciones para quien rellena, como «(Aquí debe ir su nombre)», y el ORCID, ' +
    'el correo o la web del autor o del asesor de ejemplo.',
  '',
  '«texto» tiene que ser un trozo EXACTO de esa línea, copiado carácter por carácter.',
  'Un « | » dentro de una línea es un salto de línea: «texto» no puede incluirlo.',
  'Si hay varios autores, una entrada «autor» por cada uno.',
  'NO marques: la universidad, la facultad, la escuela, la ciudad, el país, «Tesis para optar…», ' +
    'las etiquetas («AUTOR», «ASESOR», «JURADO»), las líneas de investigación ni las líneas de ' +
    'puntos. Si algo no está, no lo incluyas ni lo inventes.',
].join('\n');

async function clasificarConGemini(lineas) {
  if (!env.asistenteEnabled) throw new Error('Gemini sin configurar');

  const { texto } = await generarConRespaldo({
    modelos: [env.GEMINI_MODEL, env.GEMINI_MODEL_RESPALDO].filter(Boolean),
    sistema: SISTEMA,
    mensajes: [
      {
        rol: 'usuario',
        texto: lineas.map((l) => `${l.linea}: ${(l.partes ?? [l.texto]).join(' | ')}`).join('\n'),
      },
    ],
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

/**
 * Las etiquetas de una carátula de trabajo de curso.
 *
 * Solo se buscan cuando la plantilla se sube desde el informe: «Docente» y
 * «Curso» aparecen también en portadas de tesis («Docente asesor», «Curso de
 * titulación») y marcarlas ahí cambiaría lo que ya funciona.
 */
const ETIQUETA_INFORME_RE =
  /^\s*(autor(?:a|es|as)?|asesor(?:a)?|curso|asignatura|docente|profesor(?:a)?|integrantes|alumn[oa]s|estudiantes|ciclo|secci[oó]n)\s*:?\s*$/i;
const EN_LINEA_INFORME_RE =
  /^\s*(autor(?:a|es|as)?|asesor(?:a)?|curso|asignatura|docente|profesor(?:a)?|integrantes|alumn[oa]s|estudiantes|ciclo|secci[oó]n)\s*:\s*(\S.*?)\s*$/i;
const ETIQUETA_DENTRO_INFORME_RE =
  /(?=\b(?:autor(?:a|es|as)?|asesor(?:a)?|curso|asignatura|docente|profesor(?:a)?|integrantes|alumn[oa]s|estudiantes|ciclo|secci[oó]n)\s*:)/i;

/** De la etiqueta al campo. Sin coincidencia, el dato que sigue es del autor. */
function campoDeEtiqueta(etiqueta) {
  const texto = String(etiqueta).toLowerCase();
  if (/asesor/.test(texto)) return 'asesor';
  if (/curso|asignatura/.test(texto)) return 'curso';
  if (/docente|profesor/.test(texto)) return 'docente';
  if (/integrante|alumn|estudiante/.test(texto)) return 'integrantes';
  if (/ciclo|secci/.test(texto)) return 'cicloSeccion';
  return 'autor';
}
const CARRERA_RE =
  /(?:optar|obtener)\b.*?\b(?:licenciad[oa]|ingenier[oa]|abogad[oa]|maestr[oa]|doctor(?:a)?|bachiller|contador(?:a)? p[uú]blic[oa]|m[eé]dic[oa] cirujan[oa]|arquitect[oa]|economista|obstetra|enfermer[oa]|cirujano dentista|profesor(?:a)?|segunda especialidad)\s+(?:en|de)\s+(.+?)\s*$/i;
const ANIO_RE = /((?:19|20)\d{0,2})\s*$/;
const FIJO_RE =
  /universidad|facultad|escuela|tesis|optar|obtener|autor|asesor|jurado|l[ií]nea|lima|per[uú]|programa|grado|t[ií]tulo profesional|investigaci[oó]n/i;
const SOLO_PUNTOS_RE = /^[.…·_\-–—\s]+$/;
/** Lo que empieza por texto fijo no es el título, aunque diga «universidad» más adelante. */
const FIJO_INICIO_RE =
  /^\W*(?:universidad|facultad|escuela|tesis|l[ií]neas?\b|programa|carrera|t[ií]tulo|grado|lima|autor|asesor|jurado)/i;
/** El ORCID o la web del asesor de ejemplo, debajo de su nombre. */
const ENLACE_RE = /orcid|https?:?\/\/|www\./i;
/** «Carrera de PSICOLOGÍA». */
const CARRERA_DE_RE = /^\s*carrera\s+(?:profesional\s+)?de\s+(.+?)\s*$/i;
/**
 * Dónde empieza una etiqueta a mitad de línea. La portada de la UPN deja
 * «…Sanchez Sobrado Asesor:» en el mismo texto, sin salto: hay que partirlo.
 */
const ETIQUETA_DENTRO_RE = /(?=\b(?:autor(?:a|es|as)?|asesor(?:a)?)\s*:)/i;
/** El grado en la línea siguiente a «Tesis para optar al título profesional de:». */
const GRADO_RE =
  /^\s*(?:licenciad[oa]|ingenier[oa]|abogad[oa]|maestr[oa]|doctor(?:a)?|bachiller|contador(?:a)? p[uú]blic[oa]|m[eé]dic[oa] cirujan[oa]|arquitect[oa]|economista|obstetra|enfermer[oa]|cirujano dentista|profesor(?:a)?)\s+(?:en|de)\s+(.+?)\s*$/i;

function clasificarConReglas(lineas, { tipo = null } = {}) {
  const esInforme = tipo === 'informe';
  const ETIQUETA = esInforme ? ETIQUETA_INFORME_RE : ETIQUETA_RE;
  const EN_LINEA = esInforme ? EN_LINEA_INFORME_RE : EN_LINEA_RE;
  const ETIQUETA_DENTRO = esInforme ? ETIQUETA_DENTRO_INFORME_RE : ETIQUETA_DENTRO_RE;
  const campos = [];
  // Cada trozo entre saltos de línea, con el párrafo al que pertenece.
  const tramos = [];

  for (const l of lineas) {
    for (const parte of l.partes ?? [l.texto]) {
      for (const m of parte.matchAll(INSTRUCCION_RE)) {
        campos.push({ linea: l.linea, campo: 'instruccion', texto: m[0] });
      }
      const limpio = parte.replace(INSTRUCCION_RE, ' ').trim();
      for (const trozo of limpio.split(ETIQUETA_DENTRO).map((t) => t.trim())) {
        if (trozo && !SOLO_PUNTOS_RE.test(trozo)) tramos.push({ linea: l.linea, texto: trozo });
      }
    }
  }

  let primeraEtiqueta = null;
  tramos.forEach((t, i) => {
    const etiqueta = ETIQUETA.exec(t.texto);
    if (etiqueta) {
      primeraEtiqueta ??= t.linea;
      const campo = campoDeEtiqueta(etiqueta[1]);
      // Todos los nombres que siguen, hasta la próxima etiqueta o texto fijo:
      // el primero es el dato y los demás —un segundo autor— se borran al
      // validar. El ORCID de ejemplo se borra también.
      for (const siguiente of tramos.slice(i + 1)) {
        if (ETIQUETA.test(siguiente.texto) || EN_LINEA.test(siguiente.texto)) break;
        if (ENLACE_RE.test(siguiente.texto)) {
          campos.push({ linea: siguiente.linea, campo: 'instruccion', texto: siguiente.texto });
          continue;
        }
        const fijo =
          FIJO_RE.test(siguiente.texto) ||
          ANIO_RE.test(siguiente.texto) ||
          CARRERA_DE_RE.test(siguiente.texto) ||
          GRADO_RE.test(siguiente.texto);
        if (fijo) break;
        campos.push({ linea: siguiente.linea, campo, texto: siguiente.texto });
      }
      return;
    }

    const enLinea = EN_LINEA.exec(t.texto);
    if (enLinea && !SOLO_PUNTOS_RE.test(enLinea[2])) {
      primeraEtiqueta ??= t.linea;
      // Con las etiquetas de siempre esto da «autor» o «asesor», como antes; en un
      // informe reconoce además curso, docente, integrantes y ciclo.
      campos.push({ linea: t.linea, campo: campoDeEtiqueta(enLinea[1]), texto: enLinea[2] });
      return;
    }

    const carreraDe = CARRERA_DE_RE.exec(t.texto);
    if (carreraDe) {
      campos.push({ linea: t.linea, campo: 'carrera', texto: carreraDe[1] });
      return;
    }

    const carrera = CARRERA_RE.exec(t.texto);
    if (carrera) {
      campos.push({ linea: t.linea, campo: 'carrera', texto: carrera[1] });
      return;
    }

    const grado = GRADO_RE.exec(t.texto);
    if (grado && i > 0 && /optar|obtener/i.test(tramos[i - 1].texto)) {
      campos.push({ linea: t.linea, campo: 'grado', texto: t.texto });
      return;
    }

    const anio = ANIO_RE.exec(t.texto);
    if (anio && (/lima|per[uú]/i.test(t.texto) || t.texto === anio[1])) {
      campos.push({ linea: t.linea, campo: 'anio', texto: anio[1] });
    }
  });

  // El título: la línea más larga antes de «AUTOR» que no empiece por texto
  // fijo. Solo si hay esa etiqueta: sin ella, cualquier documento con una línea
  // larga pasaría por portada.
  const ocupadas = new Set(campos.filter((c) => c.campo !== 'instruccion').map((c) => c.linea));
  const titulo = tramos
    .filter((t) => primeraEtiqueta !== null && t.linea < primeraEtiqueta)
    .filter((t) => !ocupadas.has(t.linea))
    .filter((t) => t.texto.length >= 20 && !FIJO_INICIO_RE.test(t.texto) && !CARRERA_RE.test(t.texto))
    .sort((a, b) => b.texto.length - a.texto.length)[0];
  if (titulo) campos.push({ linea: titulo.linea, campo: 'titulo', texto: titulo.texto });

  return campos;
}

// ── El encabezado y el pie ─────────────────────────────────────────────────

/** «Paico, A.; Sánchez, S.»: los autores de ejemplo en un pie de página. */
const AUTORES_CORTOS_RE =
  /^\s*\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?,\s*\p{Lu}\.(?:\s*\p{Lu}\.)?(?:\s*(?:[;,&]|\by\b)\s*\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?,\s*\p{Lu}\.(?:\s*\p{Lu}\.)?)*\s*$/u;

const normalizar = (texto) =>
  String(texto)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ');

/**
 * ¿Es este párrafo un trozo del título de la portada, escrito de otra manera?
 *
 * El encabezado de la UPN lo pone en minúsculas, sin comillas, con el año y
 * partido en dos párrafos, así que se mira cada párrafo por su cuenta: siete de
 * cada diez de sus palabras largas tienen que ser del título.
 */
function parteDelTitulo(texto, titulo) {
  const delTitulo = new Set(normalizar(titulo).split(' ').filter((p) => p.length >= 4));
  const suyas = normalizar(texto).split(' ').filter((p) => p.length >= 4);
  if (delTitulo.size < 3 || suyas.length < 2) return false;
  return suyas.filter((p) => delTitulo.has(p)).length / suyas.length >= 0.7;
}

function ponerEnParrafo(parrafo, texto) {
  let i = 0;
  return parrafo.replace(TEXTO_RE, () => (i++ === 0 ? `<w:t xml:space="preserve">${texto}</w:t>` : '<w:t></w:t>'));
}

/**
 * El título y los autores de la tesis de ejemplo, fuera del encabezado y el pie.
 *
 * Se cambian por marcas que se rellenan al descargar, como la portada. Sin esto,
 * el encabezado de la plantilla ponía en cada página el título de otra tesis y
 * el pie los apellidos de otras personas. Un encabezado fijo —el nombre de la
 * universidad— no se toca.
 */
function marcarCabeceras(partes, tituloDeEjemplo) {
  const cambiar = (xml, esEncabezado) => {
    // El título partido en varios párrafos seguidos va entero en el primero y
    // los demás se vacían. Cada cuadro de texto es un título aparte: la copia
    // antigua que guarda Word también tiene que llevarlo.
    let seguido = false;
    let finAnterior = 0;
    // Lo que ocupaba el título de ejemplo en el primer cuadro: si el del
    // tesista es más largo, al descargar se achica la letra (ver `aplicar`).
    let grupos = 0;
    let largo = 0;
    const resultado = xml.replace(partesDePlantilla.PARRAFO_INTERIOR_RE, (parrafo, posicion) => {
      if (/<\/?w:txbxContent\b/.test(xml.slice(finAnterior, posicion))) seguido = false;
      finAnterior = posicion + parrafo.length;

      const texto = [...parrafo.matchAll(TEXTO_RE)].map((t) => decodificar(t[2])).join('');
      if (!texto.trim()) return parrafo;
      if (AUTORES_CORTOS_RE.test(texto)) {
        seguido = false;
        return ponerEnParrafo(parrafo, '{{AUTORCORTO}}');
      }
      if (esEncabezado && tituloDeEjemplo && parteDelTitulo(texto, tituloDeEjemplo)) {
        const primero = !seguido;
        seguido = true;
        if (primero) grupos += 1;
        if (grupos === 1) largo += texto.trim().length;
        return ponerEnParrafo(parrafo, primero ? '{{TITULO}}' : '');
      }
      seguido = false;
      return parrafo;
    });
    return { xml: resultado, largo };
  };

  for (const [grupo, esEncabezado] of [[partes?.encabezados, true], [partes?.pies, false]]) {
    for (const tipo of Object.keys(grupo ?? {})) {
      const { xml, largo } = cambiar(grupo[tipo].xml, esEncabezado);
      grupo[tipo] = { ...grupo[tipo], xml, ...(largo > 0 ? { largoDelTitulo: largo } : {}) };
    }
  }
  return partes;
}

/**
 * Convierte la portada candidata en una con marcas, o la descarta.
 *
 * `clasificar` existe para las pruebas. Nunca lanza: si todo falla, la portada
 * no se usa y la plantilla se guarda igual con lo demás.
 */
async function prepararPortada(partes, { clasificar = clasificarConGemini, tipo = null } = {}) {
  const candidata = partes?.portadaCandidata;
  // Sin portada no hay título de ejemplo que buscar, pero los autores del pie sí.
  if (!candidata) return partes ? marcarCabeceras(partes, null) : partes;
  delete partes.portadaCandidata;

  const lineas = lineasDe(candidata.xml);
  let campos = [];
  let origen = 'gemini';

  // En el informe se va directo a las reglas: el prompt de Gemini describe una
  // portada de tesis y no sabe de cursos ni de docentes.
  if (tipo !== 'informe') {
    try {
      campos = validar(await clasificar(lineas), lineas);
    } catch (error) {
      logger.warn({ err: error.message }, 'No se pudo leer la portada con Gemini; se usan las reglas');
    }
  }

  const reglas = validar(clasificarConReglas(lineas, { tipo }), lineas, { tipo });
  if (!campos.some((c) => CAMPOS_QUE_BASTAN.includes(c.campo))) {
    campos = reglas;
    origen = 'reglas';
  } else {
    // Lo que Gemini no vio y las reglas sí. Con la portada de la UPN, Gemini
    // encontró título, autor y asesor, pero dejó el ORCID del asesor de ejemplo
    // y «Licenciada en psicología», y el tesista los vio en su Word.
    const vistas = new Set(campos.map((c) => c.linea));
    const extra = reglas.filter((c) => c.campo === 'instruccion' || !vistas.has(c.linea));
    campos = validar([...campos, ...extra], lineas, { tipo });
  }

  // Cuánto ocupaban los datos de ejemplo: si los del tesista son más largos, al
  // descargar se compacta la portada para que no pase a una segunda hoja.
  const largoDe = (campo) =>
    campos.filter((c) => c.campo === campo).reduce((suma, c) => suma + c.texto.length, 0);
  partes.largosDeEjemplo = {
    titulo: largoDe('titulo'),
    autor: largoDe('autor'),
    asesor: largoDe('asesor'),
    // La carrera sale dos veces («Carrera de X», «Licenciada en X»): basta la primera.
    carrera: campos.find((c) => c.campo === 'carrera')?.texto.length ?? 0,
  };

  const { xml, puestos } = marcar(candidata.xml, campos);
  if (puestos.some((c) => CAMPOS_QUE_BASTAN.includes(c))) {
    partes.portada = { ...candidata, xml };
    partes.camposDePortada = puestos;
  } else {
    partes.portadaSinMarcas = true;
  }

  // El título de ejemplo, para encontrarlo también en el encabezado.
  const tituloDeEjemplo = campos.filter((c) => c.campo === 'titulo').map((c) => c.texto).join(' ');
  marcarCabeceras(partes, tituloDeEjemplo || null);

  // Sin el texto: solo qué se encontró y cómo.
  logger.info({ origen, campos: partes.camposDePortada ?? [] }, 'Portada de plantilla leída');
  return partesDePlantilla.podarMedios(partes);
}

module.exports = {
  prepararPortada,
  clasificarConReglas,
  lineasDe,
  marcar,
  validar,
  marcarCabeceras,
  parteDelTitulo,
};
