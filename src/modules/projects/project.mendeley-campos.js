'use strict';

/**
 * Las citas de Mendeley Cite dentro del Word.
 *
 * PARA QUIÉN
 * ----------
 * Para quien conectó su Mendeley y no su Zotero. Si conectó los dos, mandan los
 * campos de Zotero (`project.zotero-campos`), que son los que ya estaban; las
 * citas de un documento no pueden ser de los dos complementos a la vez. Al que
 * no conectó ninguno, el Word le llega como siempre: texto normal.
 *
 * CÓMO SE ESCRIBEN
 * ----------------
 * Como las deja el complemento Mendeley Cite (visto en un Word real de un
 * cliente el 16 de octubre de 2026):
 *
 * - Cada cita es un control de contenido en línea cuya etiqueta es
 *   «MENDELEY_CITATION_v3_» seguida del JSON de la cita en base64. Dentro, las
 *   corridas de texto con su formato.
 * - La bibliografía es un control de contenido de bloque con la etiqueta
 *   «MENDELEY_BIBLIOGRAPHY», que envuelve sus párrafos.
 * - El complemento guarda además, en su parte `word/webextensions`, la lista de
 *   todas las citas («MENDELEY_CITATIONS») y la norma
 *   («MENDELEY_CITATIONS_STYLE»).
 *
 * Cada fuente lleva sus datos completos dentro de la cita (`itemData`), así que
 * el complemento puede rehacer la cita y la bibliografía aunque la fuente no
 * esté en la biblioteca de quien abre el documento. Si vino del Mendeley del
 * tesista, su `id` es el de SU documento de Mendeley.
 *
 * Se arma igual que los campos de Zotero: `project.docx` deja las mismas marcas
 * de texto alrededor de cada cita y de la bibliografía, y aquí, con el Word ya
 * empaquetado, se cambian por los controles directamente en el XML.
 */

const crypto = require('crypto');
const AdmZip = require('adm-zip');

const normas = require('./project.normas');

/** Las partes del .docx donde puede haber citas: el cuerpo y las notas al pie. */
const PARTES = ['word/document.xml', 'word/footnotes.xml'];

/** Las mismas marcas que pone `project.docx` (ver `project.zotero-campos`). */
const MARCAS = /⟦Z([BE])([A-Z0-9]+)⟧/g;

/** El complemento Mendeley Cite en la tienda de Office, tal como lo deja él. */
const COMPLEMENTO = {
  id: '{5DAA7CE7-2063-44F0-B81B-1A71C49F16A0}',
  referencia: 'wa104382081',
  version: '1.55.1.0',
};

const FORMATO_DE_FAMILIA = { 'autor-fecha': 'author-date', numerica: 'numeric', notas: 'note' };

const escaparXml = (texto) =>
  String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const escaparAtributo = (texto) => escaparXml(texto).replace(/"/g, '&quot;');

/** Un UUID que sale siempre igual para el mismo texto. */
function uuidDe(texto) {
  const h = crypto.createHash('sha1').update(texto).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * A qué documento de Mendeley apunta una fuente.
 *
 * Si vino de su Mendeley (`sourceRef` = «mendeley:<perfil>:<documento>»), al
 * suyo. Si no, un identificador de Acosta que es siempre el mismo para la misma
 * fuente: dos citas de la misma obra cuentan como una sola en la bibliografía.
 */
function idDeMendeley(fuente, { perfil = null } = {}) {
  const prefijo = perfil ? `mendeley:${perfil}:` : null;
  if (prefijo && fuente.sourceRef?.startsWith(prefijo)) return fuente.sourceRef.slice(prefijo.length);
  return uuidDe(`acostaresearch:${fuente.ref}`);
}

/**
 * Los datos de cada cita, como los guarda Mendeley Cite.
 *
 * `citas` es lo que devuelve `project.csl.renderizar`; `comoCsl` convierte la
 * ficha en los datos CSL de la fuente.
 */
function datosDeCitas(citas, porClave, { comoCsl, perfil = null }) {
  const porNumero = new Map();

  for (const [numero, cita] of citas) {
    const datos = {
      citationID: `MENDELEY_CITATION_${uuidDe(`${cita.id}:${numero}`)}`,
      properties: { noteIndex: cita.nota ?? 0 },
      isEdited: false,
      manualOverride: {
        isManuallyOverridden: false,
        citeprocText: escaparXml(cita.texto),
        manualOverrideText: '',
      },
      citationItems: cita.items.map((item) => {
        const fuente = porClave.get(item.id);
        const id = idDeMendeley(fuente, { perfil });
        return {
          id,
          itemData: { ...comoCsl(fuente), id },
          isTemporary: false,
          ...(item.locator ? { locator: item.locator, label: item.label } : {}),
          ...(item['suppress-author'] ? { 'suppress-author': true } : {}),
        };
      }),
    };
    const etiqueta = `MENDELEY_CITATION_v3_${Buffer.from(JSON.stringify(datos), 'utf8').toString('base64')}`;
    porNumero.set(String(numero), { datos, etiqueta });
  }

  return porNumero;
}

/** La norma, como la guarda el complemento. */
function estiloDe(norma) {
  const elegida = normas.normaDe(norma);
  return {
    id: `https://www.zotero.org/styles/${elegida.id}`,
    title: elegida.nombre,
    format: FORMATO_DE_FAMILIA[elegida.familia] ?? 'author-date',
    defaultLocale: null,
    isLocaleCodeValid: true,
  };
}

/** Un `w:id` distinto para cada control: Word los quiere únicos. */
const nuevoId = () => crypto.randomInt(-2147483647, 2147483647);

const inicioDeCita = (etiqueta) =>
  `<w:sdt><w:sdtPr><w:tag w:val="${etiqueta}"/><w:id w:val="${nuevoId()}"/></w:sdtPr><w:sdtContent>`;

const FIN_DE_CONTROL = '</w:sdtContent></w:sdt>';

const inicioDeBibliografia = () =>
  `<w:sdt><w:sdtPr><w:tag w:val="MENDELEY_BIBLIOGRAPHY"/><w:id w:val="${nuevoId()}"/></w:sdtPr><w:sdtContent>`;

/** Dónde empieza la corrida de texto que contiene la posición dada. */
const inicioDeCorrida = (xml, posicion) =>
  Math.max(xml.lastIndexOf('<w:r>', posicion), xml.lastIndexOf('<w:r ', posicion));

/** Dónde empieza el párrafo que contiene la posición dada. */
const inicioDeParrafo = (xml, posicion) =>
  Math.max(xml.lastIndexOf('<w:p>', posicion), xml.lastIndexOf('<w:p ', posicion));

/**
 * La bibliografía: un control de bloque desde el párrafo de su primera entrada
 * hasta el de la última. Sin las dos marcas se quitan las que haya y no se pone
 * control: mejor una lista sin control que un control roto.
 */
function envolverBibliografia(xml) {
  const desde = xml.indexOf('⟦ZBBIB⟧');
  const hasta = xml.indexOf('⟦ZEBIB⟧');

  const quitarCorrida = (texto, marca) => {
    const i = texto.indexOf(marca);
    if (i === -1) return texto;
    const a = inicioDeCorrida(texto, i);
    const b = texto.indexOf('</w:r>', i);
    if (a === -1 || b === -1) return texto.replace(marca, '');
    return texto.slice(0, a) + texto.slice(b + '</w:r>'.length);
  };

  if (desde === -1 || hasta === -1 || hasta < desde) {
    return quitarCorrida(quitarCorrida(xml, '⟦ZBBIB⟧'), '⟦ZEBIB⟧');
  }

  // Primero el final, para que el principio no le descoloque la posición.
  const cierre = xml.indexOf('</w:p>', hasta);
  const primero = inicioDeParrafo(xml, desde);
  if (cierre === -1 || primero === -1) {
    return quitarCorrida(quitarCorrida(xml, '⟦ZBBIB⟧'), '⟦ZEBIB⟧');
  }
  let resultado = xml.slice(0, cierre + '</w:p>'.length) + FIN_DE_CONTROL + xml.slice(cierre + '</w:p>'.length);
  resultado = resultado.slice(0, primero) + inicioDeBibliografia() + resultado.slice(primero);
  return quitarCorrida(quitarCorrida(resultado, '⟦ZBBIB⟧'), '⟦ZEBIB⟧');
}

/** La parte del complemento: la lista de citas y la norma. */
function parteDelComplemento(citas, estilo) {
  const lista = [...citas.values()].map(({ datos, etiqueta }) => {
    const { citationItems, ...resto } = datos;
    return { ...resto, citationTag: etiqueta, citationItems };
  });

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<we:webextension xmlns:we="http://schemas.microsoft.com/office/webextensions/webextension/2010/11" id="${COMPLEMENTO.id}">` +
    `<we:reference id="${COMPLEMENTO.referencia}" version="${COMPLEMENTO.version}" store="en-US" storeType="OMEX"/>` +
    '<we:alternateReferences/>' +
    '<we:properties>' +
    `<we:property name="MENDELEY_CITATIONS" value="${escaparAtributo(JSON.stringify(lista))}"/>` +
    `<we:property name="MENDELEY_CITATIONS_STYLE" value="${escaparAtributo(JSON.stringify(estilo))}"/>` +
    '</we:properties><we:bindings/>' +
    '<we:snapshot xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>' +
    '</we:webextension>'
  );
}

const PANELES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<wetp:taskpanes xmlns:wetp="http://schemas.microsoft.com/office/webextensions/taskpanes/2010/11">' +
  '<wetp:taskpane dockstate="right" visibility="0" width="350" row="2">' +
  '<wetp:webextensionref xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/>' +
  '</wetp:taskpane></wetp:taskpanes>';

const RELACIONES_DE_PANELES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2011/relationships/webextension" Target="webextension1.xml"/>' +
  '</Relationships>';

/** Registra la parte del complemento en el paquete, si no estaba ya. */
function registrarComplemento(zip, citas, estilo) {
  zip.addFile('word/webextensions/webextension1.xml', Buffer.from(parteDelComplemento(citas, estilo), 'utf8'));
  zip.addFile('word/webextensions/taskpanes.xml', Buffer.from(PANELES, 'utf8'));
  zip.addFile('word/webextensions/_rels/taskpanes.xml.rels', Buffer.from(RELACIONES_DE_PANELES, 'utf8'));

  const tipos = zip.getEntry('[Content_Types].xml');
  let ct = tipos.getData().toString('utf8');
  if (!ct.includes('/word/webextensions/taskpanes.xml')) {
    ct = ct.replace(
      '</Types>',
      '<Override PartName="/word/webextensions/taskpanes.xml" ContentType="application/vnd.ms-office.webextensiontaskpanes+xml"/>' +
        '<Override PartName="/word/webextensions/webextension1.xml" ContentType="application/vnd.ms-office.webextension+xml"/>' +
        '</Types>',
    );
    zip.updateFile('[Content_Types].xml', Buffer.from(ct, 'utf8'));
  }

  const raiz = zip.getEntry('_rels/.rels');
  let rels = raiz.getData().toString('utf8');
  if (!rels.includes('webextensiontaskpanes')) {
    rels = rels.replace(
      '</Relationships>',
      '<Relationship Id="rIdMendeleyCite" Type="http://schemas.microsoft.com/office/2011/relationships/webextensiontaskpanes" Target="word/webextensions/taskpanes.xml"/>' +
        '</Relationships>',
    );
    zip.updateFile('_rels/.rels', Buffer.from(rels, 'utf8'));
  }
}

/**
 * Cambia las marcas por los controles de Mendeley Cite y añade la parte del
 * complemento. `mendeley` es `{ citas, estilo }`: las citas de `datosDeCitas`
 * y la norma de `estiloDe`.
 */
function coser(buffer, mendeley) {
  if (!mendeley?.citas || mendeley.citas.size === 0) return buffer;

  const zip = new AdmZip(buffer);

  for (const parte of PARTES) {
    const entrada = zip.getEntry(parte);
    if (!entrada) continue;

    let xml = envolverBibliografia(entrada.getData().toString('utf8'));
    const marcas = [...xml.matchAll(MARCAS)];

    for (const marca of marcas.reverse()) {
      const desde = inicioDeCorrida(xml, marca.index);
      const cierre = xml.indexOf('</w:r>', marca.index);
      if (desde === -1 || cierre === -1) continue;

      const [, tipo, clave] = marca;
      const cita = mendeley.citas.get(clave);
      // Una marca sin cita se quita sin dejar control, como en Zotero.
      const trozo = cita ? (tipo === 'B' ? inicioDeCita(cita.etiqueta) : FIN_DE_CONTROL) : '';

      xml = xml.slice(0, desde) + trozo + xml.slice(cierre + '</w:r>'.length);
    }

    zip.updateFile(parte, Buffer.from(xml, 'utf8'));
  }

  registrarComplemento(zip, mendeley.citas, mendeley.estilo);
  return zip.toBuffer();
}

module.exports = { datosDeCitas, estiloDe, idDeMendeley, coser };
