'use strict';

/**
 * Lo que el servidor revisa de cada párrafo humanizado, para que el Claude del
 * tesista no tenga que hacerlo en el chat.
 *
 * La skill del humanizador pedía a Claude una ficha por párrafo y correr tres
 * scripts de Python: en un capítulo de cien párrafos eso era la mitad de los
 * tokens de la sesión. Lo que se puede contar se cuenta aquí, y a Claude le
 * llega en una línea por párrafo.
 *
 * NADA DE ESTO RECHAZA: son avisos. Partir un párrafo en dos deja todas sus
 * oraciones iguales y es correcto, y una palabra de la lista puede ser la que
 * el autor usa de verdad. Lo que cambia datos lo rechaza `comprobarReescritura`.
 *
 * De dónde salen las listas: de un capítulo de Derecho que Turnitin marcó al
 * 86 %, humanizado a mano el 28-sep-2026. Lo marcado tenía ese vocabulario, y
 * al reescribirlo por tandas aparecieron los conectores de la segunda lista
 * repetidos de una tanda a otra.
 */

/** Vocabulario de modelo que en una tesis en español delata más que ayuda. */
const VOCABULARIO = [
  'dogmátic*', 'estriba', 'imperios*', 'cimientos', 'catalizador', 'medular', 'compele',
  'hermenéutic*', 'erigir', 'se erige', 'correlato', 'sumamente', 'resulta indispensable',
  'el verdadero desafío', 'el verdadero reto', 'en estrecha', 'encara la exigencia', 'emerge',
  'se impone el desafío', 'juega un papel', 'pilar fundamental', 'cabe destacar', 'es importante mencionar',
  'en este sentido', 'en tal sentido', 'no obstante', 'constituye un', 'en aras de', 'crucial', 'robusto',
  'holístic*', 'sinergia', 'un amplio abanico', 'en definitiva', 'en suma',
];

/**
 * Enlaces que, uno a uno, están bien y juntos se vuelven tic. El límite se
 * cuenta sobre todo lo humanizado del documento: una vez por cada 2500
 * palabras, y al menos dos.
 */
const MULETILLAS = [
  'vale decir que', 'por lo que', 'es así que', 'por eso', 'por ello', ', entonces,', 'ante ello',
  'pese a ello', 'de ahí que', 'asimismo', 'del mismo modo', 'de igual forma', 'finalmente',
  'tiene que', 'no es', 'sino', 'el reto', 'el desafío', 'en conjunto', 'de manera similar',
  'por su parte', 'en contraste',
];

const ABREVIATURA = /\b(et al|p|pp|vol|núm|n\.°|N|Dr|Dra|Sr|Sra|Ed|eds|art|arts|inc|[A-Z])\.(?=\s)/g;

/** Las oraciones de un párrafo, sin cortar en «et al.» ni en «N.°». */
function oraciones(texto) {
  return String(texto)
    .replace(ABREVIATURA, (m) => m.replace('.', '\u0000'))
    .split(/(?<=[.!?])\s+/)
    .map((o) => o.replace(/\u0000/g, '.').trim())
    .filter(Boolean);
}

const esqueleto = (texto) => String(texto).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Cuántas oraciones del texto nuevo son las mismas del original, letra por letra. */
function identicas(original, nuevo) {
  const antes = new Set(oraciones(original).map(esqueleto));
  const despues = oraciones(nuevo);
  return { iguales: despues.filter((o) => antes.has(esqueleto(o))).length, total: despues.length };
}

/** Veces que sale la frase como palabra entera; con «*» al final, como comienzo de palabra. */
const cuantas = (texto, patron) => {
  const prefijo = patron.endsWith('*');
  const frase = prefijo ? patron.slice(0, -1) : patron;
  const t = ` ${String(texto).toLowerCase()} `;
  let n = 0;
  let i = t.indexOf(frase);
  while (i >= 0) {
    const antes = t[i - 1];
    const despues = t[i + frase.length];
    const limite = (c) => !c || !/[\p{L}\p{N}]/u.test(c) || frase.startsWith(',') || frase.endsWith(',');
    if (limite(antes) && (prefijo || limite(despues))) n += 1;
    i = t.indexOf(frase, i + frase.length);
  }
  return n;
};

/**
 * Los avisos de un párrafo: oraciones que siguen iguales, vocabulario de la
 * lista que el original no traía, y rayas nuevas.
 */
function avisosDelParrafo(id, original, nuevo) {
  const avisos = [];
  const { iguales, total } = identicas(original, nuevo);
  if (iguales > 0 && total > 0) {
    avisos.push(
      `¶${id}: ${iguales} de ${total} oraciones siguen idénticas al original. Si no es un párrafo que ` +
        'solo partiste, reescríbelo desde la idea, también el cuerpo, y vuelve a mandarlo',
    );
  }
  const nuevas = VOCABULARIO.filter((v) => cuantas(nuevo, v) > cuantas(original, v));
  const lista = (vs) => vs.map((v) => `«${v.replace('*', '…')}»`).join(', ');
  if (nuevas.length > 0) avisos.push(`¶${id}: metiste ${lista(nuevas)}; cámbialo por la palabra corriente`);
  const quedan = VOCABULARIO.filter((v) => cuantas(nuevo, v) > 0 && !nuevas.includes(v));
  if (quedan.length > 0) avisos.push(`¶${id}: sigue ${lista(quedan)}, que delata; quítalo`);
  const rayas = (s) => (String(s).match(/—/g) ?? []).length;
  if (rayas(nuevo) > rayas(original)) avisos.push(`¶${id}: metiste rayas (—); usa coma, punto o paréntesis`);
  return avisos;
}

/**
 * Las muletillas de TODO lo humanizado del documento, no de una tanda: cada
 * tanda por separado se ve bien y el documento entero repite «vale decir que»
 * ocho veces.
 */
function muletillas(textos) {
  const todo = textos.join('\n');
  const palabras = todo.split(/\s+/).filter(Boolean).length;
  const tope = Math.max(2, Math.round(palabras / 2500));
  return MULETILLAS.map((frase) => ({ frase: frase.replace(/^,\s*|,$/g, ''), veces: cuantas(todo, frase), tope }))
    .filter((m) => m.veces > (m.frase === 'tiene que' || m.frase === 'no es' || m.frase === 'sino' ? tope * 3 : tope))
    .sort((a, b) => b.veces - a.veces);
}

/** Las dos primeras palabras de un párrafo, sin la clave de cita: «asimismo se», «por su». */
const apertura = (parrafo) =>
  String(parrafo)
    .replace(/\[AR[0-9A-F]{8}(?::[^\]\n]{1,40})?\]/gi, '')
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');

/** Conectores con que el modelo abre párrafo tras párrafo. */
const CONECTOR_DE_ENTRADA =
  /^(asimismo|además|finalmente|por último|del mismo modo|de igual (?:forma|modo|manera)|igualmente|por su parte|en ese sentido|en este sentido|en consecuencia|por consiguiente|por ello|por otro lado|de manera similar|en contraste|en esa línea|en esta línea|siguiendo esta línea|a la par|paralelamente)\b/;

/** «Apellido [AR…:n]», «Apellido (2024)» o «Apellido et al. (2024)» abriendo el párrafo. */
const ABRE_CON_AUTOR = /^[A-ZÁÉÍÓÚÑ][\p{L}-]+(?:\s+(?:y|et al\.|e)\s*[A-ZÁÉÍÓÚÑ]?[\p{L}.-]*)*\s*(?:\[AR[0-9A-F]{8}:n\]|\(\d{4}\))/u;

/**
 * Lo que se ve en un capítulo entero ya guardado, sin original con que
 * comparar: vocabulario de modelo, rayas y el molde de apertura entre párrafos,
 * que es lo que más marcó Turnitin en el capítulo de prueba. Lista de líneas.
 *
 * Recibe los párrafos de prosa (sin títulos ni tablas).
 */
function avisosDeCapitulo(parrafos) {
  const avisos = [];
  const texto = parrafos.join('\n');

  const vocabulario = VOCABULARIO.map((v) => [v, cuantas(texto, v)]).filter(([, n]) => n > 0);
  if (vocabulario.length > 0) {
    avisos.push(
      `Vocabulario de modelo: ${vocabulario.map(([v, n]) => `«${v.replace('*', '…')}» ${n}`).join(', ')}. ` +
        'Cámbialo por la palabra corriente.',
    );
  }

  const rayas = (texto.match(/—/g) ?? []).length;
  if (rayas > 0) avisos.push(`${rayas} rayas (—): cámbialas por coma, punto o paréntesis.`);

  const aperturas = new Map();
  for (const p of parrafos) {
    const a = apertura(p);
    if (a) aperturas.set(a, (aperturas.get(a) ?? 0) + 1);
  }
  for (const [a, n] of aperturas) {
    if (n >= 3 && n >= parrafos.length * 0.2) {
      avisos.push(`${n} párrafos abren igual («${a}…»): que cada uno entre de una forma distinta.`);
    }
  }

  // «Asimismo, el…», «Asimismo, la…»: las dos primeras palabras cambian y el
  // molde es el mismo. Se cuenta el conector de entrada por su cuenta.
  const conectores = new Map();
  for (const p of parrafos) {
    const c = CONECTOR_DE_ENTRADA.exec(p.trim().toLowerCase())?.[1];
    if (c) conectores.set(c, (conectores.get(c) ?? 0) + 1);
  }
  const conConector = [...conectores.values()].reduce((a, b) => a + b, 0);
  if (conConector >= 4 && conConector >= parrafos.length * 0.3) {
    const lista = [...conectores].sort((x, y) => y[1] - x[1]).map(([c, n]) => `«${c}» ${n}`).join(', ');
    avisos.push(
      `${conConector} de ${parrafos.length} párrafos abren con un conector (${lista}): la mayoría no lo ` +
        'necesita; empieza por lo que el párrafo afirma.',
    );
  }

  let seguidos = 0;
  let maximo = 0;
  for (const p of parrafos) {
    seguidos = ABRE_CON_AUTOR.test(p.trim()) ? seguidos + 1 : 0;
    maximo = Math.max(maximo, seguidos);
  }
  if (maximo >= 4) {
    avisos.push(
      `${maximo} párrafos seguidos abren con el autor y su cita, con la misma plantilla: en unos empieza por el ` +
        'hallazgo o por el contexto, y deja la cita dentro de la oración.',
    );
  }
  return avisos;
}

module.exports = { oraciones, identicas, avisosDelParrafo, avisosDeCapitulo, muletillas, VOCABULARIO, MULETILLAS };
