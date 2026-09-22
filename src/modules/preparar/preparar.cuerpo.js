'use strict';

/**
 * Qué es «el cuerpo» del documento.
 *
 * POR QUÉ UNA SOLA DEFINICIÓN
 * ---------------------------
 * El cuerpo se usa para dos cosas: contar las palabras que se le enseñan al
 * cliente y decidir qué párrafos se mandan al modelo. Si fueran dos listas
 * distintas, el servicio diría «12.400 palabras» y trabajaría sobre otras, y
 * nadie sabría cuál de las dos está mal. Es la misma lista.
 *
 * QUÉ QUEDA FUERA SIEMPRE, Y POR QUÉ
 * ----------------------------------
 * · La bibliografía. Una referencia no se edita ni se traduce: «Hernández, R.
 *   (2014). Metodología de la investigación» se queda como está en los cuatro
 *   idiomas, y traducir el título de un libro publicado en español haría
 *   imposible encontrarlo. `documento.leer` ya marca lo que cuelga del título
 *   «Referencias».
 * · El índice. `documento.leer` ya lo descarta: es un campo que Word rehace
 *   solo a partir de los títulos, y basta con actualizarlo.
 * · Lo que no tiene palabras: una línea de guiones, un número suelto.
 *
 * QUÉ QUEDA FUERA SOLO AL CORREGIR Y AL RESUMIR (`todo: false`)
 * -------------------------------------------------------------
 * · Las tablas. Corrigiendo el inglés, lo que hay dentro de una celda son
 *   datos, no prosa: cifras, siglas, rótulos de variable, y reescribirlos es
 *   estropearlos.
 * · Los rótulos de tabla y figura, y sus notas. «Tabla 3», «Nota. Elaboración
 *   propia» son andamiaje numerado.
 *
 * TRADUCIENDO ENTRA TODO (`todo: true`)
 * -------------------------------------
 * Porque un documento traducido a medias no le sirve a nadie, y las dos
 * excepciones de arriba dejaban en español justo lo que en una tesis peruana
 * está lleno de prosa: la matriz de consistencia, la de operacionalización y
 * los anexos, que son tablas de cabo a rabo. Y con ellas entran también las
 * notas al pie, las notas al final, el encabezado y el pie de página, que viven
 * en otros archivos del zip. Ver `preparar.partes`.
 *
 * Que una celda lleve una cifra y nada más no es un problema: el modelo tiene
 * prohibido tocar las cifras, `preparar.motor` lo comprueba, y un párrafo que
 * vuelve igual no se escribe.
 *
 * Esto NO significa que lo que queda fuera se pierda. Al revés: es justo lo que
 * sale intacto, porque el documento se devuelve entero y solo se tocan los
 * párrafos que están en esta lista.
 */

const documento = require('../projects/project.documento');
const partes = require('./preparar.partes');

/** Rótulos y notas de tabla o figura. Mismo criterio que `documento.service`. */
const ROTULO = /^((tabla|figura|gr[aá]fico|cuadro|ilustraci[oó]n)\s+\d+|nota\.\s)/i;

/** Una palabra: una tira de letras o cifras. Un «—» suelto no lo es. */
const PALABRA = /[\p{L}\p{N}]/u;

/**
 * Cuenta palabras como las contaría un jurado.
 *
 * En chino no hay espacios, así que partir por espacios daría 1 para un párrafo
 * entero. Cada carácter Han cuenta como palabra, que es la convención de las
 * revistas chinas y lo que hace que un documento traducido no parezca haber
 * encogido a la décima parte.
 */
function palabrasDe(texto) {
  const han = (String(texto).match(/[一-鿿㐀-䶿]/gu) ?? []).length;
  const resto = String(texto)
    .replace(/[一-鿿㐀-䶿]/gu, ' ')
    .split(/\s+/)
    .filter((trozo) => PALABRA.test(trozo)).length;

  return han + resto;
}

/**
 * Los párrafos sobre los que se trabaja, con su cuenta de palabras.
 *
 * `id` es el mismo que usa `project.documento`: el orden del párrafo dentro de
 * su archivo, contando los vacíos. `parte` dice en cuál de los archivos del zip
 * está, y `clave` es el nombre único que lo identifica ante el modelo y que
 * permite después escribir el texto nuevo en su sitio. Ver `preparar.partes`.
 *
 * Con `todo` entran las tablas, los rótulos y las demás partes del .docx. Es lo
 * que pide la traducción; la edición y el resumen se quedan con el cuerpo.
 */
function cuerpoDe(buffer, { todo = false } = {}) {
  const parrafos = documento
    .leer(buffer)
    .filter((parrafo) => !parrafo.referencias)
    .filter((parrafo) => todo || (!parrafo.enTabla && !ROTULO.test(parrafo.texto.trim())))
    .map((parrafo) => ({
      clave: String(parrafo.id),
      parte: partes.PRINCIPAL,
      id: parrafo.id,
      texto: parrafo.texto,
      nivel: parrafo.nivel,
      palabras: palabrasDe(parrafo.texto),
    }))
    .filter((parrafo) => parrafo.palabras > 0);

  if (todo) {
    const { zip } = documento.abrir(buffer);
    parrafos.push(...partes.parrafosDeOtrasPartes(zip, palabrasDe));
  }

  return {
    parrafos,
    palabras: parrafos.reduce((total, parrafo) => total + parrafo.palabras, 0),
  };
}

module.exports = { cuerpoDe, palabrasDe, ROTULO };
