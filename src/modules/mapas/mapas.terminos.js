'use strict';

const nlp = require('compromise');

/**
 * Los términos de títulos y resúmenes: el «Create map based on text data» de
 * VOSviewer.
 *
 * VOSviewer no cuenta palabras sueltas: identifica FRASES NOMINALES —«emotional
 * exhaustion», «structural equation modeling»— con un etiquetador gramatical,
 * y se queda con la más larga de cada tramo. Aquí se hace lo mismo con
 * `compromise` (MIT, sin servicios externos): se etiqueta cada palabra y se
 * juntan las secuencias de adjetivos y sustantivos que acaban en sustantivo.
 *
 * Solo inglés: es la lengua de casi todos los resúmenes indexados, y la única
 * para la que el etiquetador sirve. Lo mismo hace VOSviewer.
 */

/**
 * Los adjetivos que el manual de VOSviewer no deja formar parte de un término,
 * por demasiado generales: «different approaches» no es un tema.
 */
const ADJETIVOS_GENERALES = new Set(
  'all another any both different each either every few fewer fewest least less little many more most much neither other same several some such various'.split(' '),
);

/**
 * Los rótulos de los resúmenes estructurados («Purpose:», «Findings:»…), que
 * el manual manda ignorar. Sin esto, «purpose» y «finding» salen en el centro
 * de todo mapa hecho con revistas de Emerald.
 */
const ROTULOS = new Set(
  'aim background conclusion design discussion finding introduction material method objective purpose result setting summary originality value limitation implication approach methodology'.split(' '),
);

/**
 * Palabras funcionales que nunca forman un término aunque el etiquetador se
 * equivoque con ellas. Pasa tras unos dos puntos: en «Purpose: This study», la
 * mayúscula hace que «This» salga como nombre propio.
 */
const FUNCIONALES = new Set(
  'a an the this that these those it its we our us they their them he she his her i my you your which who whom whose what where when why how there here also thus however et al'.split(' '),
);

/** El singular de un sustantivo en plural, con las reglas regulares del inglés. */
function singular(palabra) {
  if (palabra.length <= 3) return palabra;
  if (/ies$/.test(palabra)) return palabra.slice(0, -3) + 'y';
  if (/(ss|us|is|ics)$/.test(palabra)) return palabra;
  if (/(sses|xes|ches|shes|zes)$/.test(palabra)) return palabra.slice(0, -2);
  if (/s$/.test(palabra)) return palabra.slice(0, -1);
  return palabra;
}

const CORTE = /[.,;:!?()[\]{}"“”]/;

/**
 * Las frases nominales de un texto, ya en singular y en minúsculas.
 *
 * Un término es una secuencia de adjetivos y sustantivos que acaba en
 * sustantivo, sin cruzar signos de puntuación ni pronombres. Se guarda la
 * secuencia entera y no sus trozos: en «artificial neural network» el término
 * es ese, no también «neural network» y «network», como en VOSviewer.
 */
function frasesNominales(texto) {
  const frases = [];
  if (!texto) return frases;

  for (const oracion of nlp(texto).json({ terms: { normal: true } })) {
    let actual = [];
    const cerrar = () => {
      // Los adjetivos del final sobran: el término acaba en sustantivo.
      while (actual.length > 0 && !actual.at(-1).sustantivo) actual.pop();
      if (actual.length > 0 && actual.length <= 5) {
        const palabras = actual.map((t) => t.palabra);
        const frase = actual.map((t, i) => t.palabra + (i < actual.length - 1 ? (t.guion ? '-' : ' ') : '')).join('');
        const unaSola = actual.length === 1;
        if (!(unaSola && ROTULOS.has(palabras[0])) && frase.length >= 3 && /[a-z]/.test(frase)) {
          frases.push(frase);
        }
      }
      actual = [];
    };

    for (const t of oracion.terms ?? []) {
      // Un signo delante también corta: en «modeling (SEM)» el paréntesis va
      // pegado a «SEM», y sin esto salía «structural equation modeling sem».
      if (CORTE.test(t.pre ?? '')) cerrar();
      const tags = new Set(t.tags ?? []);
      const palabra = String(t.normal ?? '').replace(/[^a-z0-9-]/g, '');
      const funcional = ['Pronoun', 'Possessive', 'Determiner', 'Preposition', 'Conjunction'].some((g) => tags.has(g));
      const esSustantivo = tags.has('Noun') && !funcional;
      const esAdjetivo = tags.has('Adjective') && !funcional && !ADJETIVOS_GENERALES.has(palabra);
      const valido =
        palabra.length > 1 && !/^\d+$/.test(palabra) && !tags.has('Value') && !FUNCIONALES.has(palabra);

      if (valido && (esSustantivo || esAdjetivo)) {
        actual.push({
          palabra: esSustantivo && tags.has('Plural') ? singular(palabra) : palabra,
          sustantivo: esSustantivo,
          // «self-efficacy» llega como dos palabras con el guion detrás de la primera.
          guion: /^-$/.test(String(t.post ?? '').trim()),
        });
      } else {
        cerrar();
      }
      // Una coma o un punto pegados a la palabra cortan el término.
      if (CORTE.test(t.post ?? '')) cerrar();
    }
    cerrar();
  }
  return frases;
}

/**
 * La puntuación de relevancia de cada término (Van Eck y Waltman, 2011).
 *
 * Un término general —«new method», «important role»— aparece junto a toda
 * clase de términos, repartido como el conjunto. Uno específico —«emotional
 * exhaustion»— se concentra con unos pocos. Se mide cuánto se aparta el reparto
 * de sus coocurrencias del reparto general: la divergencia de Kullback-Leibler.
 * Cuanto mayor, más específico, y más merece estar en el mapa.
 *
 * `conjuntos`: los términos (candidatos) de cada documento. Devuelve un `Map`
 * de término a puntuación.
 */
function relevancia(conjuntos) {
  const fila = new Map();
  const columna = new Map();
  let total = 0;

  for (const terminos of conjuntos) {
    for (let i = 0; i < terminos.length; i += 1) {
      for (let j = 0; j < terminos.length; j += 1) {
        if (i === j) continue;
        const [a, b] = [terminos[i], terminos[j]];
        if (!fila.has(a)) fila.set(a, new Map());
        fila.get(a).set(b, (fila.get(a).get(b) ?? 0) + 1);
        columna.set(b, (columna.get(b) ?? 0) + 1);
        total += 1;
      }
    }
  }

  const puntuaciones = new Map();
  for (const [a, cuentas] of fila) {
    const suma = [...cuentas.values()].reduce((s, n) => s + n, 0);
    let kl = 0;
    for (const [b, n] of cuentas) {
      const p = n / suma;
      const q = columna.get(b) / total;
      kl += p * Math.log(p / q);
    }
    puntuaciones.set(a, kl);
  }
  return puntuaciones;
}

/**
 * Los términos de cada documento, listos para la red.
 *
 * `documentos`: `[{ texto }]`. `opciones`: `recuento` ('binario' | 'completo'),
 * `minimo` (ocurrencias; nulo = el de VOSviewer, 10, o menos si el conjunto es
 * pequeño), `porcentaje` de los más relevantes que se quedan (VOSviewer: 60).
 *
 * Devuelve `{ terminosDe, relevancias, minimo, candidatos, seleccionados }`.
 * `terminosDe[i]` son los términos elegidos del documento i, sin repetir: la
 * red se arma por coocurrencia en el documento, que es como la arma VOSviewer
 * con recuento binario. Con recuento completo lo que cambia es el número de
 * ocurrencias de cada término, que se devuelve en `ocurrencias`.
 */
function terminosDeLosDocumentos(documentos, opciones = {}) {
  // Las frases pueden venir ya extraídas: el asistente pide el umbral, la
  // lista y el mapa sobre los mismos textos, y etiquetar mil resúmenes tarda.
  const porDocumento = opciones.frases ?? documentos.map((d) => frasesNominales(d.texto));

  const binarias = new Map();
  const completas = new Map();
  const formas = new Map();
  for (const frases of porDocumento) {
    for (const f of frases) completas.set(f, (completas.get(f) ?? 0) + 1);
    for (const f of new Set(frases)) binarias.set(f, (binarias.get(f) ?? 0) + 1);
    for (const f of frases) formas.set(f, f);
  }

  const cuenta = opciones.recuento === 'completo' ? completas : binarias;
  // El 10 de VOSviewer está pensado para miles de resúmenes; con doscientos no
  // quedaría casi nada. Se baja hasta que haya con qué hacer un mapa.
  let minimo = Number.isInteger(opciones.minimo) && opciones.minimo >= 1 ? opciones.minimo : 10;
  const automatico = !(Number.isInteger(opciones.minimo) && opciones.minimo >= 1);
  const pasan = (m) => [...cuenta].filter(([, n]) => n >= m).length;
  if (automatico) while (minimo > 2 && pasan(minimo) < 60) minimo -= 1;

  const candidatos = new Set([...cuenta].filter(([, n]) => n >= minimo).map(([t]) => t));
  const conjuntos = porDocumento.map((frases) => [...new Set(frases)].filter((f) => candidatos.has(f)));
  const relevancias = relevancia(conjuntos);

  const porcentaje = Math.min(Math.max(Number(opciones.porcentaje) || 60, 10), 100);
  // «Choose number of terms» de VOSviewer: un número exacto gana al porcentaje.
  const cuantos = Number.isInteger(opciones.cuantos) && opciones.cuantos > 0
    ? Math.min(opciones.cuantos, candidatos.size)
    : Math.max(1, Math.round((candidatos.size * porcentaje) / 100));
  const seleccionados = new Set(
    [...candidatos]
      .sort((a, b) => (relevancias.get(b) ?? 0) - (relevancias.get(a) ?? 0) || a.localeCompare(b))
      .slice(0, cuantos),
  );

  return {
    terminosDe: conjuntos.map((ts) => ts.filter((t) => seleccionados.has(t))),
    ocurrencias: cuenta,
    relevancias,
    minimo,
    minimoAutomatico: automatico,
    candidatos: candidatos.size,
    seleccionados: seleccionados.size,
    distintos: cuenta.size,
  };
}

/**
 * Cuántas veces sale cada término, sin umbral: lo que necesita el paso
 * «Elegir el umbral». Binario = en cuántos documentos; completo = cuántas veces.
 */
function ocurrenciasDeTerminos(frases, recuento = 'binario') {
  const cuenta = new Map();
  for (const lista of frases) {
    for (const f of recuento === 'completo' ? lista : new Set(lista)) cuenta.set(f, (cuenta.get(f) ?? 0) + 1);
  }
  return [...cuenta.values()];
}

module.exports = { frasesNominales, relevancia, terminosDeLosDocumentos, ocurrenciasDeTerminos, singular };
