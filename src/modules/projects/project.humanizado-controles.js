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
  'tiene que', 'no es', 'sino', 'el reto', 'el desafío',
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

module.exports = { oraciones, identicas, avisosDelParrafo, muletillas, VOCABULARIO, MULETILLAS };
