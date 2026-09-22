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
 * pero con dos añadidos:
 *
 * · Antes se ponen a salvo los campos y los hipervínculos con
 *   `preparar.campos`, y después se devuelven a su sitio.
 * · Se pide `conservarObjetos`, así que una imagen, una ecuación, un objeto
 *   incrustado o un control de contenido ya NO dejan el párrafo sin traducir:
 *   se guardan enteros y vuelven a su sitio. Antes se saltaban, y el cliente
 *   recibía en español justo el párrafo que explica su figura.
 *
 * LAS DEMÁS PARTES DEL ZIP
 * ------------------------
 * No solo `word/document.xml`: las notas al pie, las notas al final, el
 * encabezado y el pie de página viven en otros archivos y también se traducen.
 * Cada párrafo viene con su `parte`, y se escribe una vez cada archivo. Ver
 * `preparar.partes`.
 *
 * Lo que aun así no se puede rehacer —control de cambios sin aceptar, una cita
 * que el modelo tradujo en vez de copiar— sigue sin tocarse, y se cuenta y se
 * dice CON SU MOTIVO: quien recibe el documento tiene derecho a saber qué
 * quedó como estaba y por qué.
 */

const documento = require('../projects/project.documento');
const reescritura = require('../projects/project.reescritura');
const campos = require('./preparar.campos');
const partes = require('./preparar.partes');

/** Lo que se le pide a `rehacerParrafo`: aquí las figuras no bloquean nada. */
const COMO = Object.freeze({ conservarObjetos: true });

/**
 * El Word con los párrafos traducidos.
 *
 * `cambios` es `{ clave: { original, texto } }`, lo que devuelve
 * `preparar.motor`, y `parrafos` es la lista que se le pasó, que es de donde
 * sale a qué archivo del zip pertenece cada clave.
 *
 * Un párrafo cuyo texto ya no coincide con `original` no se escribe: el
 * documento que se lee aquí es el mismo que se leyó al mandarlo al modelo, así
 * que eso solo pasaría por un fallo nuestro, y ante la duda se deja el del
 * cliente.
 *
 * Devuelve `{ buffer, tocados, intactos }`, con `intactos` como un mapa de
 * clave a motivo, en las palabras que se le pueden enseñar a él.
 */
function traducir(buffer, cambios, parrafos = []) {
  const { zip } = documento.abrir(buffer);
  const donde = new Map(parrafos.map((parrafo) => [String(parrafo.clave ?? parrafo.id), parrafo]));

  const intactos = new Map();

  // Por archivo del zip, porque cada uno se lee y se escribe una sola vez.
  const porParte = new Map();
  for (const [clave, propuesta] of Object.entries(cambios ?? {})) {
    const sitio = donde.get(String(clave));
    const parte = sitio?.parte ?? partes.PRINCIPAL;
    const id = Number(sitio?.id ?? clave);

    if (!porParte.has(parte)) porParte.set(parte, []);
    porParte.get(parte).push({ clave, id, propuesta });
  }

  let tocados = 0;

  for (const [parte, pedidos] of porParte) {
    const entrada = zip.getEntry(parte);
    if (!entrada) {
      for (const { clave } of pedidos) intactos.set(clave, 'esa parte del documento ya no está');
      continue;
    }

    const xml = entrada.getData().toString('utf8');
    const delXml = new Map(documento.parrafosDe(xml).map((parrafo) => [parrafo.id, parrafo]));
    const ediciones = [];

    for (const { clave, id, propuesta } of pedidos) {
      const parrafo = delXml.get(id);

      if (!parrafo) {
        intactos.set(clave, 'ya no está en el documento');
        continue;
      }
      if (documento.esqueleto(parrafo.texto) !== documento.esqueleto(propuesta.original)) {
        intactos.set(clave, 'cambió mientras se preparaba');
        continue;
      }

      try {
        const original = xml.slice(parrafo.inicio, parrafo.fin);
        const protegido = campos.proteger(original);
        const hecho = reescritura.rehacerParrafo(
          protegido.xml,
          campos.enmascarar(propuesta.texto, protegido.campos),
          COMO,
        );
        ediciones.push({
          desde: parrafo.inicio,
          hasta: parrafo.fin,
          poner: campos.restaurar(hecho.xml, protegido.campos),
        });
      } catch (error) {
        if (error instanceof campos.NoProtegible || error instanceof reescritura.NoReescribible) {
          intactos.set(clave, error.message);
          continue;
        }
        throw error;
      }
    }

    if (ediciones.length === 0) continue;

    ediciones.sort((a, b) => a.desde - b.desde);

    const trozos = [];
    let desde = 0;
    for (const edicion of ediciones) {
      trozos.push(xml.slice(desde, edicion.desde), edicion.poner);
      desde = edicion.hasta;
    }
    trozos.push(xml.slice(desde));

    zip.updateFile(parte, Buffer.from(trozos.join(''), 'utf8'));
    tocados += ediciones.length;
  }

  return { buffer: zip.toBuffer(), tocados, intactos };
}

module.exports = { traducir };
