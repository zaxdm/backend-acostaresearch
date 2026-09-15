'use strict';

/**
 * El índice, ya relleno al descargar el Word.
 *
 * POR QUÉ EXISTE
 * --------------
 * La librería `docx` deja el índice como un campo vacío que solo Word de
 * escritorio rellena, y solo si puede: un Word descargado se abre en «Vista
 * protegida», donde no se actualiza nada; si el tesista responde «No» al aviso
 * de actualizar campos, tampoco; y un visor que no es Word no lo rellena nunca.
 * El 15 de septiembre de 2026 un tesista abrió su tesis y no tenía índice.
 *
 * Aquí se escriben dentro del mismo campo las entradas —con su enlace al
 * título— y un número de página estimado. El campo sigue marcado para
 * actualizar: en cuanto Word puede, lo rehace con los números exactos.
 *
 * LOS NÚMEROS SON UNA ESTIMACIÓN
 * ------------------------------
 * La maquetación de verdad solo la conoce Word. Se calcula cuánto ocupa cada
 * párrafo por su número de caracteres, su letra y su interlineado, y cada
 * título de capítulo empieza hoja. Con la plantilla de la UPN acierta los
 * números que da Word; con otra letra o tablas largas puede fallar por una.
 */

const AdmZip = require('adm-zip');

/** Los títulos que entran en el índice (`TOC \o "1-3"`), con su nivel. */
const NIVEL_DE_TITULO = { Heading1: 1, Heading2: 2, Heading3: 3 };
/** Lo que ancha un carácter de media, en fracción del tamaño de la letra. */
const ANCHO_DE_CARACTER = 0.47;
/** La altura de una línea sencilla, en fracción del tamaño de la letra. */
const ALTO_DE_LINEA = 1.15;

const BLOQUE_RE = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
const TEXTO_RE = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;

const primero = (texto, re) => (String(texto).match(re) || [])[1];
const numeroDe = (texto, re, porDefecto) => {
  const valor = primero(texto, re);
  return valor === undefined ? porDefecto : Number(valor);
};
/** El texto tal como está en el XML, con sus entidades: sirve para copiarlo. */
const textoDe = (xml) => [...String(xml).matchAll(TEXTO_RE)].map((m) => m[1]).join('');
const largoVisible = (xml) => textoDe(xml).replace(/&(?:amp|lt|gt|quot|apos|#\d+);/g, '_').length;

/**
 * Lee de `styles.xml` la letra y el espaciado de cada estilo, siguiendo su
 * `basedOn` hasta los valores por defecto del documento.
 */
function lectorDeEstilos(estilos) {
  const bloques = new Map();
  for (const m of String(estilos).matchAll(/<w:style\b[^>]*>[\s\S]*?<\/w:style>/g)) {
    const id = primero(m[0], /w:styleId="([^"]+)"/);
    // Word se queda con la primera definición de cada estilo.
    if (id && !bloques.has(id)) bloques.set(id, m[0]);
  }
  const defectos = primero(estilos, /(<w:docDefaults>[\s\S]*?<\/w:docDefaults>)/) ?? '';

  const buscar = (id, re, profundidad = 0) => {
    const bloque = bloques.get(id);
    if (!bloque || profundidad > 8) return primero(defectos, re);
    const valor = primero(bloque, re);
    if (valor !== undefined) return valor;
    return buscar(primero(bloque, /<w:basedOn w:val="([^"]+)"/) ?? '', re, profundidad + 1);
  };

  const cache = new Map();
  return (id) => {
    if (!cache.has(id)) {
      const valor = (re) => buscar(id, re);
      cache.set(id, {
        // Sin tamaño en ningún sitio, Word usa 10 puntos.
        tamano: Number(valor(/<w:sz w:val="(\d+)"/) ?? 20),
        linea: valor(/<w:spacing\b[^>]*\bw:line="(\d+)"/),
        regla: valor(/<w:spacing\b[^>]*\bw:lineRule="(\w+)"/) ?? 'auto',
        antes: Number(valor(/<w:spacing\b[^>]*\bw:before="(\d+)"/) ?? 0),
        despues: Number(valor(/<w:spacing\b[^>]*\bw:after="(\d+)"/) ?? 0),
      });
    }
    return cache.get(id);
  };
}

/** Lo que mide una línea, en twips, con esa letra y ese interlineado. */
function altoDeLinea({ tamano, linea, regla }) {
  const sencilla = tamano * 10 * ALTO_DE_LINEA; // medio punto × 10 = twips
  if (!linea) return sencilla;
  if (regla === 'auto') return (sencilla * Number(linea)) / 240;
  if (regla === 'exact') return Number(linea);
  return Math.max(Number(linea), sencilla);
}

/** Lo que ocupa un párrafo: `alto` entero y `primera`, su primera línea con el espacio de antes. */
function altoDeParrafo(parrafo, metricas, ancho) {
  const pPr = primero(parrafo, /(<w:pPr>[\s\S]*?<\/w:pPr>)/) ?? '';
  const propio = pPr.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, '');
  const estilo = metricas(primero(pPr, /<w:pStyle w:val="([^"]+)"/) ?? 'Normal');
  const corridas = parrafo.replace(pPr, '');

  const propiedades = {
    tamano: numeroDe(corridas, /<w:sz w:val="(\d+)"/, estilo.tamano),
    linea: primero(propio, /<w:spacing\b[^>]*\bw:line="(\d+)"/) ?? estilo.linea,
    regla: primero(propio, /<w:spacing\b[^>]*\bw:lineRule="(\w+)"/) ?? estilo.regla,
  };
  const antes = numeroDe(propio, /<w:spacing\b[^>]*\bw:before="(\d+)"/, estilo.antes);
  const despues = numeroDe(propio, /<w:spacing\b[^>]*\bw:after="(\d+)"/, estilo.despues);
  const sangria =
    numeroDe(propio, /<w:ind\b[^>]*\bw:(?:left|start)="(\d+)"/, 0) + numeroDe(propio, /<w:ind\b[^>]*\bw:(?:right|end)="(\d+)"/, 0);

  const linea = altoDeLinea(propiedades);
  const porLinea = Math.max(10, Math.floor((ancho - sangria) / (propiedades.tamano * 10 * ANCHO_DE_CARACTER)));
  const lineas = Math.max(1, Math.ceil(largoVisible(parrafo) / porLinea));
  return { alto: lineas * linea + antes + despues, primera: linea + antes };
}

/** Lo que ocupa una tabla: cada fila, lo que su celda más alta. */
function altoDeTabla(tabla, metricas, ancho) {
  let alto = 0;
  for (const fila of tabla.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
    const celdas = [...fila[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) => c[0]);
    const anchoDeCelda = ancho / Math.max(1, celdas.length);
    const altos = celdas.map((celda) =>
      [...celda.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].reduce(
        (suma, p) => suma + altoDeParrafo(p[0], metricas, anchoDeCelda).alto,
        0,
      ),
    );
    alto += Math.max(0, ...altos) + 40;
  }
  return alto;
}

const nivelDe = (bloque) => NIVEL_DE_TITULO[primero(bloque, /^<w:p\b[^>]*>\s*<w:pPr>\s*<w:pStyle w:val="([^"]+)"/)] ?? 0;

function entrada(titulo, ancho, inicioDelCampo = '') {
  return (
    `<w:p><w:pPr><w:pStyle w:val="TOC${titulo.nivel}"/>` +
    `<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${Math.round(ancho)}"/></w:tabs>` +
    `<w:ind w:left="${(titulo.nivel - 1) * 240}"/></w:pPr>${inicioDelCampo}` +
    `<w:hyperlink w:anchor="${titulo.marca}" w:history="1">` +
    `<w:r><w:t xml:space="preserve">${titulo.texto}</w:t></w:r><w:r><w:tab/></w:r>` +
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve"> PAGEREF ${titulo.marca} \\h </w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    `<w:r><w:t xml:space="preserve">${titulo.numero}</w:t></w:r>` +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:hyperlink></w:p>'
  );
}

/**
 * El `document.xml` con el índice relleno y un marcador en cada título.
 *
 * Solo toca el campo vacío que deja la librería: si ya trae entradas, o si no
 * hay títulos, devuelve el documento tal cual.
 */
function rellenarIndice(documento, estilos) {
  const campo = /<w:sdt>(?:(?!<\/w:sdt>)[\s\S])*?<w:instrText[^>]*>\s*TOC\b[\s\S]*?<\/w:sdt>/.exec(documento);
  if (!campo) return documento;
  const contenido = /<w:sdtContent>([\s\S]*)<\/w:sdtContent>/.exec(campo[0]);
  const parrafos = contenido ? [...contenido[1].matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map((m) => m[0]) : [];
  if (parrafos.length !== 2 || !/fldCharType="separate"/.test(parrafos[0]) || !/fldCharType="end"/.test(parrafos[1])) {
    return documento;
  }
  const inicioDelCampo = parrafos[0]
    .replace(/^<w:p\b[^>]*>/, '')
    .replace(/<\/w:p>$/, '')
    .replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, '');

  const antes = documento.slice(0, campo.index);
  const cuerpo = documento.slice(campo.index + campo[0].length);
  const seccion = documento.slice(documento.lastIndexOf('<w:sectPr'));
  const ancho =
    numeroDe(seccion, /<w:pgSz\b[^>]*\bw:w="(\d+)"/, 11906) -
    numeroDe(seccion, /<w:pgMar\b[^>]*\bw:left="(\d+)"/, 1701) -
    numeroDe(seccion, /<w:pgMar\b[^>]*\bw:right="(\d+)"/, 1417);
  const alto =
    numeroDe(seccion, /<w:pgSz\b[^>]*\bw:h="(\d+)"/, 16838) -
    Math.abs(numeroDe(seccion, /<w:pgMar\b[^>]*\bw:top="(-?\d+)"/, 1701)) -
    Math.abs(numeroDe(seccion, /<w:pgMar\b[^>]*\bw:bottom="(-?\d+)"/, 1701));

  const bloques = [...cuerpo.matchAll(BLOQUE_RE)].map((m) => ({ xml: m[0], indice: m.index }));
  const cuantos = bloques.filter((b) => nivelDe(b.xml)).length;
  if (cuantos === 0) return documento;

  const metricas = lectorDeEstilos(estilos);
  const lineaDeCuerpo = altoDeLinea(metricas(/w:styleId="CuerpoTesis"/.test(estilos) ? 'CuerpoTesis' : 'Normal'));

  // La hoja del índice: una por cada salto antes de él (la portada, su sección).
  const saltosAntes = (antes.match(/<w:sectPr\b|<w:pageBreakBefore\/>|<w:br w:type="page"\/>/g) || []).length;
  let pagina = 1 + saltosAntes;
  const deIndice = metricas('TOC1');
  const tituloDelIndice = metricas('TOCHeading');
  let altura =
    altoDeLinea(tituloDelIndice) + tituloDelIndice.antes + tituloDelIndice.despues +
    cuantos * (altoDeLinea(deIndice) + deIndice.antes + deIndice.despues);
  while (altura > alto) {
    pagina += 1;
    altura -= alto;
  }

  let id = [...documento.matchAll(/w:id="(\d+)"/g)].reduce((maximo, m) => Math.max(maximo, Number(m[1])), 0);
  const titulos = [];
  for (const bloque of bloques) {
    const esTabla = bloque.xml.startsWith('<w:tbl');
    if (!esTabla && /<w:pageBreakBefore\/>/.test(bloque.xml) && altura > 0) {
      pagina += 1;
      altura = 0;
    }
    const medida = esTabla ? { alto: altoDeTabla(bloque.xml, metricas, ancho), primera: 0 } : altoDeParrafo(bloque.xml, metricas, ancho);
    const nivel = esTabla ? 0 : nivelDe(bloque.xml);

    // Un título no se queda solo al pie de la hoja: Word lo pasa a la siguiente
    // con las dos primeras líneas del párrafo que le sigue.
    const hastaDondeLlega = nivel ? medida.alto + 2 * lineaDeCuerpo : medida.primera;
    if (altura > 0 && altura + hastaDondeLlega > alto) {
      pagina += 1;
      altura = 0;
    }
    if (nivel) {
      id += 1;
      titulos.push({ ...bloque, nivel, pagina, id, marca: `_TocAR${String(titulos.length + 1).padStart(4, '0')}`, texto: textoDe(bloque.xml) });
    }

    altura += medida.alto;
    while (altura > alto) {
      pagina += 1;
      altura -= alto;
    }
    if (/<w:sectPr\b|<w:br w:type="page"\/>/.test(bloque.xml)) {
      pagina += 1;
      altura = 0;
    }
  }

  // Si la numeración empieza de nuevo en la sección del cuerpo, se descuentan
  // las hojas de delante.
  const inicio = numeroDe(seccion, /<w:pgNumType\b[^>]*\bw:start="(\d+)"/, null);
  const hojasDeLaPortada = (antes.match(/<w:sectPr\b/g) || []).length > 0 ? saltosAntes : 0;
  for (const titulo of titulos) {
    titulo.numero = inicio === null ? titulo.pagina : titulo.pagina - hojasDeLaPortada + inicio - 1;
  }

  // Los marcadores, de atrás adelante para no mover las posiciones.
  let nuevoCuerpo = cuerpo;
  for (const titulo of [...titulos].reverse()) {
    const conMarca = titulo.xml
      .replace(/^(<w:p\b[^>]*>(?:\s*<w:pPr>[\s\S]*?<\/w:pPr>)?)/, (apertura) => `${apertura}<w:bookmarkStart w:id="${titulo.id}" w:name="${titulo.marca}"/>`)
      .replace(/<\/w:p>$/, `<w:bookmarkEnd w:id="${titulo.id}"/></w:p>`);
    nuevoCuerpo = nuevoCuerpo.slice(0, titulo.indice) + conMarca + nuevoCuerpo.slice(titulo.indice + titulo.xml.length);
  }

  const entradas =
    titulos.map((titulo, i) => entrada(titulo, ancho, i === 0 ? inicioDelCampo : '')).join('') +
    parrafos[1];
  const inicioDelContenido = campo[0].indexOf(contenido[1]);
  const nuevoCampo =
    campo[0].slice(0, inicioDelContenido) + entradas + campo[0].slice(inicioDelContenido + contenido[1].length);

  return antes + nuevoCampo + nuevoCuerpo;
}

/** El Word con el índice relleno. Si algo no cuadra, lo devuelve como estaba. */
function conIndice(buffer) {
  const zip = new AdmZip(buffer);
  const documento = zip.getEntry('word/document.xml')?.getData().toString('utf8');
  if (!documento) return buffer;
  const estilos = zip.getEntry('word/styles.xml')?.getData().toString('utf8') ?? '';

  const nuevo = rellenarIndice(documento, estilos);
  if (nuevo === documento) return buffer;
  zip.updateFile('word/document.xml', Buffer.from(nuevo, 'utf8'));
  return zip.toBuffer();
}

module.exports = { conIndice, rellenarIndice };
