'use strict';

/**
 * Las fuentes del documento, en el gestor de citas del propio Word.
 *
 * POR QUÉ EXISTE
 * --------------
 * Quien recibe su Word y quiere ver sus fuentes va, por instinto, a
 * «Referencias → Administrar fuentes». Y lo encontraba vacío: las citas iban
 * como texto —o como campos de Zotero, que solo ve quien tiene Zotero abierto—
 * y el gestor de Word no sabía nada de ellas. Un comprador escribió «no aparece
 * citado» con una foto de esa lista en blanco.
 *
 * Ahora el Word lleva dentro la lista de lo que se citó, en el formato del
 * gestor de Word. Abre «Administrar fuentes» y están; pulsa «Insertar cita» y
 * las puede elegir. Sin instalar nada y sin abrir Zotero.
 *
 * QUÉ NO HACE
 * -----------
 * No toca las citas que ya van escritas: siguen siendo texto en su norma, o
 * campos de Zotero. Convertirlas en citas de Word haría que Word las
 * reescribiera con su propio estilo —su APA va por detrás y no tiene
 * Vancouver— al primer «actualizar». Por eso en el gestor las fuentes no llevan
 * la marca de «citada»: están para consultarlas y para las citas nuevas.
 *
 * CÓMO VA DENTRO DEL .DOCX
 * ------------------------
 * Como lo guarda Word: una pieza `customXml/itemN.xml` con `<b:Sources>`, su
 * `itemPropsN.xml` que dice que es bibliografía, y una relación desde el
 * documento. Va como texto en el XML, igual que los campos de Zotero: la
 * librería `docx` no sabe escribirlo.
 */

const crypto = require('crypto');
const AdmZip = require('adm-zip');

const { tipoCsl, personasCsl } = require('./project.csl');

const ESPACIO = 'http://schemas.openxmlformats.org/officeDocument/2006/bibliography';
const TIPO_RELACION = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml';
const TIPO_PROPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps';
const CONTENIDO_PROPS = 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml';

/** El identificador que Word usa para la bibliografía entre las piezas a medida. */
const ALMACEN = '{3A6B9E5C-7D41-4F2A-9B8E-1C5D2A7F6E40}';

const escapar = (texto) =>
  String(texto ?? '')
    // Un carácter de control dentro del XML hace que Word dé el archivo por dañado.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const campo = (nombre, valor) => {
  const texto = String(valor ?? '').trim();
  return texto ? `<b:${nombre}>${escapar(texto)}</b:${nombre}>` : '';
};

/**
 * El estilo con el que Word abre su lista, el más cercano a la norma del
 * proyecto. Solo decide cómo escribirá Word las citas NUEVAS: las que ya van en
 * el texto no cambian. Lo que Word no trae (Vancouver, AMA…) se queda en APA,
 * que es el que trae por defecto.
 */
function estiloDeWord(norma) {
  const id = String(norma ?? '').toLowerCase();
  if (id === 'ieee') return { archivo: '\\IEEE2006OfficeOnline.xsl', nombre: 'IEEE', version: '2006' };
  if (id.startsWith('chicago')) return { archivo: '\\Chicago.xsl', nombre: 'Chicago', version: '16' };
  if (id.includes('harvard')) {
    return { archivo: '\\HarvardAnglia2008OfficeOnline.xsl', nombre: 'Harvard - Anglia', version: '2008' };
  }
  if (id === 'modern-language-association') {
    return { archivo: '\\MLASeventhEditionOfficeOnline.xsl', nombre: 'MLA', version: '7' };
  }
  if (id.startsWith('iso690')) {
    return { archivo: '\\ISO690.xsl', nombre: 'ISO 690 - First Element and Date', version: '1987' };
  }
  return { archivo: '\\APASixthEditionOfficeOnline.xsl', nombre: 'APA', version: '6' };
}

/**
 * Nuestro tipo, en los que conoce Word. No tiene «tesis»: Word la guarda como
 * informe con su tipo de tesis y su institución.
 */
function tipoDeWord(itemType) {
  switch (tipoCsl(itemType)) {
    case 'book':
      return 'Book';
    case 'chapter':
    case 'entry-encyclopedia':
      return 'BookSection';
    case 'paper-conference':
      return 'ConferenceProceedings';
    case 'thesis':
    case 'report':
      return 'Report';
    case 'webpage':
      return 'InternetSite';
    case 'article-newspaper':
    case 'article-magazine':
      return 'ArticleInAPeriodical';
    case 'dataset':
    case 'software':
      return 'Misc';
    default:
      return 'JournalArticle';
  }
}

/** Las personas, como las quiere Word; una institución va como autor corporativo. */
function autoresDeWord(autores) {
  const personas = personasCsl(autores);
  if (personas.length === 0) return '';

  if (personas.length === 1 && personas[0].literal) {
    return `<b:Author><b:Author><b:Corporate>${escapar(personas[0].literal)}</b:Corporate></b:Author></b:Author>`;
  }

  const lista = personas
    .map((p) => `<b:Person>${campo('Last', p.family ?? p.literal)}${campo('First', p.given)}</b:Person>`)
    .join('');
  return `<b:Author><b:Author><b:NameList>${lista}</b:NameList></b:Author></b:Author>`;
}

/** Un GUID que no cambia entre dos descargas del mismo documento. */
function guidDe(ref) {
  const h = crypto.createHash('md5').update(String(ref)).digest('hex').toUpperCase();
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}}`;
}

/** Una fuente de la biblioteca como `<b:Source>`. El orden de los campos da igual a Word. */
function fuenteDeWord(fuente, orden) {
  const tipo = tipoDeWord(fuente.itemType);
  const esTesis = tipoCsl(fuente.itemType) === 'thesis';

  // Dónde va `source` depende del tipo: la revista, el libro, el congreso, el
  // sitio, o quien lo publica.
  let continente = '';
  if (tipo === 'JournalArticle') continente = campo('JournalName', fuente.source);
  else if (tipo === 'ArticleInAPeriodical') continente = campo('PeriodicalTitle', fuente.source);
  else if (tipo === 'BookSection') continente = campo('BookTitle', fuente.source);
  else if (tipo === 'ConferenceProceedings') continente = campo('ConferenceName', fuente.source);
  else if (tipo === 'InternetSite') continente = campo('InternetSiteTitle', fuente.source);
  else if (esTesis) continente = campo('ThesisType', 'Tesis') + campo('Institution', fuente.source);
  else continente = campo('Publisher', fuente.source);

  return (
    '<b:Source>' +
    campo('Tag', String(fuente.ref).replace(/[^A-Za-z0-9_-]/g, '')) +
    `<b:SourceType>${tipo}</b:SourceType>` +
    `<b:Guid>${guidDe(fuente.ref)}</b:Guid>` +
    campo('Title', fuente.title || '(sin título)') +
    campo('Year', fuente.year) +
    autoresDeWord(fuente.authors) +
    continente +
    campo('Volume', fuente.volume) +
    campo('Issue', fuente.issue) +
    campo('Pages', fuente.pages) +
    campo('DOI', fuente.doi) +
    campo('URL', fuente.url || (fuente.doi ? `https://doi.org/${fuente.doi}` : '')) +
    `<b:RefOrder>${orden}</b:RefOrder>` +
    '</b:Source>'
  );
}

/** La pieza entera: lo que Word lee al abrir «Administrar fuentes». */
function xmlDeFuentes(fuentes, norma) {
  const estilo = estiloDeWord(norma);
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>' +
    `<b:Sources xmlns:b="${ESPACIO}" xmlns="${ESPACIO}" SelectedStyle="${escapar(estilo.archivo)}" ` +
    `StyleName="${escapar(estilo.nombre)}" Version="${estilo.version}">` +
    fuentes.map((fuente, i) => fuenteDeWord(fuente, i + 1)).join('') +
    '</b:Sources>'
  );
}

/**
 * Mete la lista en el .docx ya empaquetado.
 *
 * Sin fuentes devuelve el mismo buffer. Si algo del paquete no está donde se
 * espera, también: la lista es un extra, y un Word sin ella sigue siendo el
 * documento de alguien; uno roto, no.
 */
function incrustar(buffer, fuentes, { norma = null } = {}) {
  // Una entrada por fuente, aunque se cite veinte veces.
  const unicas = [...new Map((fuentes ?? []).filter((f) => f?.ref).map((f) => [f.ref, f])).values()];
  if (unicas.length === 0) return buffer;

  const zip = new AdmZip(buffer);
  const relaciones = zip.getEntry('word/_rels/document.xml.rels');
  const tipos = zip.getEntry('[Content_Types].xml');
  if (!relaciones || !tipos) return buffer;

  let xmlRelaciones = relaciones.getData().toString('utf8');
  let xmlTipos = tipos.getData().toString('utf8');
  // Una plantilla que ya traía su bibliografía de Word: no se pisa ni se duplica.
  const yaTiene = zip
    .getEntries()
    .some((e) => /^customXml\/item\d+\.xml$/.test(e.entryName) && e.getData().toString('utf8').includes(ESPACIO));
  if (yaTiene || !xmlRelaciones.includes('</Relationships>') || !xmlTipos.includes('</Types>')) return buffer;

  // El primer número libre: la plantilla de la universidad puede traer piezas suyas.
  let n = 1;
  while (zip.getEntry(`customXml/item${n}.xml`) || zip.getEntry(`customXml/itemProps${n}.xml`)) n += 1;

  zip.addFile(`customXml/item${n}.xml`, Buffer.from(xmlDeFuentes(unicas, norma), 'utf8'));
  zip.addFile(
    `customXml/itemProps${n}.xml`,
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>' +
        `<ds:datastoreItem ds:itemID="${ALMACEN}" ` +
        'xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml">' +
        `<ds:schemaRefs><ds:schemaRef ds:uri="${ESPACIO}"/></ds:schemaRefs></ds:datastoreItem>`,
      'utf8',
    ),
  );
  zip.addFile(
    `customXml/_rels/item${n}.xml.rels`,
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${TIPO_PROPS}" Target="itemProps${n}.xml"/></Relationships>`,
      'utf8',
    ),
  );

  xmlRelaciones = xmlRelaciones.replace(
    '</Relationships>',
    `<Relationship Id="rIdFuentesDeWord${n}" Type="${TIPO_RELACION}" Target="../customXml/item${n}.xml"/></Relationships>`,
  );
  zip.updateFile('word/_rels/document.xml.rels', Buffer.from(xmlRelaciones, 'utf8'));

  if (!/Extension="xml"/i.test(xmlTipos)) {
    xmlTipos = xmlTipos.replace('</Types>', '<Default Extension="xml" ContentType="application/xml"/></Types>');
  }
  xmlTipos = xmlTipos.replace(
    '</Types>',
    `<Override PartName="/customXml/itemProps${n}.xml" ContentType="${CONTENIDO_PROPS}"/></Types>`,
  );
  zip.updateFile('[Content_Types].xml', Buffer.from(xmlTipos, 'utf8'));

  return zip.toBuffer();
}

module.exports = { incrustar, xmlDeFuentes, fuenteDeWord, tipoDeWord, estiloDeWord };
