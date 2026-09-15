'use strict';

/**
 * Lo que se copia de la plantilla además de sus estilos y sus márgenes.
 *
 * POR QUÉ EXISTE
 * --------------
 * Con solo la hoja de estilos, el Word tenía la letra y los colores de la
 * facultad, pero no lo que un jurado mira primero: los títulos numerados
 * («1.1», «1.1.1»), el encabezado con el nombre de la universidad y la portada.
 * Cada una de esas cosas vive en otra parte del .docx, y aquí se copian:
 *
 *   - la NUMERACIÓN (`word/numbering.xml`): los estilos de título la citan por
 *     número, y sin ella los títulos salían sin su «1.1»;
 *   - el ENCABEZADO y el PIE (`word/headerN.xml`, `word/footerN.xml`), con sus
 *     imágenes —el logo—, el normal y el de la primera página;
 *   - la PORTADA: la primera página, hasta el primer salto de página.
 *
 * LA PORTADA SOLO CON MARCAS
 * --------------------------
 * Una plantilla de facultad viene con la portada de ejemplo, y a veces con el
 * nombre de otro tesista. Así que la portada solo se guarda si el tesista ha
 * escrito en ella dónde van sus datos: {{TITULO}}, {{AUTOR}}, {{CARRERA}},
 * {{UNIVERSIDAD}}, {{AÑO}}. Esas marcas se rellenan al descargar; las que no se
 * conocen —{{ASESOR}}— se dejan a la vista para que las complete a mano. Sin
 * marcas, sale nuestra portada, y se le dice por qué.
 *
 * Del resto del documento no se guarda nada: todo lo que no es una de estas
 * partes se descarta en memoria, como hasta ahora.
 *
 * CÓMO SE APLICA
 * --------------
 * Como los campos de Zotero: en el .docx ya empaquetado, porque la librería no
 * sabe insertar XML ajeno. Las imágenes se copian con un nombre sacado de su
 * contenido y las relaciones se renumeran para no chocar con las nuestras.
 */

const crypto = require('crypto');
const path = require('path');
const AdmZip = require('adm-zip');

const { seccionPrincipal, seccionesDe } = require('./project.plantilla');

/**
 * Los espacios de un fragmento copiado, que no se pierdan.
 *
 * Una plantilla convertida desde PDF escribe cada espacio en su propia corrida,
 * «<w:t> </w:t>», sin `xml:space="preserve"`. Llevada a nuestro Word, Word se
 * comía esos espacios y la portada salía «FACULTADDECIENCIASDELASALUD».
 */
const conEspaciosVisibles = (xml) =>
  String(xml).replace(/<w:t(?=[\s>])(?![^>]*xml:space)([^>]*)>/g, '<w:t xml:space="preserve"$1>');

/** Lo más pequeño a lo que se achica el título del encabezado: 5,5 puntos. */
const TAMANO_MINIMO_CABECERA = 11;

/**
 * El título del encabezado, más pequeño si el del tesista es más largo.
 *
 * El encabezado de la UPN lo pone en un cuadro de texto de altura fija. Un título
 * más largo que el de ejemplo necesitaba otra línea, se cortaba y tocaba el texto
 * de la página. Se achica la letra en la misma proporción para que quepa en las
 * mismas líneas.
 */
function ajustarTituloDeCabecera(xml, largoDeEjemplo, tema) {
  const largo = String(tema ?? '').trim().length;
  if (!largoDeEjemplo || !largo || largo <= largoDeEjemplo) return xml;
  const factor = largoDeEjemplo / largo;
  return xml.replace(PARRAFO_INTERIOR_RE, (parrafo) =>
    parrafo.includes('{{TITULO}}')
      ? parrafo.replace(/<w:(sz|szCs) w:val="(\d+)"\/>/g, (entero, etiqueta, valor) =>
          `<w:${etiqueta} w:val="${Math.max(TAMANO_MINIMO_CABECERA, Math.round(Number(valor) * factor))}"/>`,
        )
      : parrafo,
  );
}

/** El aire entre el logo del encabezado y la primera línea del texto: 0,6 cm. */
const AIRE_BAJO_LA_CABECERA = 340;

/**
 * Hasta dónde baja lo que flota en el encabezado, en twips desde el borde de la hoja.
 *
 * Un logo o un cuadro de texto flotante no empuja el texto como un párrafo: si
 * baja más que el margen superior, se monta encima. Solo se miden los que se
 * colocan respecto de la hoja o del párrafo del encabezado; los demás no se
 * pueden medir sin maquetar.
 */
function fondoDeLaCabecera(xml, distancia) {
  let fondo = 0;
  for (const m of String(xml).matchAll(/<wp:anchor\b[\s\S]*?<\/wp:anchor>/g)) {
    const vertical = m[0].match(/<wp:positionV relativeFrom="(\w+)">\s*<wp:posOffset>(-?\d+)<\/wp:posOffset>/);
    const alto = m[0].match(/<wp:extent\b[^>]*\bcy="(\d+)"/);
    if (!vertical || !alto) continue;
    const desde = vertical[1] === 'page' ? 0 : ['paragraph', 'line'].includes(vertical[1]) ? distancia : null;
    if (desde === null) continue;
    fondo = Math.max(fondo, desde + (Number(vertical[2]) + Number(alto[1])) / 635);
  }
  return Math.round(fondo);
}

/** El margen superior de la sección, lo bastante alto para que el texto no toque el encabezado. */
function conAireBajoLaCabecera(seccion, encabezados) {
  return seccion.replace(/<w:pgMar\b[^>]*\/>/, (margen) => {
    const valor = (nombre, porDefecto) => Number((margen.match(new RegExp(`w:${nombre}="(-?\\d+)"`)) || [0, porDefecto])[1]);
    const fondo = Math.max(0, ...Object.values(encabezados ?? {}).map((p) => fondoDeLaCabecera(p.xml, valor('header', 720))));
    const necesario = fondo + AIRE_BAJO_LA_CABECERA;
    return fondo > 0 && Math.abs(valor('top', 1440)) < necesario
      ? margen.replace(/w:top="-?\d+"/, `w:top="${necesario}"`)
      : margen;
  });
}

/** «Autores:» en singular si el proyecto tiene un solo autor. */
const conEtiquetaDeAutor = (xml, nombre) =>
  /;|\s(?:y|&)\s/.test(String(nombre ?? ''))
    ? xml
    : xml.replace(/(<w:t\b[^>]*>\s*)(Autor|AUTOR)(?:es|ES)(\s*:)/g, '$1$2$3');

/** Lo que ocupa, más o menos, una línea de portada: 22 puntos. */
const TWIPS_POR_LINEA = 440;

/**
 * Cuánto más alta sale la portada con los datos del tesista, en twips.
 *
 * Una estimación por caracteres: cada tanto de texto de más es una línea de
 * más, y se suma otra de margen. Mejor compactar un poco de más que dejar el año
 * solo en una segunda hoja.
 */
function alturaDeMas(partes, datos) {
  const ejemplo = partes?.largosDeEjemplo;
  if (!ejemplo) return 0;
  const lineas = (dato, antes, porLinea) => {
    const mas = antes ? String(dato ?? '').trim().length - antes : 0;
    return mas > 0 ? Math.ceil(mas / porLinea) : 0;
  };
  const deMas =
    lineas(datos?.tema, ejemplo.titulo, 45) +
    lineas(datos?.nombre, ejemplo.autor, 40) +
    lineas(datos?.asesor, ejemplo.asesor, 40) +
    lineas(datos?.carrera, ejemplo.carrera, 45);
  return deMas > 0 ? (deMas + 1) * TWIPS_POR_LINEA : 0;
}

const esHueco = (parrafo) =>
  !/<w:t\b[^>]*>[^<]*\S/.test(parrafo) && !/<w:(?:drawing|pict|object|sectPr)\b/.test(parrafo);

/** La altura de un párrafo vacío: su línea, con la letra que tenga, y sus espacios antes y después. */
function alturaDeHueco(parrafo) {
  const espaciado = (parrafo.match(/<w:spacing\b[^>]*\/>/) || [''])[0];
  const atributo = (nombre) => Number((espaciado.match(new RegExp(`w:${nombre}="(\\d+)"`)) || [0, 0])[1]);
  const regla = (espaciado.match(/w:lineRule="(\w+)"/) || [0, 'auto'])[1];
  const tamano = Number((parrafo.match(/<w:sz w:val="(\d+)"/) || [0, 24])[1]);

  const sencilla = tamano * 12; // medio punto × 1,2 de interlineado × 20 twips
  const linea = !atributo('line') ? sencilla : regla === 'auto' ? (sencilla * atributo('line')) / 240 : atributo('line');
  return linea + atributo('before') + atributo('after');
}

/** El espaciado de un párrafo, cambiado o puesto en su sitio dentro de pPr. */
function conEspaciado(parrafo, espaciado) {
  const sinEspaciado = parrafo.replace(/<w:spacing\b[^>]*\/>/, '').replace('<w:pPr/>', '<w:pPr></w:pPr>');
  if (sinEspaciado.includes('<w:pPr>')) {
    return sinEspaciado.replace(
      /<w:pPr>([\s\S]*?)(<w:ind\b|<w:contextualSpacing\b|<w:mirrorIndents\b|<w:suppressOverlap\b|<w:jc\b|<w:textDirection\b|<w:textAlignment\b|<w:textboxTightWrap\b|<w:outlineLvl\b|<w:divId\b|<w:cnfStyle\b|<w:rPr\b|<w:sectPr\b|<w:pPrChange\b|<\/w:pPr>)/,
      (entero, antes, siguiente) => `<w:pPr>${antes}${espaciado}${siguiente}`,
    );
  }
  return sinEspaciado.replace(/^<w:p\b[^>]*>/, (apertura) => `${apertura}<w:pPr>${espaciado}</w:pPr>`);
}

/**
 * Los párrafos vacíos que separan los bloques de la portada, más bajos.
 *
 * Solo cuando los datos del tesista son más largos que los de ejemplo: sin
 * esto, el año de la portada de la UPN pasaba solo a una segunda hoja. Todos
 * los huecos se achican en la misma proporción, lo justo para ganar `necesario`
 * twips, y la portada conserva su reparto.
 */
function compactarHuecos(xml, necesario) {
  const alturas = [];
  for (const m of xml.matchAll(PARRAFO_INTERIOR_RE)) if (esHueco(m[0])) alturas.push(alturaDeHueco(m[0]));
  const total = alturas.reduce((suma, altura) => suma + altura, 0);
  if (!total || necesario <= 0) return xml;

  const queda = Math.max(0, 1 - necesario / total);
  let i = 0;
  return xml.replace(PARRAFO_INTERIOR_RE, (parrafo) => {
    if (!esHueco(parrafo)) return parrafo;
    const altura = Math.max(20, Math.round(alturas[i++] * queda));
    return conEspaciado(parrafo, `<w:spacing w:before="0" w:after="0" w:line="${altura}" w:lineRule="exact"/>`);
  });
}

/**
 * El salto de página tras la portada, hecho salto de sección.
 *
 * Así la portada es una sección sin encabezado ni pie, como en la plantilla, y
 * lo sigue siendo aunque ocupe dos hojas. Con «primera página distinta» solo la
 * primera salía limpia. La sección nueva copia el tamaño y los márgenes de la
 * del documento.
 */
function conSeccionPropia(despues, documento) {
  const siguiente = despues.match(/^<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*<\/w:p>/);
  if (!siguiente || !siguiente[0].includes('<w:pageBreakBefore')) return despues;

  const principal = documento.slice(documento.lastIndexOf('<w:sectPr'));
  const pagina = ['pgSz', 'pgMar', 'cols', 'docGrid']
    .map((etiqueta) => (principal.match(new RegExp(`<w:${etiqueta}\\b[^>]*/>`)) || [''])[0])
    .join('');
  return `<w:p><w:pPr><w:sectPr>${pagina}</w:sectPr></w:pPr></w:p>${despues.slice(siguiente[0].length)}`;
}

/** Dónde va la portada de la plantilla dentro del Word que arma el servidor. */
const MARCA_PORTADA = '⟦PORTADA⟧';

/**
 * Una marca de la portada: {{AUTOR}}, o con respaldo {{CARRERA|Psicología}}.
 *
 * El respaldo lo pone la detección automática con lo que traía la plantilla,
 * para los datos que pueden no estar en el proyecto: sin carrera guardada, la
 * portada dice la de la plantilla y no una línea vacía.
 */
const MARCA_RE = /\{\{\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)\s*(?:\|([^{}]*))?\}\}/g;

/** Lo que va donde falta un dato y no hay respaldo: se completa en Word. */
const PUNTOS = '……………………………';

/** Un párrafo que no contiene otros (los de los cuadros de texto van aparte). */
const PARRAFO_INTERIOR_RE = /<w:p\b[^>]*>(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g;

/** El normal y el de la primera página. El de páginas pares pide más ajustes. */
const TIPOS_DE_CABECERA = ['default', 'first'];

/** Una portada son unas decenas de párrafos; esto deja sitio de sobra. */
const MAXIMO_PORTADA = 400 * 1024;

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const TIPO_IMAGEN = `${REL}/image`;
const TIPO_ENLACE = `${REL}/hyperlink`;

const CONTENIDO_DE_MEDIO = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

/** Los atributos con los que un fragmento cita una relación: imágenes y enlaces. */
const ATRIBUTO_REL_RE = /\br:(embed|id|link|pict)="([^"]+)"/g;

const escaparXml = (texto) =>
  String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escaparAtributo = (texto) => escaparXml(texto).replace(/"/g, '&quot;');

function atributos(texto) {
  return Object.fromEntries(
    [...String(texto).matchAll(/([\w:.-]+)="([^"]*)"/g)].map(([, nombre, valor]) => [nombre, valor]),
  );
}

function leerRelaciones(xml) {
  const mapa = new Map();
  for (const m of String(xml ?? '').matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const a = atributos(m[1]);
    if (a.Id) mapa.set(a.Id, { type: a.Type, target: a.Target, externo: a.TargetMode === 'External' });
  }
  return mapa;
}

/** La ruta dentro del zip de un destino relativo a `word/`. */
function rutaEnWord(target) {
  if (target.startsWith('/')) return target.slice(1);
  return path.posix.normalize(path.posix.join('word', target));
}

/**
 * Un fragmento con las relaciones que usa, listo para llevárselo.
 *
 * Solo imágenes y enlaces externos. Cualquier otra cosa —un objeto incrustado,
 * un gráfico— devuelve null y el fragmento no se usa: llevarse la mitad dejaría
 * un Word que Word no abre.
 */
function recoger(xml, relaciones, zip, medios) {
  const nuevos = {};
  const rels = [];

  for (const id of new Set([...xml.matchAll(ATRIBUTO_REL_RE)].map((m) => m[2]))) {
    const rel = relaciones.get(id);
    if (!rel) return null;

    if (rel.type === TIPO_ENLACE && rel.externo) {
      rels.push({ id, type: rel.type, target: rel.target, externo: true });
      continue;
    }
    if (rel.type !== TIPO_IMAGEN || rel.externo) return null;

    const ext = path.posix.extname(rel.target).slice(1).toLowerCase();
    const datos = zip.getEntry(rutaEnWord(rel.target))?.getData();
    if (!datos || !CONTENIDO_DE_MEDIO[ext]) return null;

    const nombre = `pl-${crypto.createHash('sha1').update(datos).digest('hex').slice(0, 16)}.${ext}`;
    nuevos[nombre] = datos.toString('base64');
    rels.push({ id, type: rel.type, target: `media/${nombre}` });
  }

  Object.assign(medios, nuevos);
  return { xml, rels };
}

/**
 * Los hijos directos del cuerpo: párrafos, tablas y controles de contenido.
 *
 * Contando profundidad y no con una expresión regular sin más, porque una
 * portada lleva párrafos dentro de tablas y de cuadros de texto, y un `</w:p>`
 * interior cerraría antes de tiempo.
 */
function hijosDelCuerpo(cuerpo) {
  const hijos = [];
  const etiqueta = /<(\/?)w:(p|tbl|sdt)\b[^>]*?(\/?)>/g;
  let profundidad = 0;
  let inicio = -1;

  for (const m of cuerpo.matchAll(etiqueta)) {
    const [texto, cierre, , autocierre] = m;
    if (autocierre) {
      if (profundidad === 0) hijos.push(texto);
      continue;
    }
    if (cierre) {
      profundidad -= 1;
      if (profundidad === 0 && inicio !== -1) {
        hijos.push(cuerpo.slice(inicio, m.index + texto.length));
        inicio = -1;
      }
      continue;
    }
    if (profundidad === 0) inicio = m.index;
    profundidad += 1;
  }
  return hijos;
}

const SALTO_DE_PAGINA_RE = /<w:br\b[^>]*w:type="page"[^>]*\/>/;
const SALTO_ANTES_RE = /<w:pageBreakBefore(?![^>]*w:val="(?:0|false|off)")[^>]*\/>/;
/**
 * Un título: donde empieza el cuerpo aunque la plantilla no ponga salto.
 *
 * «Title» no cuenta: es el estilo del título DE LA TESIS en muchas portadas, y
 * con él la portada de la UPN se cortaba antes del título, sin autor ni asesor.
 */
const TITULO_RE = /<w:pStyle w:val="(?:Heading\d|TOCHeading|TOC\d)"\/>/;

/**
 * Hasta cuántos elementos se acepta un documento sin salto como portada.
 *
 * Muchas facultades reparten SOLO la carátula, en un archivo de una hoja y sin
 * salto al final (así la de la UNFV). Una carátula son unas decenas de
 * párrafos; un documento más largo sin salto no se sabe dónde acaba.
 */
const MAXIMO_ELEMENTOS_SIN_SALTO = 60;

/**
 * La primera página: todo hasta el primer salto de página o de sección, o hasta
 * el primer título. Sin nada de eso, el documento entero si es corto; si no,
 * null.
 */
function recortarPortada(cuerpo) {
  const trozos = [];
  const hijos = hijosDelCuerpo(cuerpo);

  for (const hijo of hijos) {
    const esParrafo = /^<w:p[\s>/]/.test(hijo);

    if (esParrafo && trozos.length > 0 && (SALTO_ANTES_RE.test(hijo) || TITULO_RE.test(hijo))) {
      return trozos;
    }

    const salto = hijo.search(SALTO_DE_PAGINA_RE);
    if (salto !== -1) {
      if (esParrafo) {
        // Se corta en la corrida que lleva el salto: lo de antes es portada.
        const corrida = Math.max(hijo.lastIndexOf('<w:r>', salto), hijo.lastIndexOf('<w:r ', salto));
        trozos.push(`${hijo.slice(0, corrida > 0 ? corrida : salto)}</w:p>`);
      } else {
        trozos.push(hijo.replace(SALTO_DE_PAGINA_RE, ''));
      }
      return trozos;
    }

    if (/<w:sectPr\b/.test(hijo)) {
      trozos.push(hijo.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, ''));
      return trozos;
    }

    trozos.push(hijo);
  }

  return hijos.length > 0 && hijos.length <= MAXIMO_ELEMENTOS_SIN_SALTO ? trozos : null;
}

/** Los espacios de nombres de la raíz, para declararlos donde vaya la portada. */
function espaciosDe(documento) {
  const raiz = documento.match(/<w:document\b([^>]*)>/)?.[1] ?? '';
  return Object.fromEntries(
    Object.entries(atributos(raiz)).filter(([nombre]) => nombre.startsWith('xmlns:') || nombre === 'mc:Ignorable'),
  );
}

const vacias = () => ({
  numeracion: null,
  encabezados: {},
  pies: {},
  primeraPaginaDistinta: false,
  portada: null,
  /** Una portada sin marcas, pendiente de que `project.portada-auto` las ponga. Nunca se guarda así. */
  portadaCandidata: null,
  /** Qué datos se detectaron en la portada: titulo, autor, asesor, carrera, anio. */
  camposDePortada: [],
  portadaSinMarcas: false,
  /** La portada va en su propia sección, sin encabezado ni pie. */
  portadaSinCabecera: false,
  medios: {},
});

/** Las partes de la plantilla. Nunca lanza: lo que no se puede leer, no se copia. */
function extraer(buffer) {
  const partes = vacias();

  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    return partes;
  }
  const texto = (nombre) => zip.getEntry(nombre)?.getData().toString('utf8') ?? null;

  const documento = texto('word/document.xml');
  if (!documento) return partes;
  const relaciones = leerRelaciones(texto('word/_rels/document.xml.rels'));

  const numeracion = texto('word/numbering.xml');
  if (numeracion?.includes('<w:abstractNum')) partes.numeracion = numeracion;

  // La sección que gobierna el cuerpo, con los encabezados y pies que hereda:
  // en una plantilla convertida desde PDF, la última no suele tener ninguno.
  const finDelCuerpo = documento.lastIndexOf('</w:body>');
  const principal = seccionPrincipal(documento);
  const seccion = principal?.xml ?? '';

  partes.primeraPaginaDistinta = /<w:titlePg(?![^>]*w:val="(?:0|false|off)")[^>]*\/>/.test(seccion);

  for (const referencia of principal?.referencias ?? []) {
    const m = referencia.match(/<w:(header|footer)Reference\b([^>]*?)\/>/);
    if (!m) continue;
    const a = atributos(m[2]);
    const tipo = a['w:type'] ?? 'default';
    if (!TIPOS_DE_CABECERA.includes(tipo)) continue;

    const rel = relaciones.get(a['r:id']);
    if (!rel || rel.externo) continue;

    const ruta = rutaEnWord(rel.target);
    const xml = texto(ruta);
    if (!xml) continue;

    const relsDeLaParte = leerRelaciones(
      texto(path.posix.join(path.posix.dirname(ruta), '_rels', `${path.posix.basename(ruta)}.rels`)),
    );
    const recogido = recoger(xml, relsDeLaParte, zip, partes.medios);
    if (recogido) (m[1] === 'header' ? partes.encabezados : partes.pies)[tipo] = recogido;
  }

  // Con varias secciones, la primera es la de la portada; si no define
  // encabezado ni pie, la portada va sin ellos, como en la de la UPN.
  const secciones = seccionesDe(documento);
  partes.portadaSinCabecera =
    secciones.length > 1 && !/<w:(header|footer)Reference\b/.test(secciones[0].xml);

  const apertura = documento.match(/<w:body\b[^>]*>/);
  if (apertura && finDelCuerpo !== -1) {
    const cuerpo = documento.slice(apertura.index + apertura[0].length, finDelCuerpo);
    const trozos = recortarPortada(cuerpo);

    if (trozos) {
      const xml = trozos.join('');
      const plano = xml.replace(/<[^>]+>/g, '');

      if (plano.trim() !== '' && xml.length <= MAXIMO_PORTADA) {
        const recogido = recoger(xml, relaciones, zip, partes.medios);
        if (recogido) {
          const portada = { ...recogido, espacios: espaciosDe(documento) };
          // Con marcas escritas a mano, lista. Sin ellas, candidata: la
          // detección automática busca dónde van los datos, y si no los
          // encuentra no se guarda (ver `project.portada-auto`).
          if (new RegExp(MARCA_RE.source).test(plano)) partes.portada = portada;
          else partes.portadaCandidata = portada;
        }
      }
    }
  }

  return partes;
}

/** Quita las imágenes que ya no usa ninguna parte: las de una portada descartada. */
function podarMedios(partes) {
  const usadas = new Set();
  const anotar = (fragmento) => {
    for (const rel of fragmento?.rels ?? []) {
      if (!rel.externo) usadas.add(path.posix.basename(rel.target));
    }
  };
  Object.values(partes.encabezados ?? {}).forEach(anotar);
  Object.values(partes.pies ?? {}).forEach(anotar);
  anotar(partes.portada);
  anotar(partes.portadaCandidata);

  for (const nombre of Object.keys(partes.medios ?? {})) {
    if (!usadas.has(nombre)) delete partes.medios[nombre];
  }
  return partes;
}

/** Qué se copió, para decírselo al tesista. */
function resumen(partes) {
  return {
    numeracion: Boolean(partes?.numeracion),
    encabezado: Object.keys(partes?.encabezados ?? {}).length > 0,
    pie: Object.keys(partes?.pies ?? {}).length > 0,
    portada: Boolean(partes?.portada),
    camposDePortada: partes?.portada ? [...(partes.camposDePortada ?? [])] : [],
    portadaSinMarcas: Boolean(partes?.portadaSinMarcas),
  };
}

const CAMPO_DE_MARCA = {
  TITULO: 'tema',
  TEMA: 'tema',
  AUTOR: 'nombre',
  AUTORA: 'nombre',
  TESISTA: 'nombre',
  NOMBRE: 'nombre',
  ASESOR: 'asesor',
  ASESORA: 'asesor',
  CARRERA: 'carrera',
  ESCUELA: 'carrera',
  UNIVERSIDAD: 'universidad',
};

/**
 * Lo que va en una marca, ya escapado para el XML.
 *
 * Sin el dato: el respaldo que dejó la detección (que ya viene escapado, porque
 * se escribió dentro del documento), y si no hay, una línea de puntos para
 * completarla en Word. Nunca la marca a la vista: el tesista no tiene por qué
 * saber que existe.
 */
/**
 * «BENICIO GONZALO ACOSTA ENRIQUEZ» → «Acosta, B.», como en los pies de página.
 *
 * Con tres palabras o más se toma la penúltima como primer apellido, que es lo
 * que pasa con dos nombres y dos apellidos o con uno y dos. Con dos, la segunda.
 */
function autorCorto(nombre) {
  const palabras = String(nombre ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toLocaleUpperCase('es') + p.slice(1).toLocaleLowerCase('es'));
  if (palabras.length === 0) return '';
  if (palabras.length === 1) return palabras[0];
  const apellido = palabras.length >= 3 ? palabras[palabras.length - 2] : palabras[1];
  return `${apellido}, ${palabras[0].charAt(0)}.`;
}

function valorDeMarca(nombre, porDefecto, datos) {
  const clave = nombre.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  if (clave === 'ANO' || clave === 'ANIO') return String(new Date().getFullYear());
  if (clave === 'AUTORCORTO' && datos?.nombre) return escaparXml(autorCorto(datos.nombre));
  if (clave === 'GRADO') {
    const carrera = String(datos?.carrera ?? '').trim();
    if (!carrera) return porDefecto?.trim() ? porDefecto : PUNTOS;
    // Un posgrado se dice entero: «Licenciada en Maestría en Docencia» no lo
    // escribe nadie. Un pregrado conserva el grado de la plantilla.
    if (/^(?:maestr|m[aá]ster|doctor|segunda especialidad|especialidad)/i.test(carrera)) return escaparXml(carrera);
    const grado = String(porDefecto ?? '').replace(/\s+(?:en|de)\s+.+$/i, '').trim();
    return grado ? `${grado} en ${escaparXml(carrera)}` : escaparXml(carrera);
  }

  const campo = CAMPO_DE_MARCA[clave];
  const valor = campo ? datos?.[campo] : null;
  if (valor) return escaparXml(String(valor));
  return porDefecto?.trim() ? porDefecto : PUNTOS;
}

/**
 * Rellena las marcas de la portada con los datos del proyecto.
 *
 * Word parte el texto en corridas donde le parece —«{{TIT» en una, «ULO}}» en
 * otra, por la corrección ortográfica—, así que se mira el texto del párrafo
 * entero. Si hay que cambiar algo, el texto va a la primera corrida y las demás
 * se vacían: se pierde un cambio de formato a mitad de línea, que en una línea
 * de portada no suele haber. Solo párrafos sin otros párrafos dentro: los de
 * los cuadros de texto se tratan uno a uno.
 */
function rellenarMarcas(xml, datos) {
  const TEXTO_RE = /(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g;
  const cambiar = (texto) =>
    texto.replace(new RegExp(MARCA_RE.source, 'g'), (marca, nombre, porDefecto) =>
      valorDeMarca(nombre, porDefecto, datos),
    );
  const hayMarca = (texto) => new RegExp(MARCA_RE.source).test(texto);

  return xml.replace(PARRAFO_INTERIOR_RE, (parrafo) => {
    // Primero dentro de cada corrida: así «Asesor:» conserva su negrita y el
    // nombre la suya. Es el caso normal, porque la detección automática
    // escribe cada marca en una sola corrida.
    const porCorrida = parrafo.replace(TEXTO_RE, (entero, apertura, contenido, cierre) =>
      hayMarca(contenido) ? `<w:t xml:space="preserve">${cambiar(contenido)}${cierre}` : entero,
    );

    const textos = [...porCorrida.matchAll(TEXTO_RE)];
    const junto = textos.map((t) => t[2]).join('');
    if (!hayMarca(junto)) return porCorrida;

    // Una marca escrita a mano que Word partió en dos corridas: el texto va a
    // la primera y las demás se vacían.
    const relleno = cambiar(junto);
    let indice = 0;
    return porCorrida.replace(TEXTO_RE, () =>
      indice++ === 0 ? `<w:t xml:space="preserve">${relleno}</w:t>` : '<w:t></w:t>',
    );
  });
}

/**
 * Quita la numeración a los párrafos de Título 1 con ese texto exacto.
 *
 * El `numPr` va en su sitio dentro de `pPr`: detrás de pStyle, keepNext,
 * keepLines, pageBreakBefore y widowControl. El esquema fija el orden, y en otro
 * lugar Word da el documento por dañado.
 */
function sinNumeracion(documento, titulo) {
  const texto = `>${escaparXml(titulo)}</w:t>`;
  const NUM_CERO = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>';

  return documento.replace(/<w:p\b[^>]*>(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g, (parrafo) => {
    if (!parrafo.includes(texto) || !/<w:pStyle w:val="Heading1"\/>/.test(parrafo)) return parrafo;
    if (parrafo.includes('<w:numPr>')) return parrafo;

    return parrafo.replace(/<w:pPr>([\s\S]*?)<\/w:pPr>/, (pPr, dentro) => {
      const antes = /^(?:<w:(?:pStyle|keepNext|keepLines|pageBreakBefore|framePr|widowControl)\b[^>]*\/>)*/.exec(dentro)[0];
      return `<w:pPr>${antes}${NUM_CERO}${dentro.slice(antes.length)}</w:pPr>`;
    });
  });
}

/** Declara en la raíz los espacios de nombres que trae la portada y faltan. */
function conEspacios(documento, espacios = {}) {
  return documento.replace(/<w:document\b[^>]*>/, (apertura) => {
    let nueva = apertura;
    for (const [nombre, valor] of Object.entries(espacios)) {
      if (nombre === 'mc:Ignorable') continue;
      if (!new RegExp(`\\s${nombre}=`).test(nueva)) {
        nueva = nueva.replace(/>$/, ` ${nombre}="${escaparAtributo(valor)}">`);
      }
    }

    // Los prefijos que Word puede ignorar: si la portada usa uno que aquí no
    // estaba en la lista, Word se negaría a abrir el documento.
    const suyos = String(espacios['mc:Ignorable'] ?? '').split(/\s+/).filter(Boolean);
    if (suyos.length > 0) {
      const actual = nueva.match(/\smc:Ignorable="([^"]*)"/);
      const juntos = [...new Set([...(actual?.[1] ?? '').split(/\s+/).filter(Boolean), ...suyos])]
        // Solo los que están declarados; uno sin declarar también rompe el archivo.
        .filter((prefijo) => new RegExp(`\\sxmlns:${prefijo}=`).test(nueva))
        .join(' ');
      nueva = actual
        ? nueva.replace(actual[0], ` mc:Ignorable="${juntos}"`)
        : nueva.replace(/>$/, ` mc:Ignorable="${juntos}">`);
    }
    return nueva;
  });
}

/**
 * Pone las partes de la plantilla en el Word ya armado.
 *
 * `datos` son los del proyecto, para las marcas de la portada.
 */
function aplicar(buffer, partes, datos = {}) {
  const r = resumen(partes);
  if (!r.numeracion && !r.encabezado && !r.pie && !r.portada) return buffer;

  const zip = new AdmZip(buffer);
  const texto = (nombre) => zip.getEntry(nombre)?.getData().toString('utf8') ?? '';
  const escribir = (nombre, contenido) => {
    const datosDelArchivo = Buffer.isBuffer(contenido) ? contenido : Buffer.from(contenido, 'utf8');
    if (zip.getEntry(nombre)) zip.updateFile(nombre, datosDelArchivo);
    else zip.addFile(nombre, datosDelArchivo);
  };

  let tipos = texto('[Content_Types].xml');
  let rels = texto('word/_rels/document.xml.rels');
  let documento = texto('word/document.xml');

  let contador = 0;
  const idNuevo = () => {
    let id;
    do {
      contador += 1;
      id = `rIdPl${contador}`;
    } while (rels.includes(`Id="${id}"`));
    return id;
  };
  const relXml = ({ id, type, target, externo }) =>
    `<Relationship Id="${id}" Type="${type}" Target="${escaparAtributo(target)}"` +
    `${externo ? ' TargetMode="External"' : ''}/>`;
  const anadirRel = (rel) => {
    rels = rels.replace('</Relationships>', `${relXml(rel)}</Relationships>`);
  };
  const anadirOverride = (parte, contentType) => {
    if (!tipos.includes(`PartName="${parte}"`)) {
      tipos = tipos.replace('</Types>', `<Override PartName="${parte}" ContentType="${contentType}"/></Types>`);
    }
  };

  const copiados = new Set();
  const copiarMedio = (target) => {
    const nombre = path.posix.basename(target);
    if (copiados.has(nombre)) return;
    const base64 = partes.medios?.[nombre];
    if (!base64) throw new Error(`La plantilla guardada no tiene la imagen ${nombre}`);

    escribir(`word/media/${nombre}`, Buffer.from(base64, 'base64'));
    const ext = path.posix.extname(nombre).slice(1);
    if (!new RegExp(`Extension="${ext}"`, 'i').test(tipos)) {
      tipos = tipos.replace('</Types>', `<Default Extension="${ext}" ContentType="${CONTENIDO_DE_MEDIO[ext]}"/></Types>`);
    }
    copiados.add(nombre);
  };

  // ── La numeración ────────────────────────────────────────────────────────
  // La nuestra no la usa nada —las viñetas del texto son un carácter—, así que
  // se sustituye entera por la suya y los títulos recuperan su «1.1».
  if (r.numeracion) {
    escribir('word/numbering.xml', partes.numeracion);
    anadirOverride(
      '/word/numbering.xml',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
    );
    if (!rels.includes('/relationships/numbering"')) {
      anadirRel({ id: idNuevo(), type: `${REL}/numbering`, target: 'numbering.xml' });
    }

    // Los títulos que no se numeran aunque su estilo sí: la lista de
    // referencias. numId 0 en el párrafo anula la numeración del estilo.
    for (const titulo of datos.sinNumero ?? []) {
      documento = sinNumeracion(documento, titulo);
    }
  }

  // ── Encabezado y pie ─────────────────────────────────────────────────────
  const referencias = [];
  let numero = 0;
  for (const [clase, grupo] of [
    ['header', partes.encabezados ?? {}],
    ['footer', partes.pies ?? {}],
  ]) {
    for (const tipo of TIPOS_DE_CABECERA) {
      const parte = grupo[tipo];
      if (!parte) continue;

      numero += 1;
      const nombre = `${clase}Pl${numero}.xml`;
      // Con sus marcas rellenas: el título y los autores de la tesis de
      // ejemplo se cambiaron por {{TITULO}} y {{AUTORCORTO}} al subirla.
      escribir(
        `word/${nombre}`,
        rellenarMarcas(ajustarTituloDeCabecera(conEspaciosVisibles(parte.xml), parte.largoDelTitulo, datos.tema), datos),
      );
      if (parte.rels.length > 0) {
        for (const rel of parte.rels) if (!rel.externo) copiarMedio(rel.target);
        escribir(
          `word/_rels/${nombre}.rels`,
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            `${parte.rels.map(relXml).join('')}</Relationships>`,
        );
      }
      anadirOverride(`/word/${nombre}`, `application/vnd.openxmlformats-officedocument.wordprocessingml.${clase}+xml`);

      const id = idNuevo();
      anadirRel({ id, type: `${REL}/${clase}`, target: nombre });
      referencias.push(`<w:${clase}Reference w:type="${tipo}" r:id="${id}"/>`);
    }
  }

  if (referencias.length > 0) {
    const inicio = documento.lastIndexOf('<w:sectPr');
    const final = documento.indexOf('</w:sectPr>', inicio) + '</w:sectPr>'.length;
    let seccion = documento.slice(inicio, final);

    // Solo se quita lo nuestro que la plantilla sustituye: si trae encabezado
    // pero no pie, se queda nuestro número de página.
    if (r.encabezado) seccion = seccion.replace(/<w:headerReference\b[^>]*\/>/g, '');
    if (r.pie) seccion = seccion.replace(/<w:footerReference\b[^>]*\/>/g, '');
    seccion = seccion.replace(/^<w:sectPr\b[^>]*>/, (apertura) => apertura + referencias.join(''));

    const hayDePrimera = partes.encabezados?.first || partes.pies?.first;
    if (partes.primeraPaginaDistinta && hayDePrimera && !/<w:titlePg\b/.test(seccion)) {
      // En su sitio: el esquema fija el orden, y Word no perdona un titlePg
      // detrás de docGrid.
      seccion = /<w:(textDirection|bidi|rtlGutter|docGrid)\b/.test(seccion)
        ? seccion.replace(/<w:(textDirection|bidi|rtlGutter|docGrid)\b/, '<w:titlePg/><w:$1')
        : seccion.replace('</w:sectPr>', '<w:titlePg/></w:sectPr>');
    }

    documento = documento.slice(0, inicio) + seccion + documento.slice(final);
  }

  // ── La portada ───────────────────────────────────────────────────────────
  if (r.portada) {
    const marca = documento.indexOf(MARCA_PORTADA);
    if (marca !== -1) {
      const inicio = Math.max(documento.lastIndexOf('<w:p>', marca), documento.lastIndexOf('<w:p ', marca));
      const final = documento.indexOf('</w:p>', marca) + '</w:p>'.length;

      const nuevos = new Map();
      for (const rel of partes.portada.rels) {
        const id = idNuevo();
        nuevos.set(rel.id, id);
        if (!rel.externo) copiarMedio(rel.target);
        anadirRel({ ...rel, id });
      }

      const xml = rellenarMarcas(
        conEspaciosVisibles(
          partes.portada.xml.replace(ATRIBUTO_REL_RE, (atributo, clase, id) =>
            nuevos.has(id) ? `r:${clase}="${nuevos.get(id)}"` : atributo,
          ),
        ),
        datos,
      );

      const despues = partes.portadaSinCabecera
        ? conSeccionPropia(documento.slice(final), documento)
        : documento.slice(final);
      const portada = conEtiquetaDeAutor(compactarHuecos(xml, alturaDeMas(partes, datos)), datos.nombre);

      documento = conEspacios(documento.slice(0, inicio) + portada + despues, partes.portada.espacios);
    }
  }

  // ── El texto, debajo del logo ────────────────────────────────────────────
  // Después de la portada: su sección copió ya los márgenes de la plantilla y
  // no tiene encabezado que esquivar.
  if (r.encabezado) {
    const inicio = documento.lastIndexOf('<w:sectPr');
    documento = documento.slice(0, inicio) + conAireBajoLaCabecera(documento.slice(inicio), partes.encabezados);
  }

  escribir('[Content_Types].xml', tipos);
  escribir('word/_rels/document.xml.rels', rels);
  escribir('word/document.xml', documento);
  return zip.toBuffer();
}

module.exports = {
  extraer,
  aplicar,
  resumen,
  rellenarMarcas,
  autorCorto,
  podarMedios,
  MARCA_PORTADA,
  PARRAFO_INTERIOR_RE,
};
