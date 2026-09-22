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
 * QUÉ QUEDA FUERA, Y POR QUÉ
 * --------------------------
 * · La bibliografía. Una referencia no se edita ni se traduce: «Hernández, R.
 *   (2014). Metodología de la investigación» se queda como está en los cuatro
 *   idiomas, y traducir el título de un libro publicado en español haría
 *   imposible encontrarlo. `documento.leer` ya marca lo que cuelga del título
 *   «Referencias».
 * · Las tablas. Lo que hay dentro de una celda son datos, no prosa: cifras,
 *   siglas, rótulos de variable. Reescribirlos es estropearlos.
 * · Los rótulos de tabla y figura, y sus notas. «Tabla 3», «Nota. Elaboración
 *   propia» son andamiaje numerado; si el modelo los toca, la numeración del
 *   documento deja de cuadrar con el texto que la cita.
 * · El índice. `documento.leer` ya lo descarta.
 * · Lo que no tiene palabras: una línea de guiones, un número suelto.
 *
 * Esto NO significa que esas partes se pierdan. Al revés: son justo las que
 * salen intactas, porque el documento se devuelve entero y solo se tocan los
 * párrafos que están en esta lista.
 */

const documento = require('../projects/project.documento');

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
 * `id` es el mismo que usa `project.documento`: el orden del párrafo en el
 * documento entero, contando los vacíos. Es lo que después permite escribir el
 * texto nuevo en su sitio con `project.reescritura`.
 */
function cuerpoDe(buffer) {
  const parrafos = documento
    .leer(buffer)
    .filter((parrafo) => !parrafo.enTabla && !parrafo.referencias)
    .filter((parrafo) => !ROTULO.test(parrafo.texto.trim()))
    .map((parrafo) => ({
      id: parrafo.id,
      texto: parrafo.texto,
      nivel: parrafo.nivel,
      palabras: palabrasDe(parrafo.texto),
    }))
    .filter((parrafo) => parrafo.palabras > 0);

  return {
    parrafos,
    palabras: parrafos.reduce((total, parrafo) => total + parrafo.palabras, 0),
  };
}

module.exports = { cuerpoDe, palabrasDe, ROTULO };
