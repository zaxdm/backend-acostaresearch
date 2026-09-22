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

/**
 * Los productos que NO traen las herramientas del panel.
 *
 * Las herramientas son Scopus, Zotero, Mendeley, el análisis en R y el
 * cualitativo (ATLAS.ti), con el mapa de VOSviewer detrás. Son de quien está
 * haciendo una investigación: traer fuentes, analizar datos, codificar
 * entrevistas. Quien compra SOLO el Humanizador académico no está haciendo
 * nada de eso —trae un texto ya escrito y se lo devolvemos sin patrones de
 * IA—, así que enseñarle cinco pestañas que no le sirven es venderle la idea
 * de que compró algo más de lo que compró.
 *
 * Por prefijo del código, como `perfilDe`: un grupo que se cree en el panel
 * con el código `HUMANIZADOR_ACADEMICO` —o cualquiera que empiece por
 * HUMANIZ— nace sin herramientas, sin tocar código ni base de datos.
 *
 * NO cambia su perfil: sigue siendo TESIS a efectos de textos, porque lo que
 * humaniza es un capítulo de tesis. Lo único que decide esto es si el panel le
 * ofrece las herramientas y si el servidor las atiende para ese producto.
 */
const SIN_HERRAMIENTAS = /^HUMANIZ/i;

function traeHerramientas(productCode) {
  return !SIN_HERRAMIENTAS.test(String(productCode ?? '').trim());
}

module.exports = { perfilDe, traeHerramientas, TESIS, ARTICULO, INFORME };
