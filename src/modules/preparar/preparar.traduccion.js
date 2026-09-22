'use strict';

/**
 * El documento traducido: el texto nuevo, dentro del Word del cliente.
 *
 * POR QUÉ NO SE USA `project.reescritura.reescribir` TAL CUAL
 * -----------------------------------------------------------
 * Porque se escribió para el humanizador, y allí un párrafo con una cita de
 * Zotero se salta y no pasa nada: el tesista humaniza los demás. Traduciendo,
 * saltárselo es entregar un documento medio en inglés y medio en español, que
 * es peor que no haber traducido nada. Y en una tesis, los párrafos con cita
 * son justo los que importan.
 *
 * Así que aquí se hace lo mismo que allí —el párrafo se rehace conservando su
 * `<w:p>`, su `<w:pPr>` y el formato de cada corrida, con `rehacerParrafo`—
 * pero antes se ponen a salvo los campos y los hipervínculos con
 * `preparar.campos`, y después se devuelven a su sitio.
 *
 * Lo que no se puede rehacer sigue sin tocarse: una imagen o una ecuación
 * dentro del párrafo lo dejan como estaba, y se cuenta y se dice.
 */

const documento = require('../projects/project.documento');
const reescritura = require('../projects/project.reescritura');
const campos = require('./preparar.campos');

/**
 * El Word con los párrafos traducidos.
 *
 * `cambios` es `{ id: { original, texto } }`, lo que devuelve `preparar.motor`.
 * Un párrafo cuyo texto ya no coincide con `original` no se escribe: el
 * documento que se lee aquí es el mismo que se leyó al mandarlo al modelo, así
 * que eso solo pasaría por un fallo nuestro, y ante la duda se deja el del
 * cliente.
 *
 * Devuelve `{ buffer, tocados, intactos }`, con `intactos` como un mapa de
 * identificador a motivo, en las palabras que se le pueden enseñar a él.
 */
function traducir(buffer, cambios) {
  const { zip, xml } = documento.abrir(buffer);
  const parrafos = new Map(documento.parrafosDe(xml).map((parrafo) => [parrafo.id, parrafo]));

  const ediciones = [];
  const intactos = new Map();

  for (const [clave, propuesta] of Object.entries(cambios ?? {})) {
    const id = Number(clave);
    const parrafo = parrafos.get(id);

    if (!parrafo) {
      intactos.set(id, 'ya no está en el documento');
      continue;
    }
    if (documento.esqueleto(parrafo.texto) !== documento.esqueleto(propuesta.original)) {
      intactos.set(id, 'cambió mientras se preparaba');
      continue;
    }

    try {
      const original = xml.slice(parrafo.inicio, parrafo.fin);
      const protegido = campos.proteger(original);
      const hecho = reescritura.rehacerParrafo(
        protegido.xml,
        campos.enmascarar(propuesta.texto, protegido.campos),
      );
      ediciones.push({
        desde: parrafo.inicio,
        hasta: parrafo.fin,
        poner: campos.restaurar(hecho.xml, protegido.campos),
      });
    } catch (error) {
      if (error instanceof campos.NoProtegible || error instanceof reescritura.NoReescribible) {
        intactos.set(id, error.message);
        continue;
      }
      throw error;
    }
  }

  ediciones.sort((a, b) => a.desde - b.desde);

  const trozos = [];
  let desde = 0;
  for (const edicion of ediciones) {
    trozos.push(xml.slice(desde, edicion.desde), edicion.poner);
    desde = edicion.hasta;
  }
  trozos.push(xml.slice(desde));

  zip.updateFile('word/document.xml', Buffer.from(trozos.join(''), 'utf8'));

  return { buffer: zip.toBuffer(), tocados: ediciones.length, intactos };
}

module.exports = { traducir };
