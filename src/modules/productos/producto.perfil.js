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
  mapeoBibliometrico: false,
});

const ARTICULO = Object.freeze({
  tipo: 'articulo',
  obra: 'su artículo',
  laObra: 'el artículo',
  tuObra: 'tu artículo',
  entregarla: 'entregarla',
  revision: 'revisar_el_articulo',
  /**
   * El mapeo bibliométrico es de la ruta del artículo, y solo de ella.
   *
   * Es una decisión de producto, no una limitación técnica: el mapeo describe
   * un campo entero —producción, autores, fuentes, coocurrencia, cocitación— y
   * eso es un artículo bibliométrico o la revisión sistemática de uno. En una
   * tesis, el botón invitaba a montar un análisis que no le pedía nadie y que
   * no cabe en su capítulo de Antecedentes.
   *
   * Decide a qué proyectos se puede mandar el mapeo desde el buscador de
   * Scopus (`scopus.service.destinosDelMapeo`).
   */
  mapeoBibliometrico: true,
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
  mapeoBibliometrico: false,
  seccionesAparte: Object.freeze([
    Object.freeze({ clave: 'informe-resumen', titulo: 'Resumen' }),
    Object.freeze({ clave: 'informe-introduccion', titulo: 'Introducción' }),
  ]),
});

/**
 * El Trabajo de Suficiencia Profesional (TSP).
 *
 * Es otra modalidad de titulación, no otro tipo de documento: lleva portada,
 * índice, páginas preliminares, asesor y reglamento de facultad como una
 * tesis. Por eso su `tipo` es 'tesis' —todo lo que el Word y el panel hacen
 * con una tesis le vale tal cual— y lo que cambia va en `modalidad` y en los
 * textos. Lo que de verdad lo distingue, que no lleva hipótesis, ni
 * instrumento, ni muestra, lo deciden sus propias skills (`tsp-fase*`): el
 * catálogo de su grupo es otro, y con él el orden, el «¿qué sigue?» y la barra
 * de avance.
 *
 * NO cambia el perfil de tesis: las instantáneas siguen vigilando TESIS.
 */
const TSP = Object.freeze({
  ...TESIS,
  modalidad: 'tsp',
  obra: 'su trabajo de suficiencia profesional',
  laObra: 'el trabajo de suficiencia profesional',
  tuObra: 'tu trabajo de suficiencia profesional',
  entregarla: 'entregarlo',
  /** Cómo se llama la ruta en el catálogo y el archivo del Word. */
  ruta: 'Ruta del Trabajo de Suficiencia Profesional',
  archivo: 'suficiencia-profesional',
});

/**
 * El Taller Investigador PRO (4-nov-2026), códigos TALLER*.
 *
 * Forma a docentes y egresados de posgrado para publicar un artículo con rigor:
 * diagnóstico, plan de publicación, vacío y aporte, comité de ética,
 * recolección y auditoría de integridad (`taller-fase*`). Lo que el docente
 * acaba escribiendo es un artículo, así que su `tipo` es 'articulo': sin
 * portada ni páginas de tesis, y con la plantilla de la revista como formato.
 * Lo que lo distingue va en `modalidad`, la cabecera y el nombre del Word.
 *
 * Desde el 4-nov-2026 verifica citas como el artículo empírico (`verificaCitas`):
 * su redacción usa las skills `articulo-fase*`, que llaman a `verificar_citas`.
 */
const TALLER = Object.freeze({
  ...ARTICULO,
  modalidad: 'taller',
  ruta: 'Taller Investigador PRO',
  archivo: 'taller-investigador',
});

/**
 * Sesiones de aprendizaje para educación superior (4-nov-2026), códigos SESIONES*.
 *
 * Quien compra es un docente, no un tesista: sube su sílabo y planifica las
 * sesiones de su curso (`sesiones-fase*`). No investiga, así que no lleva
 * fuentes, ni análisis, ni norma de citas, ni asesor, ni páginas de tesis. Su
 * `tipo` es propio porque nada de lo que el código hace con una tesis, un
 * artículo o un informe le sirve tal cual: lo que necesita se decide por
 * `tipo === 'docente'` en cada sitio (ver `skills/sesiones-superior/LEEME.md`).
 */
const DOCENTE = Object.freeze({
  tipo: 'docente',
  modalidad: 'sesiones',
  obra: 'sus sesiones de aprendizaje',
  laObra: 'las sesiones',
  tuObra: 'tus sesiones de aprendizaje',
  entregarla: 'entregarlas',
  // No hay repaso propio todavía: `continuar` no lo ofrece y la herramienta no se registra.
  revision: null,
  seccionesAparte: Object.freeze([]),
  mapeoBibliometrico: false,
  ruta: 'Sesiones de aprendizaje · educación superior',
  archivo: 'sesiones-de-aprendizaje',
});

/** El perfil de un producto por su código. Sin código o desconocido: tesis. */
function perfilDe(productCode) {
  const codigo = String(productCode ?? '');
  if (codigo.startsWith('ARTICULO')) return ARTICULO;
  if (codigo.startsWith('INFORME')) return INFORME;
  if (codigo.startsWith('TSP')) return TSP;
  if (codigo.startsWith('TALLER')) return TALLER;
  if (codigo.startsWith('SESIONES')) return DOCENTE;
  return TESIS;
}

/**
 * ¿Es una tesis de las de siempre, con hipótesis y método?
 *
 * Para lo que es del método de tesis y no de cualquier trabajo de grado: el
 * perfil de país (TFG/TFM), que reescribe la estructura en términos de
 * metodología y resultados que un TSP no tiene.
 */
function esTesisDelMetodo(productCode) {
  return perfilDe(productCode) === TESIS;
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

/**
 * ¿El autor verifica sus citas y el servidor exige el análisis? (3-nov-2026)
 *
 * Solo el artículo empírico: la herramienta `verificar_citas`, el bloque
 * «CITAS Y DATOS» al guardar y lo que suma al repaso. Sus skills son las únicas
 * que lo explican. La revisión (`ARTICULOS_REVIEW`, también empieza por
 * ARTICULO), la tesis, la TSP y el informe se quedan como estaban hasta que sus
 * skills lo cuenten; decisión del usuario. El Taller (TALLER*) también, desde el
 * 4-nov-2026: redacta su artículo con las mismas skills del artículo empírico.
 */
function verificaCitas(productCode) {
  const codigo = String(productCode ?? '');
  const perfil = perfilDe(codigo);
  return (perfil === ARTICULO && !/REVIEW/i.test(codigo)) || perfil === TALLER;
}

module.exports = { perfilDe, esTesisDelMetodo, traeHerramientas, verificaCitas, TESIS, ARTICULO, INFORME, TSP, TALLER, DOCENTE };
