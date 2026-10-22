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
- "ya_usadas": cómo abren otros párrafos del documento, ya humanizados. No abras ninguno igual;
- "parrafos": cada clave es el número de un párrafo y cada valor su texto.

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

const INSISTIR = `
ATENCIÓN: este párrafo ya se pidió y volvió con algo que delata a una IA, con una cifra o una
cita cambiada, o casi igual al original. Reescríbelo otra vez desde la idea, con otra entrada, y
revisa antes de devolverlo cada cifra y cada cita, y que no lleve dos puntos en medio, «no
solo… sino», «más allá de», rayas (—) ni palabras de la lista QUITA.
`.trim();

let enMemoria = null;

/** Los textos de la skill. Se leen una vez; `carpeta` sirve para probar otra copia. */
function leerSkill(carpeta = CARPETA) {
  if (carpeta === CARPETA && enMemoria) return enMemoria;
  const leer = (archivo) => fs.readFileSync(path.join(carpeta, archivo), 'utf8').trim();
  const skill = { nucleo: leer('nucleo.md'), pasada: leer('pasada-documento.md'), rutas: {} };
  for (const ruta of Object.keys(NOMBRES)) {
    skill.rutas[ruta] = `${leer(`rutas/${ruta}.md`)}\n\n${leer(`ejemplos/${ruta}.md`)}`;
  }
  if (carpeta === CARPETA) enMemoria = skill;
  return skill;
}

const sistemaDe = (skill, ruta, insistir) =>
  [skill.nucleo, skill.rutas[ruta], FORMATO, insistir ? INSISTIR : null].filter(Boolean).join('\n\n');

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
  const prosa = [];
  for (const parrafo of parrafos) {
    const nueva = rutaDelTitulo(parrafo);
    if (nueva) ruta = nueva;
    if (parrafo.nivel || parrafo.palabras < 15 || cuerpo.ROTULO.test(parrafo.texto.trim())) continue;
    prosa.push({ ...parrafo, ruta });
  }
  return prosa;
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
async function porRutas({ prosa, skill, generar, modelos, actual, malos, uso, porTanda, avance }) {
  const usadas = [];
  for (const ruta of Object.keys(NOMBRES)) {
    const suyos = prosa.filter((parrafo) => parrafo.ruta === ruta);
    if (suyos.length === 0) continue;

    const pedir = (peticion) => {
      // `motor` manda su prompt; se cambia por la skill. Si no es el de
      // siempre, es el reintento con insistencia.
      const insistir = peticion.sistema !== prompt.HUMANIZAR;
      const entrada = JSON.parse(peticion.mensajes[0].texto);
      const texto = JSON.stringify({ seccion: NOMBRES[ruta], ya_usadas: usadas.slice(-30), parrafos: entrada });
      return generar({
        ...peticion,
        sistema: sistemaDe(skill, ruta, insistir),
        mensajes: [{ rol: 'usuario', texto }],
        ...(modelos ? { modelos } : {}),
        ...holgura(peticion.maxTokens),
      });
    };

    const base = avance.hechas;
    const intentar = (parrafos, alAvanzar) =>
      motor.prepararParrafos({ parrafos, servicio: 'HUMANIZAR', generar: pedir, porTanda, alAvanzar });

    let hecho;
    try {
      hecho = await intentar(suyos, (hechas) => avance.marcar(base + hechas));
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
      try {
        const segundo = await intentar(otraVez);
        Object.assign(hecho.cambios, segundo.cambios);
        hecho.malos = segundo.malos;
        sumar(uso, segundo.uso);
      } catch {
        // Se quedan los motivos del primer intento.
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

/** Paso 2: una pasada sobre el documento entero. Devuelve cuántos párrafos cambió. */
async function pasada({ prosa, skill, generar, modelos, actual, uso, porTanda }) {
  const textos = prosa.map((parrafo) => ({ clave: parrafo.clave, texto: actual.get(parrafo.clave) ?? parrafo.texto }));
  const notas = moldesDe(textos);
  if (notas.size === 0) return 0;

  const porClave = new Map(prosa.map((parrafo) => [parrafo.clave, parrafo]));
  const usadas = [...new Set(textos.map(({ texto }) => palabras(texto).slice(0, 3).join(' ')))];
  const pedidos = [...notas.keys()].map((clave) => ({ ...porClave.get(clave), texto: actual.get(clave) ?? porClave.get(clave).texto }));

  let tocados = 0;
  await motor.enParalelo(
    motor.tandasDe(pedidos, porTanda).map((tanda) => async () => {
      const entrada = Object.fromEntries(tanda.map((p) => [p.clave, { texto: p.texto, nota: notas.get(p.clave).join('; ') }]));
      let respuesta;
      try {
        respuesta = await generar({
          sistema: `${skill.pasada}\n\n${FORMATO_PASADA}`,
          mensajes: [{ rol: 'usuario', texto: JSON.stringify({ ya_usadas: usadas, parrafos: entrada }) }],
          modelos: modelos ?? motor.modelos('HUMANIZAR'),
          clave: env.PREPARAR_GEMINI_API_KEY || env.GEMINI_API_KEY,
          thinking: env.PREPARAR_THINKING,
          json: true,
          ...holgura(motor.tokensPara(tanda.reduce((total, p) => total + p.palabras, 0))),
        });
      } catch {
        // La pasada mejora; si falla, se queda lo del paso 1, que ya pasó las comprobaciones.
        return;
      }
      uso.llamadas += 1;
      uso.entrada += Number(respuesta?.uso?.promptTokenCount ?? 0);
      uso.salida += Number(respuesta?.uso?.candidatesTokenCount ?? 0);

      let devuelto;
      try {
        devuelto = JSON.parse(respuesta.texto);
      } catch {
        return;
      }
      for (const p of tanda) {
        const nuevo = devuelto?.[p.clave];
        // Contra el ORIGINAL del autor: así valen todas las comprobaciones
        // (cifras, citas, vocabulario) y no la de «casi igual».
        const original = porClave.get(p.clave);
        if (motor.comprobar(original.texto, nuevo, { servicio: 'HUMANIZAR' }, original.citas)) continue;
        actual.set(p.clave, tipografia.arreglar(String(nuevo).trim()));
        tocados += 1;
      }
    }),
    env.PREPARAR_TANDAS_A_LA_VEZ,
  );
  return tocados;
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
}) {
  const prosa = porCapitulos(parrafos);
  const actual = new Map();
  const malos = [];
  const uso = { llamadas: 0, entrada: 0, salida: 0 };

  // El avance que ve el cliente: las tandas de cada capítulo y las dos pasadas.
  const tandas = Object.keys(NOMBRES).reduce(
    (total, ruta) => total + motor.tandasDe(prosa.filter((p) => p.ruta === ruta), porTanda).length,
    0,
  );
  const total = tandas + (conPasada ? 2 : 0);
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

  await porRutas({ prosa, skill, generar, modelos, actual, malos, uso, porTanda, avance });

  if (actual.size === 0 && prosa.length > 0) {
    throw new Error(malos[0]?.motivo ?? 'El modelo no devolvió ningún párrafo utilizable.');
  }

  const trasElPaso1 = new Map(actual);
  if (conPasada) {
    await pasada({ prosa, skill, generar, modelos, actual, uso, porTanda });
    avance.marcar(tandas + 1);
    await pasada({ prosa, skill, generar, modelos, actual, uso, porTanda });
    avance.marcar(tandas + 2);
  }

  const cambios = {};
  for (const parrafo of prosa) {
    const texto = actual.get(parrafo.clave);
    if (texto && texto !== parrafo.texto) cambios[parrafo.clave] = { original: parrafo.texto, texto };
  }

  // Un párrafo que la pasada reescribió ya no está «sin humanizar».
  const quedan = malos.filter((malo) => actual.get(String(malo.id)) === trasElPaso1.get(String(malo.id)));
  return { cambios, malos: quedan, tandas, uso };
}

module.exports = { humanizar, porCapitulos, rutaDelTitulo, moldesDe, leerSkill, sistemaDe, oraciones, NOMBRES };
