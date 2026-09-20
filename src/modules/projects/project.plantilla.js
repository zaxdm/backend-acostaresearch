'use strict';

/**
 * La plantilla de la universidad del tesista.
 *
 * Cada universidad tiene la suya, y son distintas entre sí en cosas que un
 * jurado mira: la fuente de los títulos, la numeración de los apartados, los
 * márgenes. Adivinarlas es imposible y aproximarlas es peor que no intentarlo,
 * porque el tesista se confía y entrega algo que no cumple.
 *
 * CÓMO SE HACE
 * ------------
 * El tesista sube el .docx que le dio su facultad. De ese archivo se saca UNA
 * sola pieza: `word/styles.xml`, la definición de sus estilos. Al armar el Word
 * se usa esa definición en lugar de la nuestra, así que «Título 1» pasa a ser
 * el Título 1 de su universidad y el documento sale con su formato sin que
 * nadie tenga que copiar nada a mano.
 *
 * QUÉ NO SE GUARDA, Y ES LO IMPORTANTE
 * ------------------------------------
 * El contenido del archivo NO. Una plantilla de facultad suele venir con
 * ejemplos, con el nombre de otro tesista, a veces con una tesis entera dentro.
 * Nada de eso hace falta y nada de eso se queda: se extrae el formato —la hoja
 * de estilos, los márgenes, la numeración de los títulos, el encabezado y el
 * pie— y, de la portada, solo la primera página y solo si el tesista escribió
 * en ella marcas como {{TITULO}} (ver `project.plantilla-partes`). El resto se
 * descarta en memoria. Lo que no se guarda no se puede filtrar.
 */

const { abrirZip } = require('./project.zip');

/** Un .docx de plantilla no llega ni a un mega; cinco es de sobra. */
const MAXIMO_BYTES = 5 * 1024 * 1024;

/** Lo que hace que un archivo sea un .docx de verdad y no otra cosa renombrada. */
const OBLIGATORIOS = ['[Content_Types].xml', 'word/document.xml'];

class PlantillaNoValida extends Error {}

/**
 * Saca la hoja de estilos de un .docx.
 *
 * Devuelve el XML como texto. Lanza `PlantillaNoValida` con un mensaje que se
 * le puede enseñar al tesista tal cual: aquí los errores los va a leer alguien
 * que subió el archivo equivocado, no un programador.
 */
function extraerEstilos(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new PlantillaNoValida('El archivo llegó vacío. Vuelve a subirlo.');
  }

  if (buffer.length > MAXIMO_BYTES) {
    throw new PlantillaNoValida(
      'Ese archivo pesa demasiado para ser una plantilla. Sube el documento de formato que ' +
        'te dio tu facultad, no tu tesis.',
    );
  }

  // Un .docx es un zip. Un .doc antiguo no, y es el error más probable.
  if (buffer.subarray(0, 2).toString() !== 'PK') {
    throw new PlantillaNoValida(
      'Eso no es un .docx. Si tu plantilla es un .doc antiguo, ábrela en Word y guárdala ' +
        'como «Documento de Word (.docx)».',
    );
  }

  let zip;
  try {
    zip = abrirZip(buffer);
  } catch {
    throw new PlantillaNoValida('No se pudo abrir el archivo. ¿Está completo?');
  }

  const dentro = new Set(zip.getEntries().map((e) => e.entryName));
  for (const necesario of OBLIGATORIOS) {
    if (!dentro.has(necesario)) {
      throw new PlantillaNoValida('Eso no parece un documento de Word. Sube el .docx de tu facultad.');
    }
  }

  const estilos = zip.getEntry('word/styles.xml');
  if (!estilos) {
    throw new PlantillaNoValida(
      'Ese documento no trae estilos definidos, así que no hay nada que copiar de él. ' +
        'Pide a tu facultad la plantilla con formato, no un documento en blanco.',
    );
  }

  const xml = estilos.getData().toString('utf8');

  if (!xml.includes('<w:styles')) {
    throw new PlantillaNoValida('Los estilos de ese documento no se pudieron leer.');
  }

  return xml;
}

/** Lo más grande que acepta Word para una medida de página, en twips (22 pulgadas). */
const MAXIMO_TWIPS = 31680;

// ── Las secciones ──────────────────────────────────────────────────────────

/**
 * Las secciones del documento, cada una con cuánto texto gobierna.
 *
 * Una plantilla hecha en Word suele tener una sola sección, al final. Una
 * convertida desde PDF tiene una por página —la de la UPN que se probó el 15 de
 * septiembre de 2026 traía 69—, y la última suele ser una hoja suelta de
 * anexos, horizontal o sin encabezado. Leer solo esa daba márgenes que no eran
 * los de la tesis y ningún encabezado.
 */
function seccionesDe(documento) {
  const secciones = [];
  let desde = 0;
  for (const m of String(documento).matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)) {
    const texto = documento.slice(desde, m.index).replace(/<[^>]+>/g, '').replace(/\s+/g, '').length;
    secciones.push({ xml: m[0], texto, horizontal: /w:orient="landscape"/.test(m[0]) });
    desde = m.index + m[0].length;
  }
  return secciones;
}

/**
 * La sección que manda en el cuerpo de la tesis: la vertical con más texto.
 *
 * Con sus encabezados y pies EFECTIVOS: una sección que no define el suyo usa el
 * de la última anterior que sí lo definió, que es como lo hace Word. En la
 * plantilla de la UPN solo la sección 2 los define, y las siguientes los heredan.
 */
function seccionPrincipal(documento) {
  const secciones = seccionesDe(documento);
  if (secciones.length === 0) return null;

  const verticales = secciones.filter((s) => !s.horizontal);
  const candidatas = verticales.length > 0 ? verticales : secciones;
  const principal = candidatas.reduce((mejor, s) => (s.texto > mejor.texto ? s : mejor));

  const efectivas = new Map();
  for (const seccion of secciones.slice(0, secciones.indexOf(principal) + 1)) {
    for (const r of seccion.xml.matchAll(/<w:(header|footer)Reference\b[^>]*?\/>/g)) {
      const tipo = (r[0].match(/w:type="(\w+)"/) || [])[1] ?? 'default';
      efectivas.set(`${r[1]}:${tipo}`, r[0]);
    }
  }
  return { ...principal, referencias: [...efectivas.values()] };
}

// ── El formato del cuerpo ──────────────────────────────────────────────────

const atributo = (xml, etiqueta, nombre) =>
  (String(xml ?? '').match(new RegExp(`<w:${etiqueta}\\b[^>]*\\bw:${nombre}="([^"]*)"`)) || [])[1];

/** El valor que más se repite. `NADA` cuenta como un valor más: si casi nadie lo define, no se inventa. */
const NADA = '∅';
function moda(valores) {
  const cuenta = new Map();
  for (const valor of valores) cuenta.set(valor ?? NADA, (cuenta.get(valor ?? NADA) ?? 0) + 1);
  const ganador = [...cuenta].sort((a, b) => b[1] - a[1])[0]?.[0];
  return ganador === NADA ? undefined : ganador;
}

function interiorDeEstilo(estilos, id) {
  if (!id) return '';
  const limpio = id.replace(/[^\w-]/g, '');
  const m = String(estilos).match(new RegExp(`<w:style\\b[^>]*w:styleId="${limpio}"[^>]*>([\\s\\S]*?)</w:style>`));
  return m ? m[1] : '';
}

/** Cuántos párrafos largos hacen falta para fiarse de su formato. */
const MINIMO_PARRAFOS = 5;

/**
 * El formato que más se repite en los párrafos largos: el del cuerpo de la tesis.
 *
 * Hace falta porque muchas plantillas no lo guardan en el estilo «Normal» sino
 * párrafo a párrafo —siempre las convertidas desde PDF—, y nuestro Word escribe
 * el texto en un solo estilo. Sin esto, una tesis a doble espacio salía a
 * espacio sencillo. Cada propiedad se mira aparte: la del párrafo y, si no la trae, la
 * de su estilo.
 */
function formatoDelCuerpo(documento, estilos) {
  const parrafos = [...String(documento).matchAll(/<w:p\b[^>]*>(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g)]
    .map((m) => m[0])
    .filter((p) => p.replace(/<[^>]+>/g, '').length > 200 && !/<w:numPr>/.test(p));
  if (parrafos.length < MINIMO_PARRAFOS) return null;

  const datos = parrafos.map((p) => {
    const pPr = (p.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/) || [, ''])[1].replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, '');
    const estilo = interiorDeEstilo(estilos, (pPr.match(/<w:pStyle w:val="([^"]+)"/) || [])[1]);
    const propio = (etiqueta, nombre) => atributo(pPr, etiqueta, nombre) ?? atributo(estilo, etiqueta, nombre);
    return {
      linea: propio('spacing', 'line'),
      reglaLinea: propio('spacing', 'lineRule'),
      izquierda: propio('ind', 'left') ?? propio('ind', 'start') ?? '0',
      derecha: propio('ind', 'right') ?? propio('ind', 'end') ?? '0',
      primeraLinea: propio('ind', 'firstLine') ?? '0',
      alineacion: propio('jc', 'val'),
      tamano: moda([...p.matchAll(/<w:sz w:val="(\d+)"/g)].map((m) => m[1])) ?? atributo(estilo, 'sz', 'val'),
    };
  });

  const campo = (nombre) => moda(datos.map((d) => d[nombre]));
  return {
    linea: campo('linea'),
    reglaLinea: campo('reglaLinea'),
    izquierda: Number(campo('izquierda') ?? 0) || 0,
    derecha: Number(campo('derecha') ?? 0) || 0,
    primeraLinea: Number(campo('primeraLinea') ?? 0) || 0,
    alineacion: campo('alineacion'),
    tamano: campo('tamano'),
  };
}

/**
 * La sangría que en realidad era margen.
 *
 * Al convertir un PDF a Word, el margen de la página queda casi en cero y cada
 * párrafo lleva la distancia al borde como sangría: margen izquierdo de 0,5 cm y
 * sangría de 2,5 cm en la plantilla de la UPN. Nuestro Word no lleva esa sangría
 * en cada párrafo, así que se devuelve al margen. Solo si el margen es menor de
 * 2 cm y el cuerpo está sangrado al menos 1 cm: en una plantilla normal, no.
 */
function sangriaDeConversion(principal, cuerpo) {
  const izquierdo = Number(atributo(principal?.xml, 'pgMar', 'left'));
  if (!cuerpo || !Number.isFinite(izquierdo)) return null;
  return cuerpo.izquierda >= 567 && izquierdo < 1134
    ? { izquierda: cuerpo.izquierda, derecha: cuerpo.derecha }
    : null;
}

// ── Retocar la hoja de estilos ─────────────────────────────────────────────

const ORDEN_PPR = [
  'pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr',
  'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap',
  'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd',
  'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc',
  'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr',
  'sectPr', 'pPrChange',
];
const ORDEN_RPR = [
  'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline',
  'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing',
  'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText',
  'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath',
];
const ORDEN_ESTILO = [
  'name', 'aliases', 'basedOn', 'next', 'link', 'autoRedefine', 'hidden', 'uiPriority', 'semiHidden',
  'unhideWhenUsed', 'qFormat', 'locked', 'personal', 'personalCompose', 'personalReply', 'rsid', 'pPr',
  'rPr', 'tblPr', 'trPr', 'tcPr', 'tblStylePr',
];

/** Los hijos directos de un trozo de XML. */
function hijosDe(interior) {
  const hijos = [];
  let profundidad = 0;
  let inicio = 0;
  let nombre = null;
  for (const m of String(interior).matchAll(/<[^>]+>/g)) {
    const pieza = m[0];
    const suyo = (pieza.match(/^<\/?\s*([\w:.-]+)/) || [])[1];
    if (pieza.startsWith('</')) {
      profundidad -= 1;
      if (profundidad === 0) hijos.push({ nombre, xml: interior.slice(inicio, m.index + pieza.length) });
    } else if (pieza.endsWith('/>')) {
      if (profundidad === 0) hijos.push({ nombre: suyo, xml: pieza });
    } else {
      if (profundidad === 0) {
        inicio = m.index;
        nombre = suyo;
      }
      profundidad += 1;
    }
  }
  return hijos;
}

/** En el orden que exige el esquema: Word da el archivo por dañado si no. */
function ordenar(hijos, orden) {
  const lugar = (nombre) => {
    const i = orden.indexOf(String(nombre).replace(/^w:/, ''));
    return i === -1 ? orden.length : i;
  };
  return hijos
    .map((hijo, i) => ({ ...hijo, i }))
    .sort((a, b) => lugar(a.nombre) - lugar(b.nombre) || a.i - b.i)
    .map((hijo) => hijo.xml);
}

/** Pone o cambia propiedades dentro del `pPr` o el `rPr` de un estilo. */
function conPropiedades(estilo, contenedor, cambios, orden) {
  const apertura = estilo.match(/^<w:style\b[^>]*>/)[0];
  const interior = estilo.slice(apertura.length, estilo.lastIndexOf('</w:style>'));
  const hijos = hijosDe(interior);
  const caja = hijos.find((h) => h.nombre === `w:${contenedor}`);
  const dentro = caja && !caja.xml.endsWith('/>')
    ? caja.xml.replace(new RegExp(`^<w:${contenedor}\\b[^>]*>`), '').replace(new RegExp(`</w:${contenedor}>$`), '')
    : '';

  const propiedades = hijosDe(dentro).filter((h) => !(String(h.nombre).replace(/^w:/, '') in cambios));
  for (const [nombre, xml] of Object.entries(cambios)) if (xml) propiedades.push({ nombre: `w:${nombre}`, xml });

  const resto = hijos.filter((h) => h !== caja);
  resto.push({ nombre: `w:${contenedor}`, xml: `<w:${contenedor}>${ordenar(propiedades, orden).join('')}</w:${contenedor}>` });
  return `${apertura}${ordenar(resto, ORDEN_ESTILO).join('')}</w:style>`;
}

function restarSangria(estilo, izquierda, derecha) {
  return estilo.replace(/<w:ind\b[^>]*\/>/g, (ind) =>
    ind.replace(/w:(left|start|right|end)="(-?\d+)"/g, (entero, lado, valor) => {
      const quitar = lado === 'left' || lado === 'start' ? izquierda : derecha;
      return `w:${lado}="${Math.max(0, Number(valor) - quitar)}"`;
    }),
  );
}

/** El estilo del texto de la tesis en nuestro Word, cuando hay plantilla de la que sacarlo. */
const ESTILO_CUERPO = 'CuerpoTesis';

/** La sangría de primera línea de APA, en twips: 1,27 cm, media pulgada. */
const PRIMERA_LINEA = 720;

function conFormatoDeCuerpo(estilo, cuerpo, conversion) {
  const pPr = {};
  if (cuerpo.linea) {
    const antes = (estilo.match(/<w:spacing\b([^>]*)\/>/) || [, ''])[1]
      .replace(/\s*w:(line|lineRule)="[^"]*"/g, '')
      .trim();
    pPr.spacing = `<w:spacing ${antes ? `${antes} ` : ''}w:line="${cuerpo.linea}" w:lineRule="${cuerpo.reglaLinea ?? 'auto'}"/>`;
  }
  const izquierda = cuerpo.izquierda - (conversion?.izquierda ?? 0);
  const derecha = cuerpo.derecha - (conversion?.derecha ?? 0);
  /**
   * Y si en la plantilla no se ve sangría de primera línea, la nuestra.
   *
   * La sangría se mide sobre los párrafos del archivo, y una plantilla
   * convertida desde PDF no la trae como sangría: el conversor la deja en
   * espacios o en un tabulador dentro del texto, así que aquí se lee cero y el
   * tesista veía su tesis con todos los párrafos pegados al margen mientras el
   * modelo de su facultad los sangra. Cero es lo que no se pudo leer, no una
   * decisión de nadie, y se rellena con el valor de nuestro formato, que es el
   * de APA y el que piden los reglamentos.
   */
  const primeraLinea = cuerpo.primeraLinea > 0 ? cuerpo.primeraLinea : PRIMERA_LINEA;
  const ind = [
    izquierda > 0 ? `w:left="${izquierda}"` : '',
    derecha > 0 ? `w:right="${derecha}"` : '',
    `w:firstLine="${primeraLinea}"`,
  ].filter(Boolean);
  if (ind.length > 0) pPr.ind = `<w:ind ${ind.join(' ')}/>`;
  if (cuerpo.alineacion) pPr.jc = `<w:jc w:val="${cuerpo.alineacion}"/>`;

  let nuevo = Object.keys(pPr).length > 0 ? conPropiedades(estilo, 'pPr', pPr, ORDEN_PPR) : estilo;
  if (cuerpo.tamano) {
    nuevo = conPropiedades(
      nuevo,
      'rPr',
      { sz: `<w:sz w:val="${cuerpo.tamano}"/>`, szCs: `<w:szCs w:val="${cuerpo.tamano}"/>` },
      ORDEN_RPR,
    );
  }
  return nuevo;
}

/**
 * La hoja de estilos con un estilo más, «Cuerpo de tesis», con el formato del
 * cuerpo de la plantilla.
 *
 * Es lo que hace que el texto salga con el interlineado, la sangría, la
 * alineación y el tamaño de letra de la tesis de la facultad aunque la
 * plantilla los ponga párrafo a párrafo. Va en un estilo PROPIO y no en
 * «Normal»: la portada, el encabezado y el pie de la plantilla también heredan
 * de «Normal», y con el doble espacio del texto la portada se salía de su hoja
 * y el número de página quedaba cortado dentro de su cuadro. Si la plantilla
 * viene de un PDF, además se quita a los estilos la sangría que en realidad era
 * margen (ver `sangriaDeConversion`).
 *
 * Nunca lanza: si no hay cuerpo del que fiarse, devuelve los estilos tal cual.
 */
function conFormatoDelCuerpo(estilos, buffer) {
  let documento;
  try {
    documento = abrirZip(buffer).getEntry('word/document.xml')?.getData().toString('utf8');
  } catch {
    return estilos;
  }
  const cuerpo = documento ? formatoDelCuerpo(documento, estilos) : null;
  if (!cuerpo) return estilos;

  const conversion = sangriaDeConversion(seccionPrincipal(documento), cuerpo);

  const ajustados = conversion
    ? estilos.replace(/<w:style\b[^>]*w:type="paragraph"[^>]*>[\s\S]*?<\/w:style>/g, (estilo) =>
        restarSangria(estilo, conversion.izquierda, conversion.derecha),
      )
    : estilos;
  if (!ajustados.includes('</w:styles>')) return ajustados;

  const sinElAnterior = ajustados.replace(
    new RegExp(`<w:style\\b[^>]*w:styleId="${ESTILO_CUERPO}"[\\s\\S]*?</w:style>`, 'g'),
    '',
  );
  const estiloDelCuerpo = conFormatoDeCuerpo(
    `<w:style w:type="paragraph" w:customStyle="1" w:styleId="${ESTILO_CUERPO}">` +
      '<w:name w:val="Cuerpo de tesis"/><w:basedOn w:val="Normal"/><w:qFormat/></w:style>',
    cuerpo,
    conversion,
  );
  return sinElAnterior.replace('</w:styles>', `${estiloDelCuerpo}</w:styles>`);
}

/**
 * Los márgenes y el tamaño de página de la plantilla.
 *
 * Viven fuera de la hoja de estilos, en la sección del documento
 * (`<w:sectPr>` de `word/document.xml`), así que con solo los estilos el Word
 * salía con nuestros márgenes aunque la facultad pidiera otros. Se leen de la
 * sección que gobierna el cuerpo (ver `seccionPrincipal`), y de ella solo se
 * sacan números: el texto del documento sigue sin guardarse.
 *
 * Devuelve null si no trae nada utilizable; entonces se usan los de siempre.
 */
function extraerPagina(buffer) {
  let zip;
  let xml;
  try {
    zip = abrirZip(buffer);
    xml = zip.getEntry('word/document.xml')?.getData().toString('utf8');
  } catch {
    return null;
  }
  if (!xml) return null;

  const principal = seccionPrincipal(xml);
  const seccion = principal?.xml;
  if (!seccion) return null;

  const atributos = (etiqueta) => {
    const m = seccion.match(new RegExp(`<w:${etiqueta}\\b([^>]*)/?>`));
    if (!m) return {};
    return Object.fromEntries(
      [...m[1].matchAll(/w:(\w+)="([^"]*)"/g)].map(([, nombre, valor]) => [nombre, valor]),
    );
  };

  // Word guarda negativos para «margen fijo aunque crezca el encabezado»; la
  // medida es la misma.
  const medida = (valor) => {
    const n = Math.abs(Number.parseInt(valor, 10));
    return Number.isInteger(n) && n <= MAXIMO_TWIPS ? n : undefined;
  };

  const mar = atributos('pgMar');
  const margen = {};
  for (const lado of ['top', 'right', 'bottom', 'left', 'header', 'footer', 'gutter']) {
    const n = medida(mar[lado]);
    if (n !== undefined) margen[lado] = n;
  }
  const completo = ['top', 'right', 'bottom', 'left'].every((lado) => margen[lado] !== undefined);

  const sz = atributos('pgSz');
  const ancho = medida(sz.w);
  const alto = medida(sz.h);
  const tamano = ancho && alto ? { width: ancho, height: alto } : null;

  if (!completo && !tamano) return null;

  // Una plantilla convertida desde PDF: la sangría de sus párrafos era margen.
  if (completo) {
    const estilos = zip.getEntry('word/styles.xml')?.getData().toString('utf8') ?? '';
    const conversion = sangriaDeConversion(principal, formatoDelCuerpo(xml, estilos));
    if (conversion) {
      margen.left = Math.min(MAXIMO_TWIPS, margen.left + conversion.izquierda);
      margen.right = Math.min(MAXIMO_TWIPS, margen.right + conversion.derecha);
    }
  }

  return { ...(completo ? { margen } : {}), ...(tamano ? { tamano } : {}) };
}

/**
 * Qué estilos trae, para poder decírselo al tesista.
 *
 * Enseñar «se aplicaron los estilos» no dice nada; enseñar «Título 1, Título 2,
 * Normal, Cita» le permite comprobar de un vistazo si subió el archivo bueno.
 */
function estilosQueTrae(xml) {
  const nombres = [...xml.matchAll(/<w:style [^>]*w:styleId="([^"]+)"/g)].map((m) => m[1]);
  return [...new Set(nombres)];
}

module.exports = {
  extraerEstilos,
  extraerPagina,
  estilosQueTrae,
  conFormatoDelCuerpo,
  formatoDelCuerpo,
  seccionPrincipal,
  seccionesDe,
  ESTILO_CUERPO,
  PlantillaNoValida,
  MAXIMO_BYTES,
};
