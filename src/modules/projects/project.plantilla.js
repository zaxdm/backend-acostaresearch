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
function extraerEstilos(buffer, { maximo = MAXIMO_BYTES } = {}) {
  if (!buffer || buffer.length === 0) {
    throw new PlantillaNoValida('El archivo llegó vacío. Vuelve a subirlo.');
  }

  // El formato tomado de su avance (ver `formatoPropio`) viene de su tesis
  // entera, con figuras: ahí el tope es el del documento, no el de una plantilla.
  if (buffer.length > maximo) {
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
      // La letra, igual: la de las corridas y, si no la dicen, la de su estilo.
      // Una plantilla con «Normal» en Arial y el texto puesto a mano en Times
      // se ve en Times, y es lo que espera ver el tesista.
      fuente: moda([...p.matchAll(/<w:rFonts\b[^>]*\bw:(?:ascii|hAnsi)="([^"]+)"/g)].map((m) => m[1])) ??
        atributo(estilo, 'rFonts', 'ascii'),
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
    fuente: campo('fuente'),
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
  const rPr = {};
  if (cuerpo.tamano) {
    rPr.sz = `<w:sz w:val="${cuerpo.tamano}"/>`;
    rPr.szCs = `<w:szCs w:val="${cuerpo.tamano}"/>`;
  }
  if (cuerpo.fuente) rPr.rFonts = rFontsDe(cuerpo.fuente);
  if (Object.keys(rPr).length > 0) nuevo = conPropiedades(nuevo, 'rPr', rPr, ORDEN_RPR);
  return nuevo;
}

/** El nombre de una letra, a salvo dentro de un atributo de XML. */
const escaparAtributo = (texto) =>
  String(texto).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** La misma letra para todos los alfabetos: sin `cs`, una tilde podía salir en otra. */
const rFontsDe = (fuente) => {
  const f = escaparAtributo(fuente);
  return `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}"/>`;
};

const escaparRegex = (texto) => String(texto).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Los títulos ────────────────────────────────────────────────────────────

/** Los niveles de título que usa nuestro Word: el capítulo y tres de subtítulo. */
const NIVELES = [1, 2, 3, 4];

const ESTILO_DE_PARRAFO_RE = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g;

/** Nivel → identificador de su estilo de título, buscado por el nombre interno «heading N». */
function idsDeTitulos(estilos) {
  const ids = new Map();
  for (const m of String(estilos).matchAll(ESTILO_DE_PARRAFO_RE)) {
    if (!/w:type="paragraph"/.test(m[1])) continue;
    const id = (m[1].match(/w:styleId="([^"]+)"/) || [])[1];
    const nivel = Number((m[2].match(/<w:name w:val="heading (\d)"/i) || [])[1]);
    if (id && nivel && !ids.has(nivel)) ids.set(nivel, id);
  }
  return ids;
}

/**
 * Los títulos con el identificador que usa nuestro Word: «Heading1».
 *
 * Word en español guarda el Título 1 como `w:styleId="Ttulo1"` —el nombre
 * interno sigue siendo «heading 1»— y nuestro Word escribe los títulos en
 * «Heading1». Con esas plantillas los títulos de la facultad no se aplicaban
 * nunca: el estilo que buscaba el documento no estaba en la hoja de la
 * plantilla y quedaba el azul de 16 puntos de la librería. Se vio el 1 de
 * octubre de 2026 con una plantilla de la UNT hecha en Word en español.
 *
 * Devuelve también qué se renombró, porque el documento de la plantilla sigue
 * usando los nombres viejos y hay que leerlo con ellos.
 */
function conIdsDeTitulos(estilos) {
  let xml = String(estilos);
  const renombrados = new Map();
  for (const [nivel, id] of idsDeTitulos(xml)) {
    const nuevo = `Heading${nivel}`;
    if (id === nuevo || xml.includes(`w:styleId="${nuevo}"`)) continue;
    renombrados.set(id, nuevo);
  }
  for (const [viejo, nuevo] of renombrados) {
    const v = escaparRegex(viejo);
    xml = xml
      .replace(new RegExp(`(w:styleId=")${v}(")`, 'g'), `$1${nuevo}$2`)
      .replace(new RegExp(`(<w:(?:basedOn|next|link) w:val=")${v}(")`, 'g'), `$1${nuevo}$2`);
  }
  return { xml, renombrados };
}

/** Sí, no o no lo dice: `<w:b/>`, `<w:b w:val="0"/>` o nada. */
function interruptor(rPr, etiqueta) {
  const m = String(rPr).match(new RegExp(`<w:${etiqueta}(?=[\\s/>])([^>]*)/?>`));
  if (!m) return undefined;
  const valor = (m[1].match(/w:val="([^"]*)"/) || [])[1];
  return valor && /^(0|false|off)$/i.test(valor) ? 'no' : 'si';
}

/**
 * Cómo se ven los párrafos que usan un estilo de título: lo que les pusieron a mano.
 *
 * Solo lo que el párrafo dice por su cuenta; lo que no dice, lo pone el estilo
 * y ya se ve como el estilo. Por propiedad, lo que más se repite.
 */
function comoSeVen(documento, id) {
  const marca = `<w:pStyle w:val="${id}"/>`;
  const parrafos = [...String(documento).matchAll(/<w:p\b[^>]*>(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g)]
    .map((m) => m[0])
    .filter((p) => p.includes(marca) && /<w:t[\s>][^<]*\S/.test(p));
  if (parrafos.length === 0) return null;

  const datos = parrafos.map((p) => {
    const pPr = (p.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/) || [, ''])[1].replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, '');
    const corridas = [...p.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)]
      .map((m) => m[1])
      .filter((r) => /<w:t[\s>][^<]*\S/.test(r))
      .map((r) => (r.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [, ''])[1]);
    const deCorridas = (leer) => moda(corridas.map(leer));
    return {
      alineacion: atributo(pPr, 'jc', 'val'),
      color: deCorridas((r) => atributo(r, 'color', 'val')),
      tamano: deCorridas((r) => atributo(r, 'sz', 'val')),
      fuente: deCorridas((r) => atributo(r, 'rFonts', 'ascii') ?? atributo(r, 'rFonts', 'hAnsi')),
      negrita: deCorridas((r) => interruptor(r, 'b')),
      cursiva: deCorridas((r) => interruptor(r, 'i')),
      mayusculas: deCorridas((r) => interruptor(r, 'caps')),
    };
  });

  const formato = {};
  for (const campo of Object.keys(datos[0])) {
    const valor = moda(datos.map((d) => d[campo]));
    if (valor !== undefined) formato[campo] = valor;
  }
  return formato;
}

/** Un formato de título ({alineacion, color, tamano, fuente, negrita, cursiva, mayusculas}) escrito en su estilo. */
function conFormatoDeTitulo(estilo, formato) {
  const si = (valor, etiqueta) =>
    valor === undefined ? null : valor === 'si' ? `<w:${etiqueta}/>` : `<w:${etiqueta} w:val="0"/>`;
  const rPr = {};
  if (formato.color) rPr.color = `<w:color w:val="${formato.color}"/>`;
  if (formato.tamano) {
    rPr.sz = `<w:sz w:val="${formato.tamano}"/>`;
    rPr.szCs = `<w:szCs w:val="${formato.tamano}"/>`;
  }
  if (formato.rFonts) rPr.rFonts = formato.rFonts;
  else if (formato.fuente) rPr.rFonts = rFontsDe(formato.fuente);
  if (formato.negrita) Object.assign(rPr, { b: si(formato.negrita, 'b'), bCs: si(formato.negrita, 'bCs') });
  if (formato.cursiva) Object.assign(rPr, { i: si(formato.cursiva, 'i'), iCs: si(formato.cursiva, 'iCs') });
  if (formato.mayusculas) rPr.caps = si(formato.mayusculas, 'caps');

  let nuevo = Object.keys(rPr).length > 0 ? conPropiedades(estilo, 'rPr', rPr, ORDEN_RPR) : estilo;
  const pPr = {};
  if (formato.alineacion) pPr.jc = `<w:jc w:val="${formato.alineacion}"/>`;
  if (formato.sinSangria) pPr.ind = '<w:ind w:left="0" w:firstLine="0"/>';
  if (Object.keys(pPr).length > 0) nuevo = conPropiedades(nuevo, 'pPr', pPr, ORDEN_PPR);
  return nuevo;
}

/** Los azules con que Word trae sus títulos de fábrica, de la versión 2007 a la de hoy. */
const AZUL_DE_WORD = /^(2F5496|1F3763|365F91|4F81BD|243F60|0F4761|2E74B5|1F4D78|1F3864)$/i;

/** Un título que nadie tocó: el de fábrica de Word, azul o con la letra de títulos del tema. */
function esDeFabrica(interior) {
  return (
    /w:themeColor="accent\d"/.test(interior) ||
    AZUL_DE_WORD.test(atributo(interior, 'color', 'val') ?? '') ||
    /w:asciiTheme="major/.test(interior)
  );
}

/** El aspecto de cada nivel en APA 7: 1 centrado en negrita, 2 a la izquierda en negrita, 3 además en cursiva. */
const APA = {
  1: { alineacion: 'center', negrita: 'si', cursiva: 'no' },
  2: { alineacion: 'left', negrita: 'si', cursiva: 'no' },
  3: { alineacion: 'left', negrita: 'si', cursiva: 'si' },
  4: { alineacion: 'left', negrita: 'si', cursiva: 'no' },
};

/**
 * La letra y el tamaño del texto, para que los títulos vayan con lo mismo.
 *
 * Del estilo del cuerpo, de «Normal» o de los valores por defecto del
 * documento, lo primero que los diga. La letra se copia tal cual —también si es
 * la del tema—, para no cambiar una Calibri por otra cosa.
 */
function letraDelCuerpo(estilos) {
  const xml = String(estilos);
  const fuentes = [
    interiorDeEstilo(xml, ESTILO_CUERPO),
    interiorDeEstilo(xml, 'Normal'),
    (xml.match(/<w:rPrDefault>([\s\S]*?)<\/w:rPrDefault>/) || [, ''])[1],
  ];
  const rFonts = fuentes.map((f) => (f.match(/<w:rFonts\b[^>]*\/>/) || [])[0]).find(Boolean);
  const tamano = fuentes.map((f) => atributo(f, 'sz', 'val')).find(Boolean) ?? '24';
  return {
    rFonts:
      rFonts ??
      '<w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" w:eastAsiaTheme="minorHAnsi" w:cstheme="minorBidi"/>',
    tamano,
  };
}

/** Pone un estilo en su sitio de la hoja, o lo crea si no estaba. */
function cambiarEstilo(estilos, id, cambiar, crear) {
  const re = new RegExp(`<w:style\\b[^>]*w:styleId="${escaparRegex(id)}"[^>]*>[\\s\\S]*?</w:style>`);
  if (re.test(estilos)) return estilos.replace(re, (estilo) => cambiar(estilo));
  if (!crear || !estilos.includes('</w:styles>')) return estilos;
  return estilos.replace('</w:styles>', `${cambiar(crear)}</w:styles>`);
}

/** Un estilo de título nuevo, para cuando la hoja no trae ese nivel. */
const tituloNuevo = (nivel) =>
  `<w:style w:type="paragraph" w:styleId="Heading${nivel}"><w:name w:val="heading ${nivel}"/>` +
  '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>' +
  `<w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="${nivel - 1}"/></w:pPr></w:style>`;

/**
 * Los títulos de la hoja como se ven en la plantilla.
 *
 * El caso que lo pidió: una plantilla con su «Título 1» en Arial azul de 16
 * puntos, y cada título de la página puesto a mano en Times negro de 12. El
 * tesista ve Times negro, que es lo que pide su facultad, y nuestro Word salía
 * con el estilo, azul y grande. Con el cuerpo ya se hacía esto (ver
 * `conFormatoDelCuerpo`); con los títulos no.
 *
 * Dos casos:
 * - Si la plantilla usa ese estilo, lo que los párrafos llevan a mano pasa al
 *   estilo: manda lo que se ve.
 * - Si no lo usa y el estilo es el de fábrica de Word —azul, letra de títulos
 *   del tema—, la facultad no lo definió: se pone como APA 7, con la letra y el
 *   tamaño del texto. Es lo que hace nuestro formato por defecto.
 *
 * Un título que la facultad definió de verdad y no usa en la página se queda
 * como está. Devuelve la hoja y qué se cambió, para decírselo al tesista.
 */
function conTitulosComoSeVen(estilos, buffer, renombrados = new Map()) {
  let documento = '';
  try {
    documento = abrirZip(buffer).getEntry('word/document.xml')?.getData().toString('utf8') ?? '';
  } catch {
    return { xml: estilos, cambios: [] };
  }

  const originales = new Map([...renombrados].map(([viejo, nuevo]) => [nuevo, viejo]));
  const vistos = [];
  const deFabrica = [];
  const faltaban = [];
  let xml = String(estilos);
  const comoApa = (nivel) => {
    const letra = letraDelCuerpo(xml);
    return (estilo) =>
      conFormatoDeTitulo(estilo, { ...APA[nivel], color: '000000', tamano: letra.tamano, rFonts: letra.rFonts });
  };
  for (const nivel of NIVELES) {
    const id = `Heading${nivel}`;
    const interior = interiorDeEstilo(xml, id);
    // Sin ese nivel en su hoja, Word tomaba el de la librería: azul. Se crea
    // como APA, igual que uno de fábrica.
    if (!interior) {
      xml = cambiarEstilo(xml, id, comoApa(nivel), tituloNuevo(nivel));
      faltaban.push(nivel);
      continue;
    }

    const visto = comoSeVen(documento, originales.get(id) ?? id);
    if (visto && Object.keys(visto).length > 0) {
      xml = cambiarEstilo(xml, id, (estilo) => conFormatoDeTitulo(estilo, visto));
      vistos.push(nivel);
    } else if (!visto && esDeFabrica(interior)) {
      xml = cambiarEstilo(xml, id, comoApa(nivel));
      deFabrica.push(nivel);
    }
  }

  const cambios = [];
  if (vistos.length > 0) {
    cambios.push(`los títulos de nivel ${enLista(vistos)} tomaron el formato que se ve en la plantilla`);
  }
  if (deFabrica.length > 0) {
    cambios.push(
      `los títulos de nivel ${enLista(deFabrica)} venían con el formato de fábrica de Word (azul) y ` +
        'se pusieron en negro y en APA 7, con la letra del texto',
    );
  }
  if (faltaban.length > 0) {
    cambios.push(`los títulos de nivel ${enLista(faltaban)} no venían en la plantilla y se pusieron en APA 7`);
  }
  return { xml, cambios };
}

const enLista = (cosas) => (cosas.length > 1 ? `${cosas.slice(0, -1).join(', ')} y ${cosas.at(-1)}` : String(cosas[0]));

/**
 * La hoja de estilos que se guarda de una plantilla, con todo lo de arriba hecho.
 *
 * En este orden: los títulos con el identificador que usa nuestro Word, el
 * estilo del cuerpo y los títulos como se ven. Devuelve también los cambios, que
 * se le cuentan al tesista al subirla.
 */
function estilosParaGuardar(buffer, opciones = {}) {
  const { xml: conIds, renombrados } = conIdsDeTitulos(extraerEstilos(buffer, opciones));
  const conCuerpo = conFormatoDelCuerpo(conIds, buffer);
  return conTitulosComoSeVen(conCuerpo, buffer, renombrados);
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

// ── ¿Su Word ya trae el formato de su universidad? ─────────────────────────

/** Las letras con las que abre un Word nuevo: un avance en ellas no se formateó. */
const LETRAS_DE_FABRICA = /^(calibri|calibri light|aptos|aptos display|cambria)$/i;

/**
 * Si el avance que sube el tesista trae un formato propio que conviene usar en
 * su Word en lugar del formato por defecto.
 *
 * Muchos tesistas ya escriben sobre la plantilla de su universidad y suben ESE
 * Word como avance; antes el formato se tiraba y el Word salía en el de por
 * defecto (APA 7 según la UNT), distinto del suyo. Pero un avance escrito en un
 * Word recién abierto (Calibri 11, interlineado 1,08) no trae formato de nadie,
 * y copiarlo dejaría su tesis peor que el formato por defecto. Se considera
 * propio si el cuerpo va a 1,5 o más de interlineado, o en letra de 12 puntos
 * o más que no es la de fábrica de Word.
 *
 * Devuelve `{ propio, cuerpo }`, con lo que se vio del cuerpo para decírselo.
 */
function formatoPropio(buffer) {
  let documento;
  let estilos;
  try {
    const zip = abrirZip(buffer);
    documento = zip.getEntry('word/document.xml')?.getData().toString('utf8');
    estilos = zip.getEntry('word/styles.xml')?.getData().toString('utf8') ?? '';
  } catch {
    return { propio: false, cuerpo: null };
  }
  const cuerpo = documento ? formatoDelCuerpo(documento, estilos) : null;
  if (!cuerpo) return { propio: false, cuerpo: null };

  // Lo que el cuerpo no dice lo dice la hoja: los valores por defecto del documento.
  const porDefecto = (String(estilos).match(/<w:docDefaults>([\s\S]*?)<\/w:docDefaults>/) || [, ''])[1];
  const linea = Number(cuerpo.linea ?? atributo(porDefecto, 'spacing', 'line') ?? 240);
  const regla = cuerpo.reglaLinea ?? atributo(porDefecto, 'spacing', 'lineRule') ?? 'auto';
  const mediosPuntos = Number(cuerpo.tamano ?? atributo(porDefecto, 'sz', 'val') ?? 22);
  // Sin letra escrita, la del tema: la de fábrica (Calibri o Aptos).
  const fuente = cuerpo.fuente ?? atributo(porDefecto, 'rFonts', 'ascii') ?? null;

  const interlineado = regla === 'auto' ? Math.round((linea / 240) * 100) / 100 : null;
  const espaciado = interlineado !== null && interlineado >= 1.4;
  const letraDeTesis = mediosPuntos >= 24 && Boolean(fuente) && !LETRAS_DE_FABRICA.test(fuente);

  return {
    propio: espaciado || letraDeTesis,
    cuerpo: { fuente, puntos: mediosPuntos / 2, interlineado },
  };
}

module.exports = {
  formatoPropio,
  extraerEstilos,
  extraerPagina,
  estilosQueTrae,
  conFormatoDelCuerpo,
  formatoDelCuerpo,
  conIdsDeTitulos,
  conTitulosComoSeVen,
  estilosParaGuardar,
  // Para los ajustes dichos en el chat (`project.plantilla-ajustes`).
  conPropiedades,
  conFormatoDeTitulo,
  cambiarEstilo,
  tituloNuevo,
  interiorDeEstilo,
  rFontsDe,
  APA,
  NIVELES,
  ORDEN_PPR,
  ORDEN_RPR,
  seccionPrincipal,
  seccionesDe,
  ESTILO_CUERPO,
  PlantillaNoValida,
  MAXIMO_BYTES,
};
