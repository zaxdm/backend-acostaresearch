'use strict';

/**
 * Los campos de Zotero dentro del Word.
 *
 * PARA QUIÉN
 * ----------
 * Solo para quien conectó su Zotero. Al que no, el Word le llega igual de
 * terminado —citas y referencias ya escritas en su norma— y sin un solo campo:
 * texto normal. Al que sí, las mismas citas van envueltas en campos, y si abre
 * el documento con el complemento de Zotero puede seguir trabajando desde ahí:
 * cambiar de norma, añadir citas, que la bibliografía se rehaga sola.
 *
 * CÓMO SE ESCRIBEN
 * ----------------
 * Como los escribe el propio Zotero: un campo complejo con el código
 * « ADDIN ZOTERO_ITEM CSL_CITATION {…} » y, como resultado, las corridas de
 * texto con su formato. Se comprobó a mano el 12 de septiembre de 2026 en Word
 * con el complemento de Zotero: reconoce los campos, respeta la norma y el
 * idioma de las preferencias, y regenera la bibliografía sin avisos.
 *
 * La librería `docx` solo sabe escribir campos simples, y un campo simple no
 * puede llevar un número volado ni una cursiva en su resultado. Por eso el Word
 * se arma con unas marcas de texto alrededor de cada cita y, ya empaquetado, se
 * cambian por el principio y el final del campo directamente en el XML.
 */

const crypto = require('crypto');
const AdmZip = require('adm-zip');

const normas = require('./project.normas');

/** Las partes del .docx donde puede haber citas: el cuerpo y las notas al pie. */
const PARTES = ['word/document.xml', 'word/footnotes.xml'];

const marcaInicio = (clave) => `⟦ZB${clave}⟧`;
const marcaFin = (clave) => `⟦ZE${clave}⟧`;
const MARCAS = /⟦Z([BE])([A-Z0-9]+)⟧/g;

/** Tamaño máximo de cada propiedad del documento: lo fija el complemento de Word. */
const TROZO = 255;

const escaparXml = (texto) =>
  String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const inicioDeCampo = (codigo) =>
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  `<w:r><w:instrText xml:space="preserve">${escaparXml(codigo)}</w:instrText></w:r>` +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';

const FIN_DE_CAMPO = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';

/**
 * Las preferencias del documento, como las guarda Zotero en Word.
 *
 * Van en propiedades personalizadas «ZOTERO_PREF_1», «_2»…, de 255 caracteres
 * cada una. Sin ellas Zotero preguntaría la norma la primera vez; con ellas,
 * usa la que eligió el tesista. En las normas de notas se le dice además que
 * las citas van a pie de página, o las pondría dentro del texto.
 */
function preferencias({ norma, idioma }) {
  const elegida = normas.normaDe(norma);
  const lengua = normas.idiomaDe(idioma).id;
  const sesion = crypto.randomBytes(6).toString('base64url').slice(0, 8);

  const datos =
    '<data data-version="3" zotero-version="7.0">' +
    `<session id="${sesion}"/>` +
    `<style id="http://www.zotero.org/styles/${elegida.id}" locale="${lengua}" ` +
    'hasBibliography="1" bibliographyStyleHasBeenSet="0"/>' +
    '<prefs><pref name="fieldType" value="Field"/>' +
    (elegida.familia === 'notas' ? '<pref name="noteType" value="1"/>' : '') +
    '</prefs></data>';

  const trozos = [];
  for (let i = 0; i < datos.length; i += TROZO) trozos.push(datos.slice(i, i + TROZO));
  return trozos.map((value, i) => ({ name: `ZOTERO_PREF_${i + 1}`, value }));
}

/**
 * Cambia cada marca por su trozo de campo.
 *
 * La marca va sola en su corrida de texto —así la pone `project.docx`—, y lo que
 * se sustituye es la corrida entera, desde su `<w:r` hasta su `</w:r>`. Se
 * recorre de atrás adelante para que cada cambio no descoloque las posiciones
 * de las marcas que faltan.
 */
function coser(buffer, codigos) {
  if (!codigos || codigos.size === 0) return buffer;

  const zip = new AdmZip(buffer);

  for (const parte of PARTES) {
    const entrada = zip.getEntry(parte);
    if (!entrada) continue;

    let xml = entrada.getData().toString('utf8');
    const marcas = [...xml.matchAll(MARCAS)];

    for (const marca of marcas.reverse()) {
      const desde = Math.max(xml.lastIndexOf('<w:r>', marca.index), xml.lastIndexOf('<w:r ', marca.index));
      const cierre = xml.indexOf('</w:r>', marca.index);
      if (desde === -1 || cierre === -1) continue;

      const [, tipo, clave] = marca;
      const codigo = codigos.get(clave);
      // Una marca sin código se quita sin dejar campo: mejor una cita sin campo
      // que una marca rara en la tesis de alguien.
      const trozo = codigo ? (tipo === 'B' ? inicioDeCampo(codigo) : FIN_DE_CAMPO) : '';

      xml = xml.slice(0, desde) + trozo + xml.slice(cierre + '</w:r>'.length);
    }

    zip.updateFile(parte, Buffer.from(xml, 'utf8'));
  }

  return zip.toBuffer();
}

/**
 * A qué ítem de Zotero apunta una cita.
 *
 * Si la fuente vino del Zotero que conectó el tesista, a SU ítem: al pulsar
 * «Refresh», Zotero la reconoce como suya y deja de ser una copia. Lo mismo con
 * una fuente del fondo de Acosta cuando la cuenta del tesista ES la biblioteca
 * de la casa, que es el caso del propio Acosta.
 *
 * En cualquier otro caso, una dirección de Acosta que no se confunde con ningún
 * ítem de nadie. Zotero no la encuentra y usa los datos de la cita, que es lo
 * correcto; y como es siempre la misma para la misma fuente, dos citas de la
 * misma obra cuentan como una sola entrada en la bibliografía.
 */
function urisDeZotero(fuente, { cuenta = null, bibliotecaDeLaCasa = null } = {}) {
  const usuario = cuenta?.zoteroUserId;

  if (usuario) {
    const prefijo = `zotero:users/${usuario}:`;
    if (fuente.sourceRef?.startsWith(prefijo)) {
      return [`http://zotero.org/users/${usuario}/items/${fuente.sourceRef.slice(prefijo.length)}`];
    }
    if (!fuente.ownerUserId && fuente.zoteroKey && bibliotecaDeLaCasa === `users/${usuario}`) {
      return [`http://zotero.org/users/${usuario}/items/${fuente.zoteroKey}`];
    }
  }

  return [`https://acostaresearch.com/fuentes/${fuente.ref}`];
}

module.exports = { preferencias, coser, marcaInicio, marcaFin, urisDeZotero };
