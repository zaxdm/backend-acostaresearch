'use strict';

/**
 * El original y el resultado, párrafo a párrafo, para la vista «Lado a lado».
 *
 * DE DÓNDE SALE
 * -------------
 * De los dos .docx que ya están en disco —el que subió y el que se le
 * devuelve—, leídos al vuelo cada vez que abre la página. No se guarda nada
 * aparte, y por eso sirve también para los documentos entregados antes de que
 * existiera esta vista.
 *
 * Los párrafos se emparejan por su `clave` (el orden dentro de su archivo del
 * zip), que es la misma con la que el motor escribió el texto nuevo: ni la
 * edición ni la traducción añaden o quitan párrafos, solo cambian lo de dentro.
 *
 * Corrigiendo, el resultado lleva control de cambios. Lo que se lee de él es el
 * texto con TODO aceptado: lo tachado va en `<w:delText>`, que `documento`
 * no lee, y lo insertado en `<w:t>` normales.
 *
 * LA VERIFICACIÓN
 * ---------------
 * Lo que se comprueba aquí se comprueba de verdad, mirando los dos archivos:
 *   · Citas: las de Zotero y las escritas a mano, «(Pérez, 2020)» o «Pérez
 *     (2020)». Conservada = el apellido y el año siguen en el párrafo nuevo
 *     (traduciendo, «&» pasa a «y» y no por eso es otra cita).
 *   · Siglas: las que estaban siguen estando.
 *   · Bibliografía y tablas: el texto de cada una es idéntico en los dos.
 *     Traduciendo, las tablas SÍ se traducen y así se dice.
 */

const documento = require('../projects/project.documento');
const cuerpo = require('./preparar.cuerpo');
const partes = require('./preparar.partes');
const citasDeEstilo = require('./preparar.citas');

/** Una cita entre paréntesis con año: «(Pérez & Gómez, 2020, p. 4)», «(OMS, s.f.)». */
const CITA_PARENTESIS =
  /\((?=[^()]*\p{Lu})[^()]*?(?:\b(?:19|20)\d{2}[a-z]?\b|n\.\s?d\.|s\.\s?f\.|s\.\s?d\.)[^()]*\)/gu;

/** Una cita narrativa: «Pérez (2020)», «Pérez et al. (2020)», «Pérez y Gómez (2020)». */
const CITA_NARRATIVA =
  /\p{Lu}[\p{L}'’-]+(?:\s+(?:et al\.|(?:&|and|y|e)\s+\p{Lu}[\p{L}'’-]+))?\s+\((?:19|20)\d{2}[a-z]?\)/gu;

/** Una sigla: dos mayúsculas o más, con cifras detrás si las lleva. «PLS-SEM» son dos. */
const SIGLA = /(?<![\p{L}\p{N}])\p{Lu}{2,}[\p{Lu}\d]*s?(?![\p{L}\p{N}])/gu;

/** Los números romanos de los capítulos no son siglas: «CAPÍTULO II». */
const ROMANO = /^[IVXLCDM]+$/;

/** Palabras con mayúscula de una cita que no son apellidos. */
const NO_APELLIDO = new Set(['Et', 'Al', 'In', 'En', 'See', 'Ver', 'Véase', 'Cited', 'Citado', 'Como']);

/** Las citas que se ven en un texto, sin repetir y sin una dentro de otra. */
function citasEnTexto(texto, deZotero = []) {
  const halladas = [
    ...deZotero.filter(Boolean),
    ...(String(texto).match(CITA_PARENTESIS) ?? []),
    ...(String(texto).match(CITA_NARRATIVA) ?? []),
  ];
  const unicas = [...new Set(halladas.map((cita) => cita.trim()))].filter((cita) => cita.length > 0);
  // Una de Zotero suele ser también una entre paréntesis: se queda la más larga.
  return unicas.filter((cita) => !unicas.some((otra) => otra !== cita && otra.includes(cita)));
}

/** Lo que hace que una cita sea ESA cita: sus años y su primer apellido. */
function huellaDe(cita) {
  const anos = cita.match(/(?:19|20)\d{2}[a-z]?/g) ?? [];
  const apellido = (cita.match(/\p{Lu}[\p{L}'’-]+/gu) ?? []).find((p) => !NO_APELLIDO.has(p)) ?? null;
  return { anos, apellido };
}

function seConserva(cita, textoNuevo) {
  const { anos, apellido } = huellaDe(cita);
  if (textoNuevo.includes(cita)) return true;
  if (anos.length === 0 && !apellido) return true;
  return anos.every((ano) => textoNuevo.includes(ano)) && (!apellido || textoNuevo.includes(apellido));
}

/**
 * Las siglas de un párrafo. Un título escrito todo en mayúsculas —«CAPÍTULO
 * II: MARCO TEÓRICO»— no tiene siglas: tiene palabras, y traducidas cambian.
 */
function siglasDe(texto) {
  const letras = String(texto).match(/\p{L}/gu) ?? [];
  const mayusculas = String(texto).match(/\p{Lu}/gu) ?? [];
  if (letras.length > 0 && mayusculas.length / letras.length > 0.5) return new Set();
  return new Set((String(texto).match(SIGLA) ?? []).filter((sigla) => !ROMANO.test(sigla)));
}

/** Los textos de un .docx por clave: el cuerpo principal y, con `todo`, las demás partes. */
function textosPorClave(buffer, todo) {
  const { xml, zip } = documento.abrir(buffer);
  const porClave = new Map(documento.parrafosDe(xml).map((p) => [String(p.id), p.texto]));
  if (todo) {
    for (const p of partes.parrafosDeOtrasPartes(zip, cuerpo.palabrasDe)) porClave.set(p.clave, p.texto);
  }
  return porClave;
}

/**
 * ¿Salió idéntico lo que no se debía tocar? Compara los párrafos que cumplen
 * `cual` en el original con los mismos de la salida. Sin ninguno, es null: no
 * hay bibliografía o tablas que enseñar.
 */
function intacto(leidos, salida, cual) {
  const elegidos = leidos.filter(cual);
  if (elegidos.length === 0) return null;
  return elegidos.every((p) => (salida.get(String(p.id)) ?? '').trim() === p.texto.trim());
}

/**
 * La comparación entera.
 *
 * `parrafos` va en el orden del documento —el cuerpo y después las notas, el
 * encabezado y el pie—, con las citas de cada lado para que la web las pinte.
 */
function comparar({ entrada, salida, servicio, idioma = null }) {
  const todo = servicio === 'TRADUCCION';
  const originales = cuerpo.cuerpoDe(entrada, { todo }).parrafos;
  const resultado = textosPorClave(salida, todo);

  const citas = { total: 0, conservadas: 0 };
  const siglasAntes = new Set();
  const siglasDespues = new Set();

  const parrafos = originales.map((p) => {
    const nuevo = resultado.get(String(p.clave)) ?? p.texto;
    const deZotero = p.citas ?? [];
    const citasOriginal = citasEnTexto(p.texto, deZotero);
    const localizadas = idioma ? deZotero.map((c) => citasDeEstilo.localizar(c, idioma)) : deZotero;
    const citasResultado = citasEnTexto(nuevo, localizadas.filter((c) => nuevo.includes(c)));

    for (const cita of citasOriginal) {
      citas.total += 1;
      if (seConserva(cita, nuevo)) citas.conservadas += 1;
    }
    for (const s of siglasDe(p.texto)) siglasAntes.add(s);
    for (const s of siglasDe(nuevo)) siglasDespues.add(s);

    return {
      clave: String(p.clave),
      parte: partes.donde(p.parte),
      nivel: p.nivel ?? null,
      original: p.texto,
      resultado: nuevo,
      cambiado: nuevo !== p.texto,
      citasOriginal,
      citasResultado,
    };
  });

  const leidos = documento.leer(entrada);
  const bibliografia = intacto(leidos, resultado, (p) => p.referencias);
  const tablas = todo ? null : intacto(leidos, resultado, (p) => p.enTabla);

  return {
    parrafos,
    verificacion: {
      citas,
      siglas: {
        total: siglasAntes.size,
        conservadas: [...siglasAntes].filter((s) => siglasDespues.has(s)).length,
      },
      // null = el documento no tiene; true / false = idéntica o no.
      bibliografia,
      // Traduciendo, las tablas se traducen: 'TRADUCIDAS' en vez de un sí o un no.
      tablas: todo ? (leidos.some((p) => p.enTabla) ? 'TRADUCIDAS' : null) : tablas,
    },
  };
}

module.exports = { comparar, citasEnTexto, seConserva, siglasDe };
