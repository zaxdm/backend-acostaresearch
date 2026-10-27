'use strict';

/**
 * «Humanizar» con la skill del servidor (`./humanizador/`), 21-oct-2026.
 *
 * POR QUÉ NO ES UNA LLAMADA MÁS A `motor.prepararParrafos`
 * --------------------------------------------------------
 * Con un solo prompt para todo el documento, Turnitin dio 84 % de IA. Lo que
 * llevó el mismo Word a 0 % (con DeepSeek v3.2) fue la receta de los trabajos
 * que dieron 0 % con /turnitin:
 *
 *   1. Cada capítulo con su propia instrucción: el núcleo de la skill, la ruta
 *      de ese capítulo (qué plantilla delata en una discusión no es lo mismo que
 *      en una metodología) y ejemplos reales que dieron 0 %. Cada tanda sabe
 *      además cómo abren los párrafos ya hechos, para no repetirlos.
 *   2. Un tercer intento para lo que falla dos veces: un párrafo que se queda en
 *      su original es texto de IA puro, y con eso no se llega a 0 %.
 *   3. Dos pasadas sobre el documento entero: el código cuenta lo que se repite
 *      ENTRE párrafos (aperturas, «Esa brecha… / Eso repercute…», conectores,
 *      relleno) y el modelo cambia solo eso. Es lo que ningún párrafo suelto ve,
 *      y lo que sacó a dos tesis del «*%».
 *
 * Las comprobaciones son las de siempre (`motor.comprobar`): cifras, citas,
 * largo, vocabulario de modelo, rayas y moldes. En la pasada se comparan con
 * el texto ORIGINAL del autor, no con la reescritura, para que valgan todas.
 *
 * Los textos de la skill se editan en `./humanizador/` (ver su LEEME.md); aquí
 * solo se arman.
 */

const fs = require('fs');
const path = require('path');

const env = require('../../config/env');
const gemini = require('../../lib/gemini');
const cuerpo = require('./preparar.cuerpo');
const motor = require('./preparar.motor');
const prompt = require('./preparar.prompt');
const tipografia = require('./preparar.tipografia');
const piezas = require('./preparar.piezas');

const CARPETA = path.join(__dirname, 'humanizador');

// ── La skill ───────────────────────────────────────────────────────────────

/**
 * Qué ruta toca según el título. El orden importa: «Discusión de resultados»
 * es discusión, y «Marco metodológico» es metodología.
 */
const RUTAS = [
  ['conclusiones', /conclusi[oó]n|recomendaci[oó]n/i],
  ['discusion', /discusi[oó]n|limitaciones/i],
  ['resultados', /resultado|prueba de hip[oó]tesis|contrastaci[oó]n|an[aá]lisis (descriptivo|inferencial)|confiabilidad de los/i],
  ['metodologia', /metodolog|m[eé]todo|materiales|dise[nñ]o de (la )?investigaci|tipo (y|de) |poblaci[oó]n|t[eé]cnicas|instrumento|procedimiento|aspectos [eé]ticos|variables/i],
  ['introduccion-marco', /introducci|problema|justificaci|antecedente|marco|bases te[oó]ricas|realidad|resumen|abstract/i],
];

const NOMBRES = {
  'introduccion-marco': 'introducción y marco teórico',
  metodologia: 'metodología',
  resultados: 'resultados',
  discusion: 'discusión',
  conclusiones: 'conclusiones y recomendaciones',
};

const FORMATO = `
ENTRADA: un objeto JSON con
- "seccion": el capítulo al que pertenecen los párrafos;
- "ya_usadas": cómo abren otros párrafos del documento, los ya humanizados y los que se quedan como están. No abras ninguno igual;
- "parrafos": cada clave es el número de un párrafo y cada valor su texto;
- "comparten_plantilla" (si viene): los párrafos de esta tanda que en el original siguen la misma
  plantilla que otros del documento, cada uno con la arquitectura que le toca. Úsala: es lo que
  evita que los hermanos vuelvan a salir parecidos.
- "fallo_anterior" (si viene): por qué se rechazó tu versión anterior de esos párrafos. Corrígelo.

SALIDA: solo un objeto JSON con EXACTAMENTE las claves de "parrafos" y, como valor, el texto
nuevo de ese párrafo. Nada fuera del JSON. Un párrafo por clave: no juntes dos párrafos en uno
ni partas uno en dos, porque el texto vuelve al Word por su número.
`.trim();

const FORMATO_PASADA = `
ENTRADA: un objeto JSON con "ya_usadas" (las aperturas de párrafo que ya hay en el documento) y
"parrafos": cada clave es el número de un párrafo y cada valor, {"texto", "nota"}.

SALIDA: solo un objeto JSON con EXACTAMENTE las claves de "parrafos" y, como valor, el texto
corregido (una cadena). Nada fuera del JSON.
`.trim();

const FORMATO_ROMPER = `
ENTRADA: un objeto JSON con "parrafos": cada clave es el número de un párrafo y cada valor,
{"texto", "repetidas", "parecido_a", "arquitectura"}. "arquitectura" dice cómo abrir y ordenar
ese párrafo: cada uno trae una distinta para que no vuelvan a parecerse entre sí.

SALIDA: solo un objeto JSON con EXACTAMENTE las claves de "parrafos" y, como valor, el texto
nuevo (una cadena). Nada fuera del JSON.
`.trim();

const INSISTIR = `
ATENCIÓN: este párrafo ya se pidió y volvió con algo que delata a una IA, con una cifra o una
cita cambiada, o casi igual al original. Reescríbelo otra vez desde la idea, con otra entrada, y
revisa antes de devolverlo cada cifra y cada cita, y que no lleve dos puntos en medio, «no
solo… sino», «más allá de», rayas (—) ni palabras de la lista QUITA.
`.trim();

/**
 * Con el reporte de IA de Turnitin delante, cada párrafo que llega está
 * marcado. Lo que separó el 0 % del «*%» en la misma tesis (24-oct-2026): la
 * versión que dio 0 % cambió el armado de cada frase marcada y partió oraciones;
 * la que no, las maquilló cambiando dos palabras y las fundió. Ver
 * `motor.comprobarMarcado`, que lo exige.
 */
const MARCADO = `
ESTOS PÁRRAFOS LOS MARCÓ TURNITIN COMO IA. Maquillarlos no basta: cambiar un conector, «todavía» por «seguía» o quitar un «sin embargo» deja la misma frase y vuelve a salir marcada.
- Cada frase se arma de nuevo: otro sujeto, otro verbo, otro orden. De una oración del original no quedan más de tres o cuatro palabras seguidas, salvo nombres, citas, términos técnicos y cifras.
- Verbos corrientes y concretos: «vieron», «obtuvieron», «le ganaban al papel», «se quedó en», en vez de «evidenció», «se constató», «superaban».
- No fundas: en lo marcado sale el mismo número de oraciones que en el original, o más. Parte las largas; ninguna pasa de 45 palabras.
- Las frases de cierre o de balance («La realidad mostró, entonces, una escuela que… y una literatura que…») son las que más marca: dilas de otra forma, más llana, o únelas al dato del que salen.
- Esto manda sobre lo que el núcleo dice de fundir y de las medias de 30 a 40 palabras: en un párrafo marcado no se funde.
- Si un párrafo trae "fallo_anterior", es por qué se rechazó tu versión anterior: corrígelo.
`.trim();

let enMemoria = null;

/** Los textos de la skill. Se leen una vez; `carpeta` sirve para probar otra copia. */
function leerSkill(carpeta = CARPETA) {
  if (carpeta === CARPETA && enMemoria) return enMemoria;
  const leer = (archivo) => fs.readFileSync(path.join(carpeta, archivo), 'utf8').trim();
  const skill = {
    nucleo: leer('nucleo.md'),
    pasada: leer('pasada-documento.md'),
    romper: leer('romper-plantilla.md'),
    rutas: {},
    // Las reglas de /turnitin, del humanizador, de /asesorar y de las skills de
    // capítulo, en piezas que se mandan según lo que trae cada tanda.
    piezas: piezas.leerPiezas(path.join(carpeta, 'piezas'), carpeta === CARPETA),
  };
  for (const ruta of Object.keys(NOMBRES)) {
    skill.rutas[ruta] = `${leer(`rutas/${ruta}.md`)}\n\n${leer(`ejemplos/${ruta}.md`)}`;
  }
  if (carpeta === CARPETA) enMemoria = skill;
  return skill;
}

// MARCADO va al final: el modelo obedece lo último, y tiene que mandar sobre
// lo que el núcleo dice de fundir (24-oct-2026: delante, se fundía igual).
const sistemaDe = (skill, ruta, insistir, extras, estricto = false) =>
  [skill.nucleo, skill.rutas[ruta], extras, FORMATO, insistir ? INSISTIR : null, estricto ? MARCADO : null]
    .filter(Boolean)
    .join('\n\n');

// ── El documento por capítulos ─────────────────────────────────────────────

/** Un título: con nivel de Word, o una línea corta sin punto final que nombra un capítulo. */
function rutaDelTitulo(parrafo) {
  const texto = parrafo.texto.trim();
  const pareceTitulo = parrafo.nivel || (parrafo.palabras <= 12 && !/[.:;]$/.test(texto));
  if (!pareceTitulo) return null;
  const encontrada = RUTAS.find(([, patron]) => patron.test(texto));
  return encontrada ? encontrada[0] : null;
}

/**
 * Los párrafos de prosa, cada uno con su ruta, en el orden del documento. Los
 * títulos solo sirven para saber en qué capítulo se está; no se mandan.
 */
function porCapitulos(parrafos) {
  let ruta = 'introduccion-marco';
  let titulo = '';
  const prosa = [];
  for (const parrafo of parrafos) {
    const nueva = rutaDelTitulo(parrafo);
    if (nueva) ruta = nueva;
    // El último título, cualquiera que sea: las piezas de capítulo se eligen
    // por la sección en que está el párrafo («Antecedentes», «Limitaciones»).
    const texto = parrafo.texto.trim();
    if (parrafo.nivel || (parrafo.palabras <= 12 && !/[.:;]$/.test(texto))) titulo = texto;
    if (parrafo.nivel || parrafo.palabras < 15 || cuerpo.ROTULO.test(parrafo.texto.trim())) continue;
    prosa.push({ ...parrafo, ruta, titulo });
  }
  return prosa;
}

/**
 * Los capítulos del Word, para que el cliente elija cuáles no se tocan
 * (24-oct-2026). Un capítulo es un título del nivel más alto que use el Word;
 * sin estilos de título, una línea corta en mayúsculas o que empieza por
 * «Capítulo». Solo salen los que tienen prosa que humanizar, con sus claves.
 */
function capitulosDe(parrafos) {
  const niveles = parrafos.map((p) => p.nivel).filter(Boolean);
  const minimo = niveles.length > 0 ? Math.min(...niveles) : null;
  const esCapitulo = (parrafo) => {
    const texto = parrafo.texto.trim();
    if (!texto) return false;
    if (minimo !== null) return parrafo.nivel === minimo;
    return (
      parrafo.palabras <= 8 &&
      !/[.:;]$/.test(texto) &&
      (/^cap[ií]tulo\b/i.test(texto) || (/\p{Lu}/u.test(texto) && texto === texto.toUpperCase()))
    );
  };
  const prosa = new Set(porCapitulos(parrafos).map((p) => p.clave));
  const capitulos = [];
  let actual = null;
  for (const parrafo of parrafos) {
    if (esCapitulo(parrafo)) {
      actual = { clave: parrafo.clave, titulo: parrafo.texto.trim().slice(0, 120), claves: [], palabras: 0 };
      capitulos.push(actual);
    } else if (actual && prosa.has(parrafo.clave)) {
      actual.claves.push(parrafo.clave);
      actual.palabras += parrafo.palabras;
    }
  }
  return capitulos.filter((c) => c.claves.length > 0);
}

// ── Los moldes entre párrafos (lo de repeticiones.py de /turnitin) ─────────

const ART = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'en', 'con', 'por', 'para', 'de', 'del', 'al', 'a', 'se', 'lo']);

// «esa/ese/esta/este» desde el 21-oct: GLM partió cinco párrafos seguidos en
// «Dato. Esa brecha / Ese uso / Eso repercute…» y Turnitin los marcó todos.
const ARRANQUES = new Set(['también', 'además', 'así', 'esto', 'eso', 'ello', 'pero', 'sin', 'asimismo', 'esa', 'ese', 'esta', 'este', 'esos', 'esas', 'dicho', 'dicha']);
const DEMOSTRATIVOS = new Set(['esto', 'eso', 'esa', 'ese', 'esta', 'este', 'esos', 'esas', 'dicho', 'dicha']);

/**
 * Relleno que se borra aunque esté en el original (ver «EL RELLENO SE BORRA» en
 * `humanizador/nucleo.md`). Un párrafo que lo conserve va a la pasada aunque
 * sea el único.
 */
const RELLENO = [
  /entorno[s]? (digital(es)? )?que cambia[n]? (constantemente|sin pausa|sin parar)/i,
  /en constante (evolución|cambio)/i,
  /cada vez más (interconectad|digital|globalizad|competitiv)/i,
  /\ben el siglo xxi\b/i,
  /\ben el mundo actual\b/i,
  /de (manera|forma) (objetiva, rigurosa y sistemática|coherente y sistemática)/i,
  /(futuro|panorama) [^.]{0,30}prometedor/i,
  /formación (completa|integral|holística)/i,
];

const BISAGRA = /[^\s\d]: [a-záéíóúñ]/;

const MOLDES = [
  ['«Lo que … es/será»', /\blo que [^.]{0,60}?\b(es|será|son|fue|hará|pide|interesa)\b/gi],
  ['«Se trata de»', /\bse trata de\b/gi],
  ['«De ahí»', /\bde ahí\b/gi],
  ['«Ahora bien»', /\bahora bien\b/gi],
  ['«Por ese motivo / esa razón»', /\bpor (ese|esa|este|esta) (motivo|razón|diferencia|causa)\b/gi],
  ['«de modo que / de manera que»', /\bde (modo|manera) que\b/gi],
  ['«entonces»', /\bentonces\b/gi],
  ['«ayuda a / sirve para / permite»', /\b(ayuda a|ayudará a|servirá para|sirve para|permite|permitirá|permitió)\b/gi],
  ['«No es X, sino Y»', /\bno (es|son|se trata de) [^.]{0,60}?, sino\b/gi],
  ['una lista anunciada con número y dos puntos', /\b(dos|tres|cuatro|cinco|seis) [a-záéíóúñ]+( [a-záéíóúñ]+)?:\s/gi],
  ['«En este/esta + eje, dimensión…»', /(^|\. )(en )?(este|esta|ese|esa) (eje|criterio|pauta|subcategoría|categoría|dimensión|enfoque)\b/gi],
  ['«Con este/esa…» al arrancar', /(^|\. )con (este|esta|ese|esa|estos|esas|ellas|ellos) \w+/gi],
];

const palabras = (texto) => String(texto).toLowerCase().match(/[\wáéíóúñü]+/g) ?? [];

function arranque(texto, n = 2) {
  const p = palabras(texto);
  if (p.length === 0) return '';
  return ART.has(p[0]) ? p.slice(0, n).join(' ') : p[0];
}

function oraciones(texto) {
  return String(texto)
    .replace(/et al\./g, 'et al\u0000')
    .split(/(?<=[.?!])\s+/)
    .map((o) => o.replace(/\u0000/g, '.'))
    .filter((o) => o.trim());
}

/**
 * Qué párrafo repite qué: `Map<clave, notas[]>`. De cada molde se dejan las dos
 * primeras apariciones (el Word que dio 0 % todavía tenía tres «La
 * investigación…»); lo que no puede quedar es el mismo arranque en cinco
 * párrafos.
 */
function moldesDe(textos, minimo = 3) {
  const notas = new Map();
  const anotar = (clave, nota) => notas.set(clave, [...(notas.get(clave) ?? []), nota]);
  const largos = textos.filter(({ texto }) => cuerpo.palabrasDe(texto) >= 25);

  const aperturas = new Map();
  for (const { clave, texto } of largos) {
    const k = arranque(texto);
    if (k) aperturas.set(k, [...(aperturas.get(k) ?? []), clave]);
  }
  for (const [k, claves] of aperturas) {
    if (claves.length < minimo) continue;
    for (const clave of claves.slice(2)) {
      anotar(clave, `abre con «${k}…», igual que otros ${claves.length - 1} párrafos del documento`);
    }
  }

  const arranques = new Map();
  for (const { clave, texto } of largos) {
    for (const oracion of oraciones(texto).slice(1)) {
      const primera = arranque(oracion, 1);
      // Los demostrativos cuentan juntos: «Esa brecha… Ese uso… Eso repercute…»
      // es un solo molde aunque cambie la palabra.
      const k = DEMOSTRATIVOS.has(primera) ? 'esa/ese/eso' : primera;
      if (ARRANQUES.has(primera)) arranques.set(k, [...(arranques.get(k) ?? []), clave]);
    }
  }
  for (const [k, claves] of arranques) {
    if (claves.length < minimo + 1) continue;
    for (const clave of [...new Set(claves)].slice(2)) {
      anotar(clave, `tiene oraciones que arrancan con «${k}…», como otras ${claves.length - 1} del documento`);
    }
  }

  for (const { clave, texto } of textos) {
    const relleno = RELLENO.map((patron) => texto.match(patron)?.[0]).filter(Boolean);
    if (relleno.length > 0) anotar(clave, `conserva relleno que se borra sin sustituto: «${relleno.join('», «')}»`);
    // Las del original también (22-oct: 68 rayas y 68 dos puntos en un
    // documento que siguió en 96 %). Los dos puntos de un rótulo inicial
    // («Interpretación del resultado:») no cuentan.
    if (texto.includes('—')) anotar(clave, 'lleva rayas (—): cámbialas por coma, punto o paréntesis');
    if (BISAGRA.test(texto.slice(40))) anotar(clave, 'usa dos puntos en medio de una oración: parte en dos o une con un verbo');
  }

  for (const [nombre, patron] of MOLDES) {
    const donde = largos.flatMap(({ clave, texto }) => (texto.match(patron) ?? []).map(() => clave));
    if (donde.length < minimo) continue;
    for (const clave of [...new Set(donde)].slice(2)) {
      anotar(clave, `usa ${nombre}, que aparece ${donde.length} veces en el documento`);
    }
  }

  return notas;
}

// ── Párrafos que se parecen entre sí ───────────────────────────────────────

/**
 * Lo que separa un documento en 0 % de uno en 96 %, medido el 22-oct-2026 en
 * tramos de cinco palabras: en los que dieron 0 % (la tesis 07 a mano, el Word
 * de prueba con DeepSeek) cada párrafo comparte con los demás el 4–8 % de sus
 * tramos; en uno de 5 000 palabras con la misma plantilla en cada sección,
 * reescrito párrafo a párrafo, el 41 % (96 % de IA) y el 29 % (79 %). Copiar
 * tramos del original no separa: los 0 % copian el 23–25 %.
 */
const PARECIDO_MAXIMO = 0.15;
/** Desde aquí, en el original, el párrafo «comparte plantilla» con otro. */
const PLANTILLA_COMPARTIDA = 0.3;
const TRAMO = 5;
const RONDAS_CONTRA_PLANTILLA = 3;

/**
 * Una forma de entrar distinta para cada hermano de una plantilla. Es la regla
 * de la Ruta 0 % de /turnitin: «el encargo dice qué arquitectura le toca a cada
 * hermano, para que dos agentes no elijan la misma». Sin ella, el 22-oct, 22 de
 * 38 párrafos rehechos a la vez volvieron a parecerse entre sí.
 */
const ARQUITECTURAS = [
  'abre con el caso concreto o el ejemplo, y la idea general va después',
  'abre con quién actúa (docentes, estudiantes, la universidad) y lo que hace',
  'abre con una condición («Cuando…», «Si…») y termina en lo que se sigue de ella',
  'abre con la consecuencia o el riesgo, y después dice de dónde viene',
  'abre con lo que este párrafo tiene de propio frente a los demás, en una oración corta',
  'abre con el contraste («Aunque…», «Mientras…») y resuelve en la segunda oración',
];
const arquitecturaDe = (i) => ARQUITECTURAS[i % ARQUITECTURAS.length];

const tokens = (texto) => String(texto).match(/\p{L}+/gu) ?? [];

function tramosDe(lista) {
  const minusculas = lista.map((palabra) => palabra.toLowerCase());
  const tramos = [];
  for (let i = 0; i + TRAMO <= minusculas.length; i += 1) tramos.push(minusculas.slice(i, i + TRAMO).join(' '));
  return tramos;
}

/**
 * Cuánto de cada párrafo está ya en párrafos ANTERIORES del documento:
 * `Map<clave, { parecido, repetidas, parecidoA }>`, solo los que pasan de
 * `umbral`. El primero de cada grupo no sale nunca: es el que se queda.
 */
function parecidos(textos, umbral = PARECIDO_MAXIMO) {
  const vistos = new Map();
  const resultado = new Map();
  for (const { clave, texto } of textos) {
    const lista = tokens(texto);
    const tramos = tramosDe(lista);
    const de = tramos.map((tramo) => vistos.get(tramo));
    const compartidos = de.filter(Boolean).length;
    if (tramos.length > 0 && compartidos / tramos.length > umbral && cuerpo.palabrasDe(texto) >= 25) {
      const marcadas = new Array(lista.length).fill(false);
      de.forEach((otro, i) => {
        if (otro) for (let k = i; k < i + TRAMO; k += 1) marcadas[k] = true;
      });
      const repetidas = [];
      let tramo = [];
      lista.forEach((palabra, i) => {
        if (marcadas[i]) tramo.push(palabra);
        else if (tramo.length > 0) {
          repetidas.push(tramo.join(' '));
          tramo = [];
        }
      });
      if (tramo.length > 0) repetidas.push(tramo.join(' '));

      const cuenta = new Map();
      for (const otro of de) if (otro) cuenta.set(otro, (cuenta.get(otro) ?? 0) + 1);
      const [parecidoA] = [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0];
      resultado.set(clave, { parecido: compartidos / tramos.length, repetidas: repetidas.slice(0, 10), parecidoA });
    }
    for (const tramo of tramos) if (!vistos.has(tramo)) vistos.set(tramo, clave);
  }
  return resultado;
}

/**
 * Los párrafos que en el original siguen la plantilla de otro, los dos lados:
 * `Map<clave, arquitectura>`. Cada hermano recibe una forma de entrar distinta,
 * en el orden del documento.
 */
function plantillasCompartidas(prosa) {
  const iguales = parecidos(prosa.map(({ clave, texto }) => ({ clave, texto })), PLANTILLA_COMPARTIDA);
  const grupo = new Map();
  for (const { clave } of prosa) {
    const suyo = iguales.get(clave);
    if (suyo) grupo.set(clave, grupo.get(suyo.parecidoA) ?? suyo.parecidoA);
  }
  for (const raiz of new Set(grupo.values())) grupo.set(raiz, raiz);

  const vistos = new Map();
  const arquitecturas = new Map();
  for (const { clave } of prosa) {
    if (!grupo.has(clave)) continue;
    const raiz = grupo.get(clave);
    const n = vistos.get(raiz) ?? 0;
    vistos.set(raiz, n + 1);
    arquitecturas.set(clave, arquitecturaDe(n));
  }
  return arquitecturas;
}

// ── Pasos ──────────────────────────────────────────────────────────────────

/**
 * Lo que se le da a cada llamada. Así se probó lo que dio 0 %: el triple de
 * tokens de salida (los modelos que razonan los gastan antes de contestar; GLM
 * devolvía MAX_TOKENS) y diez minutos.
 */
const holgura = (maxTokens) => ({ maxTokens: Math.max(Number(maxTokens ?? 0) * 3, 8000), timeoutMs: 600_000 });

const sumar = (uso, otro) => {
  uso.llamadas += otro.llamadas;
  uso.entrada += otro.entrada;
  uso.salida += otro.salida;
};

/** Paso 1: capítulo por capítulo, con las comprobaciones del servicio y un tercer intento. */
async function porRutas({ prosa, fijos = [], skill, generar, modelos, actual, malos, uso, porTanda, avance, plantilla, tipos, piezasUsadas, estricto }) {
  const usadas = [];
  // Cómo abren los párrafos que se quedan como están (lo limpio del reporte),
  // por capítulo: lo rehecho tampoco puede abrir igual que ellos.
  const fijasDe = (ruta) =>
    [...new Set(fijos.filter((p) => p.ruta === ruta).map((p) => palabras(p.texto).slice(0, 3).join(' ')))].filter(Boolean);
  // Por qué se rechazó cada párrafo la última vez, para decírselo al modelo en
  // el siguiente intento.
  const fallos = new Map();
  for (const ruta of Object.keys(NOMBRES)) {
    const suyos = prosa.filter((parrafo) => parrafo.ruta === ruta);
    if (suyos.length === 0) continue;

    const pedir = (peticion) => {
      // `motor` manda su prompt; se cambia por la skill. Si no es el de
      // siempre, es el reintento con insistencia.
      const insistir = peticion.sistema !== prompt.HUMANIZAR;
      const entrada = JSON.parse(peticion.mensajes[0].texto);
      const comparten = Object.keys(entrada).filter((clave) => plantilla.has(clave));
      const fallo = Object.fromEntries(
        Object.keys(entrada)
          .map((clave) => [clave, peticion.fallo ?? fallos.get(clave)])
          .filter(([, motivo]) => motivo),
      );
      // Las piezas que tocan a los párrafos de ESTA llamada.
      const deLaTanda = suyos.filter((parrafo) => parrafo.clave in entrada);
      const extras = piezas.elegir(skill.piezas, deLaTanda, tipos);
      for (const nombre of extras.nombres) piezasUsadas.set(nombre, (piezasUsadas.get(nombre) ?? 0) + 1);
      const texto = JSON.stringify({
        seccion: NOMBRES[ruta],
        ya_usadas: [...new Set([...fijasDe(ruta), ...usadas.slice(-30)])],
        parrafos: entrada,
        ...(comparten.length > 0
          ? { comparten_plantilla: Object.fromEntries(comparten.map((clave) => [clave, plantilla.get(clave)])) }
          : {}),
        ...(Object.keys(fallo).length > 0 ? { fallo_anterior: fallo } : {}),
      });
      const { fallo: _fallo, ...resto } = peticion;
      return generar({
        ...resto,
        sistema: sistemaDe(skill, ruta, insistir, extras.texto, estricto),
        mensajes: [{ rol: 'usuario', texto }],
        ...(modelos ? { modelos } : {}),
        ...holgura(peticion.maxTokens),
      });
    };

    const base = avance.hechas;
    const intentar = (parrafos, alAvanzar, promoverLeves = true) =>
      motor.prepararParrafos({ parrafos, servicio: 'HUMANIZAR', generar: pedir, porTanda, alAvanzar, estricto, promoverLeves });

    let hecho;
    try {
      // Con reporte, lo que falla dos veces por algo leve no se entrega todavía:
      // va al tercer intento con su motivo, y solo si tampoco sale se queda la
      // mejor versión (`candidato`).
      hecho = await intentar(suyos, (hechas) => avance.marcar(base + hechas), !estricto);
    } catch (error) {
      // `prepararParrafos` falla si no salió NINGUNO. Un capítulo entero sin
      // humanizar no tumba el documento: quedan como estaban, con su motivo.
      // Si no sale nada en todo el documento, falla `humanizar`.
      hecho = { cambios: {}, malos: suyos.map((parrafo) => ({ id: parrafo.clave, motivo: error.message })), uso: { llamadas: 0, entrada: 0, salida: 0 } };
    }
    avance.marcar(base + motor.tandasDe(suyos, porTanda).length);

    // El tercer intento. Con la meta de 0 %, un párrafo que se queda en su
    // original es texto de IA puro (21-oct: un párrafo de resultados con
    // «cabe destacar» y «crucial» quedó intacto con GLM-5).
    if (hecho.malos.length > 0) {
      const otraVez = suyos.filter((parrafo) => hecho.malos.some((malo) => String(malo.id) === parrafo.clave));
      for (const malo of hecho.malos) fallos.set(String(malo.id), malo.motivo);
      const candidatos = new Map(hecho.malos.filter((m) => m.candidato).map((m) => [String(m.id), m.candidato]));
      try {
        const segundo = await intentar(otraVez);
        Object.assign(hecho.cambios, segundo.cambios);
        hecho.malos = segundo.malos;
        sumar(uso, segundo.uso);
      } catch {
        // Se quedan los motivos del primer intento.
      }
      // Lo que ni el tercer intento sacó: la mejor versión del primero, que es
      // mejor que dejar el original marcado.
      for (let i = hecho.malos.length - 1; i >= 0; i -= 1) {
        const clave = String(hecho.malos[i].id);
        if (!candidatos.has(clave)) continue;
        hecho.cambios[clave] = { texto: tipografia.arreglar(candidatos.get(clave)) };
        hecho.malos.splice(i, 1);
      }
    }

    for (const [clave, cambio] of Object.entries(hecho.cambios)) actual.set(clave, cambio.texto);
    malos.push(...hecho.malos);
    sumar(uso, hecho.uso);

    for (const parrafo of suyos) {
      const k = palabras(actual.get(parrafo.clave) ?? parrafo.texto).slice(0, 3).join(' ');
      if (k) usadas.push(k);
    }
  }
}

/**
 * Una ronda de correcciones sobre párrafos ya humanizados: se manda cada tanda
 * y se acepta lo que pase las comprobaciones contra el ORIGINAL del autor (así
 * valen todas: cifras, citas, vocabulario; y no la de «casi igual»). Lo que no
 * pasa, o una tanda que falla, deja lo que había. Devuelve cuántos cambió.
 */
async function corregir({ pedidos, entradaDe, sistema, prosa, generar, modelos, actual, uso, porTanda, diario, estricto = false }) {
  const porClave = new Map(prosa.map((parrafo) => [parrafo.clave, parrafo]));
  const ronda = { pedidos: pedidos.length, tocados: 0, rechazos: {}, fallidas: 0 };
  const rechazar = (motivo) => {
    const tipo = String(motivo).replace(/«[^»]*»/g, '«…»').replace(/\(.*\)/, '').trim();
    ronda.rechazos[tipo] = (ronda.rechazos[tipo] ?? 0) + 1;
  };
  let tocados = 0;
  await motor.enParalelo(
    motor.tandasDe(pedidos, porTanda).map((tanda) => async () => {
      let respuesta;
      try {
        respuesta = await generar({
          sistema,
          mensajes: [{ rol: 'usuario', texto: JSON.stringify(entradaDe(tanda)) }],
          modelos: modelos ?? motor.modelos('HUMANIZAR'),
          clave: env.PREPARAR_GEMINI_API_KEY || env.GEMINI_API_KEY,
          thinking: env.PREPARAR_THINKING,
          json: true,
          ...holgura(motor.tokensPara(tanda.reduce((total, p) => total + p.palabras, 0))),
        });
      } catch {
        ronda.fallidas += 1;
        return;
      }
      uso.llamadas += 1;
      uso.entrada += Number(respuesta?.uso?.promptTokenCount ?? 0);
      uso.salida += Number(respuesta?.uso?.candidatesTokenCount ?? 0);

      let devuelto;
      try {
        devuelto = JSON.parse(respuesta.texto);
      } catch {
        ronda.fallidas += 1;
        return;
      }
      for (const p of tanda) {
        const nuevo = motor.repararCifras(porClave.get(p.clave)?.texto, devuelto?.[p.clave]);
        const original = porClave.get(p.clave);
        const motivo = motor.comprobar(original.texto, nuevo, { servicio: 'HUMANIZAR', ...(estricto ? { estricto } : {}) }, original.citas);
        if (motivo) {
          rechazar(motivo);
          continue;
        }
        actual.set(p.clave, tipografia.arreglar(String(nuevo).trim()));
        tocados += 1;
      }
    }),
    env.PREPARAR_TANDAS_A_LA_VEZ,
  );
  ronda.tocados = tocados;
  diario?.push(ronda);
  return tocados;
}

const textosDe = (prosa, actual) =>
  prosa.map((parrafo) => ({ clave: parrafo.clave, texto: actual.get(parrafo.clave) ?? parrafo.texto }));

/**
 * El documento entero para medir repeticiones: primero lo que se queda como
 * está (lo limpio del reporte, los capítulos que no se tocan) y después lo que
 * se reescribe. En ese orden, cuando un párrafo rehecho se parece a uno que no
 * se toca, el que sale señalado es el rehecho, que es el único que se puede
 * cambiar (27-oct-2026).
 */
const conFijos = (fijos, prosa, actual) => [...textosDe(fijos, new Map()), ...textosDe(prosa, actual)];

/**
 * Paso 2: los párrafos que se parecen demasiado a uno anterior se reescriben
 * enteros, viendo las frases repetidas y el párrafo al que se parecen.
 */
async function romperPlantillas({ prosa, fijos = [], skill, generar, modelos, actual, uso, porTanda, diario, ronda = 1, estricto = false }) {
  const textos = conFijos(fijos, prosa, actual);
  const repetidos = parecidos(textos);
  if (repetidos.size === 0) return 0;

  const porClave = new Map(textos.map(({ clave, texto }) => [clave, texto]));
  const pedidos = prosa
    .filter((parrafo) => repetidos.has(parrafo.clave))
    .map((parrafo) => ({ ...parrafo, texto: porClave.get(parrafo.clave) }));
  if (pedidos.length === 0) return 0;
  return corregir({
    pedidos,
    entradaDe: (tanda) => ({
      parrafos: Object.fromEntries(
        tanda.map((p) => {
          const { repetidas, parecidoA } = repetidos.get(p.clave);
          const arquitectura = arquitecturaDe(pedidos.indexOf(p) + ronda * 3);
          return [p.clave, { texto: p.texto, repetidas, parecido_a: porClave.get(parecidoA), arquitectura }];
        }),
      ),
    }),
    sistema: `${skill.nucleo}\n\n${skill.romper}\n\n${FORMATO_ROMPER}`,
    prosa,
    generar,
    modelos,
    actual,
    uso,
    // Cada párrafo viaja con el que se le parece: la tanda, a la mitad.
    porTanda: Math.ceil(porTanda / 2),
    estricto,
    diario: diario && { push: (r) => diario.push({ paso: 'plantilla', ...r }) },
  });
}

/** Paso 3: una pasada sobre el documento entero. Devuelve cuántos párrafos cambió. */
async function pasada({ prosa, fijos = [], skill, generar, modelos, actual, uso, porTanda, diario, estricto = false }) {
  const textos = conFijos(fijos, prosa, actual);
  const notas = moldesDe(textos);
  if (![...notas.keys()].some((clave) => prosa.some((p) => p.clave === clave))) return 0;

  const usadas = [...new Set(textosDe(prosa, actual).map(({ texto }) => palabras(texto).slice(0, 3).join(' ')))];
  const porClave = new Map(textos.map(({ clave, texto }) => [clave, texto]));
  const pedidos = prosa
    .filter((parrafo) => notas.has(parrafo.clave))
    .map((parrafo) => ({ ...parrafo, texto: porClave.get(parrafo.clave) }));
  return corregir({
    pedidos,
    entradaDe: (tanda) => ({
      ya_usadas: usadas,
      parrafos: Object.fromEntries(tanda.map((p) => [p.clave, { texto: p.texto, nota: notas.get(p.clave).join('; ') }])),
    }),
    sistema: [skill.pasada, piezas.paraLaPasada(skill.piezas), FORMATO_PASADA].filter(Boolean).join('\n\n'),
    prosa,
    generar,
    modelos,
    actual,
    uso,
    porTanda,
    estricto,
    diario: diario && { push: (r) => diario.push({ paso: 'pasada', ...r }) },
  });
}

/**
 * Humaniza el cuerpo de un Word. Recibe TODOS los párrafos del cuerpo, títulos
 * incluidos (dicen en qué capítulo se está), y devuelve lo mismo que
 * `motor.prepararParrafos`: `{ cambios, malos, tandas, uso }`.
 *
 * `generar`, `modelos`, `skill` y `porTanda` existen para las pruebas y para
 * `scripts/humanizar-con-skill.js`; el servicio usa los de siempre.
 */
async function humanizar({
  parrafos,
  generar = gemini.generarConRespaldo,
  modelos = null,
  skill = leerSkill(),
  porTanda = env.PREPARAR_PALABRAS_POR_TANDA,
  conPasada = true,
  alAvanzar = () => {},
  // Solo estas claves se reescriben (los demás párrafos se quedan como están). Es la
  // Ruta 0 % de /turnitin: con el reporte de IA delante, lo limpio no se toca.
  soloClaves = null,
  // Los párrafos de los capítulos que el cliente pidió no tocar (24-oct-2026).
  excluir = null,
}) {
  const todo = porCapitulos(parrafos);
  const prosa = todo.filter((p) => (!soloClaves || soloClaves.has(p.clave)) && !excluir?.has(p.clave));
  // Lo que no se reescribe sigue en el Word, y Turnitin lee lo rehecho junto a
  // ello: las plantillas y los moldes se miden contra el documento entero,
  // aunque solo se cambie lo marcado (27-oct-2026).
  const fijos = todo.filter((p) => !prosa.includes(p));
  const estricto = Boolean(soloClaves);
  const actual = new Map();
  const malos = [];
  const uso = { llamadas: 0, entrada: 0, salida: 0 };
  const plantilla = plantillasCompartidas(todo);
  const tipos = piezas.tipoDeTrabajo(parrafos);
  const piezasUsadas = new Map();
  // Qué hizo cada ronda: cuántos pidió, cuántos cambió y por qué rechazó el
  // resto. Para el script de prueba y el log.
  const rondas = [];

  // El avance que ve el cliente: las tandas de cada capítulo, las dos rondas
  // contra la plantilla y las dos pasadas.
  const tandas = Object.keys(NOMBRES).reduce(
    (total, ruta) => total + motor.tandasDe(prosa.filter((p) => p.ruta === ruta), porTanda).length,
    0,
  );
  const total = tandas + (conPasada ? RONDAS_CONTRA_PLANTILLA + 2 : 0);
  const avance = {
    hechas: 0,
    marcar(hechas) {
      this.hechas = Math.max(this.hechas, hechas);
      try {
        alAvanzar(this.hechas, total);
      } catch {
        // Un fallo al pintar el avance no tumba el trabajo.
      }
    },
  };

  await porRutas({ prosa, fijos, skill, generar, modelos, actual, malos, uso, porTanda, avance, plantilla, tipos, piezasUsadas, estricto });

  if (actual.size === 0 && prosa.length > 0) {
    throw new Error(malos[0]?.motivo ?? 'El modelo no devolvió ningún párrafo utilizable.');
  }

  const trasElPaso1 = new Map(actual);
  if (conPasada) {
    // Tres rondas: lo que se reescribe a la vez en tandas distintas puede
    // volver a parecerse entre sí, y cada ronda lo mide otra vez (22-oct: 34
    // → 19 → … párrafos por encima del límite). Una ronda sin nada que hacer
    // no llama al modelo.
    for (let ronda = 1; ronda <= RONDAS_CONTRA_PLANTILLA; ronda += 1) {
      await romperPlantillas({ prosa, fijos, skill, generar, modelos, actual, uso, porTanda, diario: rondas, ronda, estricto });
      avance.marcar(tandas + ronda);
    }
    await pasada({ prosa, fijos, skill, generar, modelos, actual, uso, porTanda, diario: rondas, estricto });
    avance.marcar(tandas + RONDAS_CONTRA_PLANTILLA + 1);
    await pasada({ prosa, fijos, skill, generar, modelos, actual, uso, porTanda, diario: rondas, estricto });
    avance.marcar(tandas + RONDAS_CONTRA_PLANTILLA + 2);
  }

  const cambios = {};
  for (const parrafo of prosa) {
    const texto = actual.get(parrafo.clave);
    if (texto && texto !== parrafo.texto) cambios[parrafo.clave] = { original: parrafo.texto, texto };
  }

  // Un párrafo que una ronda posterior reescribió ya no está «sin humanizar».
  const quedan = malos.filter((malo) => actual.get(String(malo.id)) === trasElPaso1.get(String(malo.id)));
  return { cambios, malos: quedan, tandas, uso, rondas, tipos: [...tipos], piezas: Object.fromEntries(piezasUsadas) };
}

module.exports = {
  humanizar,
  porCapitulos,
  capitulosDe,
  rutaDelTitulo,
  moldesDe,
  parecidos,
  plantillasCompartidas,
  leerSkill,
  sistemaDe,
  oraciones,
  NOMBRES,
};
