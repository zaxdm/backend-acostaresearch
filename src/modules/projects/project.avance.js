'use strict';

/**
 * El avance que sube el tesista: su Word, repartido entre las fases del método.
 *
 * EL PROBLEMA QUE RESUELVE
 * ------------------------
 * Quien llega con media tesis escrita por fuera veía su panel con todas las
 * fases «Sin empezar», y Claude le preguntaba el tema como si no hubiera nada.
 * Subiendo su Word, cada capítulo que se reconoce pasa a su fase: su texto se
 * guarda como el de ese capítulo —Claude lo lee con `ver_capitulo` y sigue
 * desde ahí— y la fase queda «En curso».
 *
 * CÓMO SE RECONOCE UN CAPÍTULO
 * ----------------------------
 * Por su título. Cuenta como título un párrafo con estilo «Título 1», o uno
 * corto sin estilo que empieza por «Capítulo II» o que es entero un nombre de
 * capítulo en mayúsculas («MARCO TEÓRICO», «III. METODOLOGÍA»). Los subtítulos
 * con estilo «Título 2» o menos no parten nada: quedan dentro del capítulo como
 * «## …». Primero se mira el esquema de su facultad, si lo tiene; después los
 * nombres de siempre; y en la tesis, sin nombre, el número del capítulo.
 *
 * Lo que no se reconoce —portada, dedicatoria, índice, resumen, referencias,
 * anexos— no va a ninguna fase. Las tablas tampoco: en texto plano se
 * desarman, y el capítulo sale mejor sin ellas que con sus celdas en fila.
 *
 * NO PISA LO QUE ESCRIBIÓ CLAUDE
 * ------------------------------
 * Eso lo decide `avance.service`, no este módulo, que solo reparte.
 */

/** Minúsculas, sin tildes y con los espacios juntos: «Marco  Teórico» → «marco teorico». */
function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const palabras = (texto) => (String(texto).trim() === '' ? 0 : String(texto).trim().split(/\s+/).length);

/** «Capítulo II:», «CAPITULO 2 -», «Cap. IV». Devuelve el número, o null. */
const CAPITULO = /^cap(?:itulo|\.)\s*([ivxl]+|\d+)\b[\s.:\-–—]*/;

/** «III. », «2) », «IV - » al principio. No «2.1 », que es un subtítulo. */
const NUMERACION = /^(?:[ivxl]+|\d+)(?![.\d]*\d)[.)\-–—:]?\s+/i;

const ROMANOS = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

/**
 * Los nombres de capítulo que se reconocen, y a qué fase van.
 *
 * `fases` son patrones sobre el CÓDIGO de la fase, en orden de preferencia: la
 * misma regla sirve para la tesis, el artículo y el informe, y se queda la
 * primera fase que exista en su catálogo. `null` = no es de ninguna fase, y lo
 * que venga debajo tampoco, hasta el título siguiente.
 *
 * El orden importa: «Resultados y discusión» es de resultados, y «Referencias»
 * se mira antes que nada para que ningún capítulo se lleve la bibliografía.
 */
const REGLAS = [
  { titulo: /^(referencias|bibliografia|fuentes consultadas|anexos?|apendices?)\b/, fases: null },
  { titulo: /^(resumen|abstract|dedicatoria|agradecimiento|indice|presentacion|portada)/, fases: null },
  /*
   * Los aspectos administrativos del proyecto. Van antes que todo lo demás
   * porque en el proyecto suelen ser el «CAPÍTULO IV», y sin regla caían en
   * Resultados por el número. Si el catálogo no tiene la fase, la regla de
   * debajo los deja fuera: un presupuesto no es el capítulo de nadie.
   */
  {
    titulo: /^(aspectos administrativos|administracion del (proyecto|estudio)|recursos y presupuesto|presupuesto y cronograma)\b/,
    fases: [/^aspectos-administrativos$/],
  },
  { titulo: /^(aspectos administrativos|administracion del (proyecto|estudio))\b/, fases: null },
  {
    titulo: /resultado/,
    fases: [/^analisis-datos-rstudio$/, /^analisis-cualitativo$/, /^articulo-fase5-resultados$/, /^informe-fase3/],
  },
  { titulo: /discusion/, fases: [/(^|-)discusion$/] },
  { titulo: /conclusion|recomendacion/, fases: [/conclusiones-abstract$/, /^informe-fase4/] },
  { titulo: /metodolog|metodo|materiales y/, fases: [/^metodologia$/, /^articulo-fase4-metodos$/] },
  {
    titulo: /marco teorico|marco conceptual|marco referencial|antecedentes|bases teoricas|revision de (la )?literatura|estado del arte|fundamentacion/,
    fases: [/^marco-teorico$/, /^articulo-fase3-revision-literatura$/, /^informe-fase2-desarrollo$/],
  },
  {
    titulo: /introduccion|planteamiento|el problema|problema de investigacion|realidad problematica|objetivos/,
    fases: [/^problema-y-objetivos$/, /^articulo-fase2-introduccion$/, /^informe-fase2-desarrollo$/],
  },
  { titulo: /desarrollo/, fases: [/^informe-fase2-desarrollo$/] },
];

/** En la tesis, el capítulo sin nombre se reconoce por su número: así los ordena el método. */
const POR_NUMERO_EN_TESIS = {
  1: /^problema-y-objetivos$/,
  2: /^marco-teorico$/,
  3: /^metodologia$/,
  4: /^analisis-datos-rstudio$/,
  5: /(^|-)discusion$/,
  6: /conclusiones-abstract$/,
};

/** La primera fase del catálogo que casa con alguno de los patrones, en su orden. */
function primeraFase(patrones, codigos) {
  for (const patron of patrones) {
    const code = codigos.find((c) => patron.test(c));
    if (code) return code;
  }
  return null;
}

/**
 * A qué fase va un título. Devuelve el código, `null` si es de algo que no es
 * fase (referencias, resumen…) o `undefined` si no se reconoce.
 */
function faseDelTitulo(titulo, { codigos, esquema, tipo }) {
  const limpio = normalizar(titulo);
  const numero = CAPITULO.exec(limpio)?.[1];
  const nombre = limpio.replace(CAPITULO, '').replace(NUMERACION, '').replace(/[.:]+$/, '').trim();

  // El esquema de su facultad manda: son sus capítulos con sus nombres.
  if (nombre && Array.isArray(esquema)) {
    for (const capitulo of esquema) {
      const suyo = normalizar(capitulo.titulo).replace(CAPITULO, '').replace(NUMERACION, '').trim();
      const fase = (capitulo.de ?? []).find((c) => codigos.includes(c));
      if (suyo && fase && nombre.length >= 4 && (suyo === nombre || nombre.startsWith(suyo) || suyo.startsWith(nombre))) return fase;
    }
  }

  if (nombre) {
    for (const regla of REGLAS) {
      if (!regla.titulo.test(nombre)) continue;
      if (regla.fases === null) return null;
      const fase = primeraFase(regla.fases, codigos);
      if (fase) return fase;
    }
  }

  if (numero && tipo === 'tesis') {
    const n = ROMANOS[numero] ?? Number(numero);
    const patron = POR_NUMERO_EN_TESIS[n];
    if (patron) return primeraFase([patron], codigos) ?? undefined;
  }

  return undefined;
}

/**
 * ¿Es este párrafo el título de un capítulo?
 *
 * Con estilo «Título 1», siempre que sea corto. Sin estilo, solo si empieza por
 * «Capítulo» o si es un nombre de capítulo corto y en mayúsculas: un párrafo
 * normal que empieza por «Objetivos» no puede partir el capítulo en dos.
 */
function esTituloDeCapitulo(parrafo) {
  if (parrafo.enTabla) return false;
  const texto = parrafo.texto.trim();
  if (palabras(texto) > 14) return false;
  if (parrafo.nivel === 1) return true;
  if (parrafo.nivel) return false;

  const limpio = normalizar(texto);
  if (CAPITULO.test(limpio)) return true;
  const sinNumero = texto.replace(NUMERACION, '').trim();
  const enMayusculas = sinNumero === sinNumero.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(sinNumero);
  return enMayusculas && palabras(sinNumero) <= 6 && !/[.;]$/.test(sinNumero);
}

/** Un párrafo dentro del capítulo, en el Markdown de los capítulos guardados. */
function comoMarkdown(parrafo) {
  const texto = parrafo.texto.trim();
  if (parrafo.nivel && parrafo.nivel >= 2) return `${'#'.repeat(Math.min(parrafo.nivel, 4))} ${texto}`;
  return texto;
}

/**
 * Reparte los párrafos del Word (los de `project.documento.leer`) entre las fases.
 *
 * Devuelve `{ porFase: Map<código, texto>, sinUbicar }`: el texto de cada fase
 * reconocida, en el orden del Word —dos capítulos que caen en la misma fase se
 * juntan—, y cuántas palabras quedaron fuera por no estar bajo ningún título
 * reconocido.
 */
function repartir(parrafos, { catalogo = [], esquema = null, tipo = 'tesis' } = {}) {
  const codigos = catalogo.map((s) => s.code);
  const contexto = { codigos, esquema, tipo };
  const porFase = new Map();
  let actual = null;
  let sinUbicar = 0;

  for (let i = 0; i < parrafos.length; i += 1) {
    const parrafo = parrafos[i];

    if (esTituloDeCapitulo(parrafo)) {
      let fase = faseDelTitulo(parrafo.texto, contexto);
      // «CAPÍTULO II» en una línea y «MARCO TEÓRICO» en la siguiente.
      const siguiente = parrafos[i + 1];
      if (fase === undefined && siguiente && !siguiente.enTabla && palabras(siguiente.texto) <= 8) {
        const junto = faseDelTitulo(`${parrafo.texto} ${siguiente.texto}`, contexto);
        if (junto !== undefined) {
          fase = junto;
          i += 1;
        }
      }
      // Un «Título 1» que no es de nada (Dedicatoria, Índice) corta el capítulo
      // anterior; uno sin estilo que no se reconoce es solo texto en mayúsculas.
      if (fase !== undefined || parrafo.nivel === 1) {
        actual = fase ?? null;
        continue;
      }
    }

    if (parrafo.referencias) {
      actual = null;
      continue;
    }
    if (parrafo.enTabla) continue;

    if (!actual) {
      sinUbicar += palabras(parrafo.texto);
      continue;
    }
    const previo = porFase.get(actual);
    const linea = comoMarkdown(parrafo);
    porFase.set(actual, previo ? `${previo}\n\n${linea}` : linea);
  }

  return { porFase, sinUbicar };
}

module.exports = { repartir, faseDelTitulo, esTituloDeCapitulo, normalizar };
