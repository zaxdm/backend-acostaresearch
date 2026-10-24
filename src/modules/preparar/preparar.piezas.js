'use strict';

/**
 * Las piezas de la skill del servidor (`./humanizador/piezas/`), 24-oct-2026.
 *
 * POR QUÉ SON PIEZAS Y NO MÁS NÚCLEO
 * ----------------------------------
 * El núcleo se manda en cada llamada. Las reglas de /turnitin, del humanizador
 * académico, de /asesorar y de las skills de capítulo pasan de 140 KB: si se
 * mandaran enteras, cada llamada las pagaría y el modelo atendería a lo que no
 * toca. Cada pieza es un archivo corto con la condición en que vale (un
 * capítulo, un tipo de párrafo, una situación) y el código manda a cada tanda
 * solo las que le tocan.
 *
 * Tres clases:
 *   - siempre:  entran en toda tanda (son cuatro, unos 5 KB).
 *   - capítulo: `titulo~/…/  o  texto~/…/` en la primera línea del archivo.
 *   - situación: la condición está en `CONDICIONES`, aquí abajo.
 *
 * Manda el núcleo. Cuando una skill decía otra cosa (ritmo desigual, oraciones
 * cortas, «Respecto a», no reescribir lo limpio), se siguió lo que dio 0 %:
 * ver `humanizador/piezas/CONTRADICCIONES-*.md` y el LEEME.md.
 */

const fs = require('fs');
const path = require('path');

/** Lo que se manda como máximo de piezas de situación en una tanda (caracteres). */
const PRESUPUESTO = 12000;

const palabrasDe = (texto) => (String(texto).match(/[\p{L}\p{N}]+/gu) ?? []).length;
const oracionesDe = (texto) => String(texto).split(/(?<=[.?!])\s+/).filter((o) => o.trim()).length;

const tiene = (patron) => (parrafo) => patron.test(parrafo.texto);

/**
 * La condición de cada pieza que no es de capítulo, por su ruta dentro de
 * `piezas/`. `rango`: 1 capítulo, 2 situación concreta, 3 condición muy
 * general (va al final y solo si cabe). `siempre`: entra en toda tanda.
 * `pasada`: no se elige por párrafo; se suma a la instrucción de la pasada.
 */
const CONDICIONES = {
  'turnitin/general.md': { siempre: true },
  'humanizador/00-siempre-revisar-lo-que-metiste.md': { siempre: true },
  'turnitin/registro-que-dio-0.md': { siempre: true },
  'turnitin/errores-al-reordenar.md': { siempre: true },
  'turnitin/segunda-pasada.md': { pasada: true },

  'turnitin/antecedentes.md': {
    rango: 2,
    cumple: (p) =>
      /(\([^()]*\b(19|20)\d{2}\s*[a-z]?\)|\bet al\.)/i.test(p.texto) &&
      /\b(investig|estudi|aplic|evalu|analiz|encuest|revis|conclu|hall|observ|mid[ií]|compar|examin|identific|propus|determin)\w*/i.test(p.texto),
  },
  'turnitin/definiciones-y-dimensiones.md': {
    rango: 2,
    cumple: (p) =>
      /\b(se define como|define|entiende como|concepto|dimensi[oó]n|dimensiones|indicadores)\b/i.test(p.texto) ||
      /^\W{0,3}[A-ZÁÉÍÓÚÑ][\p{L} ]{2,40}\.\s+[A-ZÁÉÍÓÚÑ]/u.test(p.texto.trim()),
  },
  'turnitin/metodologia-anclada.md': {
    rango: 2,
    cumple: tiene(/\b(se (aplicar[aá]|aplic[oó]|emplear[aá]|usar[aá])|enfoque|dise[nñ]o|poblaci[oó]n|muestra|muestreo|instrumento|validez|confiabilidad|alfa de Cronbach|Shapiro|Spearman|Pearson|consentimiento)\b/i),
  },
  // 24-oct: la metodología de un proyecto fue lo último marcado en la tesis 16.
  'turnitin/metodologia-en-futuro.md': {
    rango: 2,
    cumple: (p) =>
      String(p.texto).split(/(?<=[.?!])\s+/).filter((o) => /\bse \p{L}+r[áé]n?(?!\p{L})/iu.test(o)).length >= 2,
  },
  'turnitin/notas-celdas-y-cortos.md': {
    rango: 2,
    cumple: (p) => /^\s*(Nota|Fuente|Elaboraci[oó]n)\b/i.test(p.texto) || (p.palabras >= 15 && p.palabras <= 24),
  },
  'turnitin/pares-del-0.md': {
    rango: 3,
    cumple: (p) => p.palabras >= 40 && /(\([^()]*\b(19|20)\d{2}\)|\bet al\.)/i.test(p.texto),
  },
  'turnitin/patrones-molde.md': {
    rango: 2,
    cumple: tiene(/\blo que [^.]{0,60}\b(es|ser[aá]|fue|har[aá]|pide|interesa)\b|\bse trata de\b|\bde ah[ií]\b|\bahora bien\b|\bentonces\b|\bpor (ese|esa|este|esta) (motivo|raz[oó]n|causa)\b|(^|\. )con (este|esta|ese|esa|esto|eso|estos|esas)\b|\b(ayuda a|permitir[aá]|servir[aá] para)\b/i),
  },

  'humanizador/adornos-y-listas-rotuladas.md': {
    rango: 2,
    cumple: tiene(/['‘][^'’]{2,40}['’]|\b(culminando|configurando|consolidando|permitiendo|generando|contribuyendo) as[ií]\b|(^|\. )[A-ZÁÉÍÓÚÑ][\p{L} ]{2,30}: /u),
  },
  'humanizador/anaforas-y-agentes.md': {
    rango: 2,
    cumple: (p) => {
      const o = p.texto.split(/(?<=[.?!])\s+/);
      const demostrativas = o.filter((x) => /^(Ese|Esa|Esos|Esas|Este|Esta|Estos|Estas|Dicho|Dicha)\s+\p{L}+/u.test(x)).length;
      const abstractas = o.filter((x) => /^(La|El)\s+\p{L}+(ci[oó]n|miento|dad)\b/iu.test(x)).length;
      return demostrativas >= 2 || abstractas >= 3;
    },
  },
  'humanizador/aperturas-antepuestas.md': {
    rango: 2,
    cumple: (p) =>
      p.texto.split(/(?<=[.?!])\s+/).filter((x) => /^(De|A|En|Sobre|Dentro de|Frente a|Con|Por|Seg[uú]n|Desde|Tras|Ante|Durante|Mediante|Entre)\s+[^,]{1,60},/u.test(x)).length >= 3,
  },
  'humanizador/cierre-en-serie-y-veredicto.md': {
    rango: 2,
    cumple: (p) => p.texto.split(/(?<=[.?!])\s+/).filter((x) => /,\s+[^,]{2,40},?\s+y\s+[^,]{2,40}[.?!]$/u.test(x)).length >= 2,
  },
  'humanizador/cita-abre-oracion.md': {
    rango: 2,
    cumple: (p) =>
      p.texto.split(/(?<=[.?!])\s+/).filter((x) => /(\([^()]*\b(19|20)\d{2}\)|\bet al\.)/.test(x)).length >= 3 ||
      /(^|\. )(Seg[uú]n|De acuerdo con|Como lo (evidencia|se[nñ]ala|precisa|advierte))\b/i.test(p.texto),
  },
  'humanizador/conservar-terminos-y-datos.md': {
    rango: 2,
    cumple: tiene(/\b(robust|significativ|correlaci|consistencia interna)|\(n\s*=|[αρ]\s*=|\bp\s*[<=]\s*0|\bSe (aplic[oó]|realiz[oó])\b/i),
  },
  'humanizador/cualitativo.md': {
    rango: 2,
    cumple: tiene(/\((E|P)\d{1,2}\b|\bParticipante \d+|\b(las entrevistadas?|los entrevistados|informantes|subcategor[ií]a|manifestaron|refirieron)\b/),
  },
  'humanizador/discusion-comparar.md': {
    rango: 2,
    cumple: (p) =>
      /\b(coincide|concuerda|difiere|contrasta|en la misma l[ií]nea|similar a|a diferencia de|guarda relaci[oó]n con)/i.test(p.texto) &&
      /(\([^()]*\b(19|20)\d{2}\)|\bet al\.|\b(19|20)\d{2}\))/.test(p.texto),
  },
  'humanizador/fidelidad-de-alcance.md': {
    rango: 3,
    cumple: tiene(/\b(todos|todas|[uú]nic[oa]s?|exclusivamente|pre-?post|ensayo|provoca|genera|influye|explica|se relaciona con|se asocia a)\b/i),
  },
  'humanizador/frases-etiqueta-y-relieve.md': {
    rango: 2,
    cumple: (p) =>
      /\b(es|fue) (precisamente|justamente)\b|\bde otro orden\b|\bno se reduce a\b|\btiene una consecuencia\b|\bocurre en dos planos\b/i.test(p.texto) ||
      p.texto.split(/(?<=[.?!])\s+/).some((x) => palabrasDe(x) <= 9 && !/\d/.test(x) && x.length > 12),
  },
  'humanizador/juridico.md': {
    rango: 2,
    cumple: tiene(/\b(art[ií]culo \d+|art\. ?\d+|Ley N|Decreto|D\. ?S\.|Expediente|Casaci[oó]n|Recurso de Nulidad|Tribunal Constitucional|Corte Suprema|jurisprudencia)\b/i),
  },
  'humanizador/marcas-de-pendiente.md': {
    rango: 2,
    cumple: tiene(/\[(PENDIENTE|FALTA FUENTE)[^\]]*\]|\[AR[0-9A-F]{6,}[^\]]*\]|_{3,}|\bcompletar\b/i),
  },
  'humanizador/metodologia-elementos.md': {
    rango: 2,
    cumple: tiene(/\b(poblaci[oó]n|muestra|muestreo|instrumento|cuestionario|alfa de Cronbach|V de Aiken|enfoque|dise[nñ]o|nivel de investigaci[oó]n)\b/i),
  },
  'humanizador/palabra-corriente-y-figuras.md': {
    rango: 2,
    cumple: tiene(/\b(inc[oó]lume|consolid\w+|prioriz\w+|inherente|subyacente|propici\w+|coadyuv\w+|vislumbr\w+|dilucid\w+|menester|ostent\w+|deviene|plasma|se sustenta en)\b|la otra cara|salir a la luz/i),
  },
  'humanizador/parrafo-largo.md': {
    rango: 2,
    cumple: (p) => p.palabras > 180 || oracionesDe(p.texto) > 8,
  },
  'humanizador/procedimiento-en-fila.md': {
    rango: 2,
    cumple: (p) => (p.texto.match(/\b(primero|luego|posteriormente|despu[eé]s|finalmente|a continuaci[oó]n)\b/gi) ?? []).length >= 2,
  },
  'humanizador/recomendaciones.md': {
    rango: 2,
    cumple: tiene(/\b(se recomienda|recomienda a|se sugiere|se propone que|se debe)\b/i),
  },
  'humanizador/resultados-niveles.md': {
    rango: 2,
    cumple: (p) =>
      (p.texto.match(/\d+([.,]\d+)?\s?%/g) ?? []).length >= 3 && /\b(nivel|bajo|medio|alto|categor[ií]a|dimensi[oó]n)\b/i.test(p.texto),
  },
  'humanizador/veredicto-hipotesis.md': {
    rango: 2,
    cumple: tiene(/\b(se acept[oó]|se acepta|se rechaz\w+|hip[oó]tesis (nula|alterna|general|espec[ií]fica)|H[01₀₁])\b/i),
  },
  'humanizador/voz-del-metodo.md': {
    rango: 3,
    cumple: (p) => oracionesDe(p.texto) >= 4,
  },

  'asesorar/antecedentes-no-seguir-el-resumen.md': {
    rango: 2,
    cumple: (p) =>
      /(\([^()]*\b(19|20)\d{2}\)|\bet al\.)/i.test(p.texto) &&
      /\b(tuvo como objetivo|el objetivo fue|se lleg[oó] a la conclusi[oó]n|concluy[oó]|su muestra|aporta al presente estudio|antecedente)\b/i.test(p.texto),
  },
  'asesorar/terminologia-fija.md': {
    rango: 3,
    cumple: tiene(/\b(variable|dimensi[oó]n|indicador|hip[oó]tesis|objetivo|poblaci[oó]n|muestra|muestreo)\b/i),
  },
};

/** Qué tipo de trabajo exige cada familia de piezas de capítulo. */
const TRABAJO_DE = [
  [/^capitulos\/tsp-/, ['tsp']],
  [/^capitulos\/informe-/, ['informe']],
  [/^capitulos\/revision-/, ['revision']],
  [/^capitulos\/articulo-0[1-4]/, ['articulo']],
  [/^capitulos\/articulo-0[5-7]/, ['articulo', 'revision']],
];

/**
 * Qué clase de documento es, mirando el principio (la portada dice «informe»,
 * «suficiencia profesional», «artículo») y, para la revisión, todo el texto.
 * Una tesis no se marca: las piezas de tesis valen para todos.
 */
function tipoDeTrabajo(parrafos) {
  const inicio = parrafos.slice(0, 60).map((p) => p.texto).join('\n');
  const todo = parrafos.map((p) => p.texto).join('\n');
  const tipos = new Set();
  if (/\brevisi[oó]n (sistem[aá]tica|de alcance|bibliom[eé]trica)\b|\bPRISMA\b|\bscoping review\b/i.test(todo)) tipos.add('revision');
  if (/suficiencia profesional/i.test(inicio)) tipos.add('tsp');
  if (/\binforme (final|de (curso|investigaci[oó]n|pr[aá]ctica|consultor[ií]a)|empresarial)\b|\bmonograf[ií]a\b/i.test(inicio)) tipos.add('informe');
  if (/\b(art[ií]culo (cient[ií]fico|de investigaci[oó]n|original|de revisi[oó]n)|manuscrito|IMRyD)\b/i.test(inicio)) tipos.add('articulo');
  return tipos;
}

/** `titulo~/…/i  o  texto~/…/i` de la primera línea de una pieza de capítulo. */
function condicionDeCapitulo(linea) {
  const titulos = [];
  const textos = [];
  const patron = /(titulo|texto)~\/((?:\\.|[^/\\])+)\/([a-z]*)/g;
  let m;
  while ((m = patron.exec(linea)) !== null) {
    try {
      (m[1] === 'titulo' ? titulos : textos).push(new RegExp(m[2], m[3].replace(/[^gimsuy]/g, '')));
    } catch {
      // Una expresión mal escrita deja esa parte sin efecto; la pieza no se cae.
    }
  }
  if (titulos.length === 0 && textos.length === 0) return null;
  return (parrafo) =>
    titulos.some((r) => r.test(parrafo.titulo ?? '')) || textos.some((r) => r.test(parrafo.texto));
}

function leerCarpeta(carpeta) {
  const piezas = [];
  if (!fs.existsSync(carpeta)) return piezas;
  for (const sub of fs.readdirSync(carpeta, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    for (const archivo of fs.readdirSync(path.join(carpeta, sub.name))) {
      if (!archivo.endsWith('.md')) continue;
      const ruta = `${sub.name}/${archivo}`;
      const crudo = fs.readFileSync(path.join(carpeta, sub.name, archivo), 'utf8');
      const lineas = crudo.split(/\r?\n/);
      const cuando = lineas.find((l) => l.startsWith('CUANDO:')) ?? '';
      const texto = lineas.filter((l) => !/^(CUANDO|TRABAJO):/.test(l)).join('\n').trim();
      if (!texto) continue;

      const nombre = archivo.replace(/\.md$/, '');
      const fija = CONDICIONES[ruta];
      if (sub.name === 'capitulos') {
        const cumple = condicionDeCapitulo(cuando);
        if (!cumple) continue;
        const exige = TRABAJO_DE.find(([patron]) => patron.test(ruta))?.[1] ?? null;
        piezas.push({ ruta, nombre, texto, rango: 1, cumple, exige });
      } else if (fija) {
        piezas.push({ ruta, nombre, texto, rango: 2, exige: null, ...fija });
      }
    }
  }
  return piezas.sort((a, b) => a.ruta.localeCompare(b.ruta));
}

let enMemoria = null;

/** Las piezas de una carpeta `piezas/`. Se leen una vez; otra carpeta se lee cada vez. */
function leerPiezas(carpeta, porDefecto = false) {
  if (porDefecto && enMemoria) return enMemoria;
  const piezas = leerCarpeta(carpeta);
  if (porDefecto) enMemoria = piezas;
  return piezas;
}

const aplica = (pieza, tipos) => !pieza.exige || pieza.exige.some((tipo) => tipos.has(tipo));

/**
 * Lo que se suma al sistema de una tanda: las piezas «siempre» y, hasta
 * `presupuesto` caracteres, las de situación que coinciden con algún párrafo,
 * primero las de capítulo, después las concretas y al final las generales; a
 * igual rango, las que coinciden con más párrafos de la tanda.
 *
 * Devuelve `{ texto, nombres }`; `texto` es '' si no hay piezas.
 */
function elegir(piezas, parrafos, tipos = new Set(), presupuesto = PRESUPUESTO) {
  if (!Array.isArray(piezas) || piezas.length === 0) return { texto: '', nombres: [] };

  const elegidas = piezas.filter((pieza) => pieza.siempre);
  const candidatas = [];
  for (const pieza of piezas) {
    if (pieza.siempre || pieza.pasada || !aplica(pieza, tipos)) continue;
    const coinciden = parrafos.filter((parrafo) => pieza.cumple(parrafo)).length;
    if (coinciden > 0) candidatas.push({ pieza, coinciden });
  }
  candidatas.sort((a, b) => a.pieza.rango - b.pieza.rango || b.coinciden - a.coinciden || a.pieza.ruta.localeCompare(b.pieza.ruta));

  let gastado = 0;
  for (const { pieza } of candidatas) {
    if (gastado + pieza.texto.length > presupuesto) continue;
    gastado += pieza.texto.length;
    elegidas.push(pieza);
  }
  if (elegidas.length === 0) return { texto: '', nombres: [] };

  return {
    texto: `REGLAS QUE APLICAN A ESTA TANDA (suman a las anteriores; si chocan, manda el núcleo)\n\n${elegidas.map((p) => p.texto).join('\n\n')}`,
    nombres: elegidas.map((p) => p.nombre),
  };
}

/** Lo que se suma a la instrucción de las pasadas sobre el documento entero. */
const paraLaPasada = (piezas) => (piezas ?? []).filter((p) => p.pasada).map((p) => p.texto).join('\n\n');

module.exports = { leerPiezas, elegir, tipoDeTrabajo, paraLaPasada, condicionDeCapitulo, CONDICIONES, PRESUPUESTO };
