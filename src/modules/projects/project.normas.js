'use strict';

/**
 * Las normas de citas que puede llevar el Word.
 *
 * POR QUÉ ESTAS QUINCE
 * --------------------
 * Son las que trae Zotero de fábrica, con los mismos archivos: se descargaron de
 * zotero.org/styles, que es de donde las toma Zotero. Importa por dos razones.
 * Es la lista que un tesista ya ha visto si ha usado Zotero. Y si abre el Word
 * con Zotero y pulsa «Refresh», Zotero rehace las citas con el mismo motor y el
 * mismo archivo, así que no cambia nada.
 *
 * Los archivos viven en `csl/estilos` y `csl/idiomas`; su procedencia y su
 * licencia, en `csl/LEEME.md`.
 *
 * LA FAMILIA
 * ----------
 * Decide cómo entra la cita en el documento, y no es un adorno:
 *
 *   autor-fecha  «(Braun y Clarke, 2006)» dentro del texto.
 *   numerica     «[1]» dentro del texto, por orden de aparición en toda la tesis.
 *   notas        un número volado en el texto y la cita en una nota al pie.
 *
 * Sale del propio archivo (`citation-format`) y una prueba comprueba que lo que
 * dice aquí coincide con él. MLA es «author» en CSL —cita en el texto, sin año—,
 * y aquí va con las de autor-fecha porque se escribe igual: dentro del texto.
 */

const fs = require('fs');
const path = require('path');

const CARPETA = path.join(__dirname, 'csl');

/** En el orden en que se enseñan: primero la que usa casi todo el mundo. */
const NORMAS = [
  { id: 'apa', nombre: 'APA 7.ª edición', familia: 'autor-fecha' },
  { id: 'ieee', nombre: 'IEEE', familia: 'numerica' },
  { id: 'nlm-citation-sequence', nombre: 'Vancouver (NLM, por orden de cita)', familia: 'numerica' },
  { id: 'american-medical-association', nombre: 'AMA 11.ª edición', familia: 'numerica' },
  { id: 'american-chemical-society', nombre: 'ACS (revisión 2026)', familia: 'numerica' },
  { id: 'nature', nombre: 'Nature', familia: 'numerica' },
  { id: 'modern-language-association', nombre: 'MLA 9.ª edición', familia: 'autor-fecha' },
  { id: 'chicago-author-date', nombre: 'Chicago 18.ª (autor-fecha)', familia: 'autor-fecha' },
  { id: 'chicago-notes-bibliography', nombre: 'Chicago 18.ª (notas y bibliografía)', familia: 'notas' },
  {
    id: 'chicago-shortened-notes-bibliography',
    nombre: 'Chicago 18.ª (notas abreviadas y bibliografía)',
    familia: 'notas',
  },
  { id: 'harvard-cite-them-right', nombre: 'Harvard (Cite Them Right 12.ª)', familia: 'autor-fecha' },
  { id: 'elsevier-harvard', nombre: 'Elsevier Harvard (con títulos)', familia: 'autor-fecha' },
  { id: 'american-psychological-association-no-existe', nombre: '', familia: '' },
].filter((norma) => norma.nombre !== '');

// Las tres que faltan en la lista de arriba se añaden aparte para que el orden
// de enseñanza no dependa de cómo se escribió el arreglo.
NORMAS.push(
  { id: 'american-political-science-association', nombre: 'APSA (revisión 2018)', familia: 'autor-fecha' },
  { id: 'american-sociological-association', nombre: 'ASA 6.ª/7.ª edición', familia: 'autor-fecha' },
  { id: 'mhra-notes', nombre: 'MHRA 4.ª edición (notas)', familia: 'notas' },
);

const NORMA_POR_DEFECTO = 'apa';

/**
 * Los idiomas de las citas: «y» o «and», «s. f.» o «n.d.», «Recuperado de».
 *
 * De Perú no hay archivo en el proyecto CSL. España es el que usa Zotero cuando
 * se elige «Español», y por eso es el de por defecto: así el Word y Zotero dicen
 * lo mismo.
 */
const IDIOMAS = [
  { id: 'es-ES', nombre: 'Español (España)' },
  { id: 'es-MX', nombre: 'Español (México)' },
  { id: 'es-CL', nombre: 'Español (Chile)' },
  { id: 'en-US', nombre: 'Inglés (Estados Unidos)' },
];

const IDIOMA_POR_DEFECTO = 'es-ES';

const IDS_DE_NORMA = NORMAS.map((norma) => norma.id);
const IDS_DE_IDIOMA = IDIOMAS.map((idioma) => idioma.id);

/** La norma pedida, o la de por defecto si no existe o no se ha elegido. */
function normaDe(id) {
  return NORMAS.find((norma) => norma.id === id) ?? NORMAS.find((n) => n.id === NORMA_POR_DEFECTO);
}

function idiomaDe(id) {
  return IDIOMAS.find((idioma) => idioma.id === id) ?? IDIOMAS.find((i) => i.id === IDIOMA_POR_DEFECTO);
}

/**
 * Los archivos se leen una vez por proceso.
 *
 * Chicago pesa 240 KB y se aplicaría en cada descarga. No cambian mientras el
 * servidor corre —se actualizan desplegando—, así que leerlos de disco cada vez
 * sería trabajo tirado.
 */
const guardados = new Map();

function leerUnaVez(ruta) {
  if (!guardados.has(ruta)) {
    guardados.set(ruta, fs.existsSync(ruta) ? fs.readFileSync(ruta, 'utf8') : false);
  }
  return guardados.get(ruta);
}

function leerEstilo(id) {
  const norma = normaDe(id);
  const xml = leerUnaVez(path.join(CARPETA, 'estilos', `${norma.id}.csl`));
  if (!xml) throw new Error(`Falta el archivo de estilo de «${norma.id}».`);
  return xml;
}

/** `false` si no hay archivo: es lo que citeproc espera para probar con otro. */
function leerIdioma(id) {
  return leerUnaVez(path.join(CARPETA, 'idiomas', `locales-${id}.xml`));
}

module.exports = {
  NORMAS,
  IDIOMAS,
  IDS_DE_NORMA,
  IDS_DE_IDIOMA,
  NORMA_POR_DEFECTO,
  IDIOMA_POR_DEFECTO,
  normaDe,
  idiomaDe,
  leerEstilo,
  leerIdioma,
};
