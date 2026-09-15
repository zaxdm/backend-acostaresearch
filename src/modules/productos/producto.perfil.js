'use strict';

/**
 * Qué es cada producto, dicho en un solo sitio.
 *
 * POR QUÉ EXISTE
 * --------------
 * «Tesis o artículo» se decidía con `productCode.startsWith('ARTICULO')` en
 * cada módulo que lo necesitaba, y todo lo que no empezara así recibía textos
 * de tesis. Con un tercer producto, el de informes, eso habría dicho «su tesis»
 * a un estudiante que entrega un informe de curso.
 *
 * Tesis y artículo devuelven EXACTAMENTE lo que ya decía el código, incluido
 * «entregarla» para el artículo: las instantáneas de `tests/instantaneas` lo
 * vigilan. Un código desconocido sigue siendo tesis, como antes.
 */

const TESIS = Object.freeze({
  tipo: 'tesis',
  obra: 'su tesis',
  laObra: 'la tesis',
  tuObra: 'tu tesis',
  entregarla: 'entregarla',
  revision: 'revisar_la_tesis',
  seccionesAparte: Object.freeze([]),
});

const ARTICULO = Object.freeze({
  tipo: 'articulo',
  obra: 'su artículo',
  laObra: 'el artículo',
  tuObra: 'tu artículo',
  entregarla: 'entregarla',
  revision: 'revisar_el_articulo',
  seccionesAparte: Object.freeze([]),
});

/**
 * El informe estudiantil.
 *
 * `seccionesAparte` son las que se escriben al final pero van delante en el
 * Word: el resumen y la introducción. No son skills del catálogo; se guardan
 * con su propia clave y el Word las pone antes de las fases, en este orden.
 */
const INFORME = Object.freeze({
  tipo: 'informe',
  obra: 'su informe',
  laObra: 'el informe',
  tuObra: 'tu informe',
  entregarla: 'entregarlo',
  revision: 'revisar_el_informe',
  seccionesAparte: Object.freeze([
    Object.freeze({ clave: 'informe-resumen', titulo: 'Resumen' }),
    Object.freeze({ clave: 'informe-introduccion', titulo: 'Introducción' }),
  ]),
});

/** El perfil de un producto por su código. Sin código o desconocido: tesis. */
function perfilDe(productCode) {
  const codigo = String(productCode ?? '');
  if (codigo.startsWith('ARTICULO')) return ARTICULO;
  if (codigo.startsWith('INFORME')) return INFORME;
  return TESIS;
}

module.exports = { perfilDe, TESIS, ARTICULO, INFORME };
