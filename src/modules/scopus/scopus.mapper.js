'use strict';

const { normalizar } = require('../references/zotero.mapper');

/**
 * De una ficha de la API de Scopus a lo que entiende esta casa.
 *
 * LA REGLA QUE GOBIERNA TODO EL ARCHIVO
 * -------------------------------------
 * Lo que sale de aquí tiene que ser INDISTINGUIBLE de lo que sale del lector de
 * exports (`references/scopus.parser`). Misma `sourceRef`, mismo `origin`,
 * mismo `busqueda` normalizado, mismos recortes de longitud.
 *
 * No es simetría por gusto: es lo que hace que el artículo que el tesista
 * importó el martes desde aquí y el mismo artículo dentro del CSV que sube el
 * jueves sean UNA fila y no dos. La deduplicación de `propias.repository` los
 * reconoce como el mismo porque comparten `sourceRef`, y comparten `sourceRef`
 * porque los dos caminos la calculan igual: DOI primero, EID después.
 *
 * Si algún día hay que tocar la forma de la fila, se tocan LOS DOS archivos a
 * la vez, o el tesista empieza a ver duplicados que no puso.
 */

const recortar = (valor, largo) => {
  const texto = String(valor ?? '').trim();
  return texto ? texto.slice(0, largo) : null;
};

/** Un DOI limpio, venga como identificador o como enlace. */
function limpiarDoi(crudo) {
  const valor = String(crudo ?? '').trim();
  if (!valor) return null;
  return valor.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').slice(0, 200) || null;
}

/**
 * La forma de un EID de Scopus: `2-s2.0-85012345678`.
 *
 * Se comprueba, y no por desconfiar del propio Elsevier. El EID es lo que
 * vuelve del navegador cuando el tesista marca qué quiere importar, y con él se
 * arma una ecuación `EID(...)` que se le manda a Scopus. Sin esta forma fija,
 * ese texto podría llevar paréntesis, operadores o comillas y cambiaría la
 * consulta entera. Con ella, lo que no sea un EID no llega ni a salir de aquí.
 */
const FORMA_DE_EID = /^2-s2\.0-\d{5,20}$/;

const esEid = (valor) => FORMA_DE_EID.test(String(valor ?? '').trim());

/** El año, de una fecha de cobertura como «2020-05-01». */
function anio(fecha) {
  const encontrado = /\b(1[5-9]\d{2}|20\d{2})\b/.exec(String(fecha ?? ''));
  return encontrado ? Number(encontrado[1]) : null;
}

/**
 * Los autores en el formato de la casa: «Apellido, N.; Apellido, N.».
 *
 * De dos sitios, según lo que haya llegado. La vista COMPLETE trae el reparto
 * entero en `author`, con apellido y nombre separados, que es lo único que
 * permite escribir bien una referencia en APA. La STANDARD solo trae
 * `dc:creator`, que es el PRIMER autor y ya viene con esa forma.
 *
 * Y esa diferencia se nota en el Word: con STANDARD, la bibliografía sale con
 * un solo autor por fuente. No hay forma de arreglarlo desde aquí —el dato no
 * ha llegado— y por eso el panel avisa cuando no hay token institucional.
 */
function autores(ficha) {
  const lista = Array.isArray(ficha.author) ? ficha.author : [];

  const formateados = lista
    .map((persona) => {
      const apellido = String(persona?.surname ?? '').trim();
      const nombre = String(persona?.['given-name'] ?? '').trim();
      if (apellido && nombre) return `${apellido}, ${iniciales(nombre)}`;
      // `authname` ya viene como «Apellido N.»: solo le falta la coma.
      const entero = String(persona?.authname ?? apellido ?? '').trim();
      return entero ? entero.replace(/\s+([A-ZÁÉÍÓÚÑ]\.?(?:[A-ZÁÉÍÓÚÑ]\.?)*)$/, ', $1') : '';
    })
    .filter(Boolean);

  if (formateados.length > 0) return formateados.join('; ');

  const primero = String(ficha['dc:creator'] ?? '').trim();
  return primero ? primero.replace(/\s+([A-ZÁÉÍÓÚÑ]\.?(?:[A-ZÁÉÍÓÚÑ]\.?)*)$/, ', $1') : '';
}

/** «María José» → «M.J.», que es como lo escribe APA. */
function iniciales(nombre) {
  return nombre
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((parte) => `${parte[0].toUpperCase()}.`)
    .join('');
}

/** El enlace al registro en Scopus, si Elsevier lo manda. */
function enlaceDeScopus(ficha) {
  const enlaces = Array.isArray(ficha.link) ? ficha.link : [];
  const suyo = enlaces.find((enlace) => enlace?.['@ref'] === 'scopus');
  return recortar(suyo?.['@href'], 500);
}

/**
 * Las páginas. `prism:pageRange` cuando la revista pagina, y el número de
 * artículo cuando no —que es lo normal en las electrónicas, donde el «e0123456»
 * hace las veces de página y sin él la referencia queda incompleta en APA—.
 */
function paginas(ficha) {
  return recortar(ficha['prism:pageRange'] ?? ficha['article-number'], 40);
}

/**
 * Lo que se le enseña al tesista para que elija.
 *
 * Solo lo que hace falta para reconocer un artículo y decidir si lo quiere. El
 * `eid` va porque es lo que vuelve al importar: la web NO manda de vuelta los
 * datos bibliográficos, manda los identificadores, y el servidor vuelve a
 * pedírselos a Scopus. Así lo que acaba en la biblioteca es lo que dijo
 * Elsevier y no lo que traiga una petición del navegador.
 */
function comoResultado(ficha) {
  const doi = limpiarDoi(ficha['prism:doi']);

  return {
    eid: recortar(ficha.eid, 64),
    /** El identificador de Scopus, sin el prefijo «SCOPUS_ID:». */
    scopusId: recortar(String(ficha['dc:identifier'] ?? '').replace(/^SCOPUS_ID:/, ''), 40),
    titulo: recortar(ficha['dc:title'], 500) ?? '(sin título)',
    autores: autores(ficha),
    anio: anio(ficha['prism:coverDate']),
    revista: recortar(ficha['prism:publicationName'], 300),
    doi,
    tipo: recortar(ficha.subtypeDescription, 60),
    citas: Number(ficha['citedby-count'] ?? 0) || 0,
    accesoAbierto: ficha.openaccessFlag === true || ficha.openaccess === '1',
    enlace: enlaceDeScopus(ficha),
    /**
     * Si esta ficha trae resumen. No se manda el resumen entero: son
     * veinticinco fichas por página y el resumen multiplica por diez el tamaño
     * de la respuesta para algo que en una lista no se lee. Lo que sí importa
     * a la vista es SI LO HAY, porque una fuente sin resumen se puede citar
     * pero Claude no la va a encontrar después.
     */
    conResumen: Boolean(String(ficha['dc:description'] ?? '').trim()),
  };
}

/**
 * La fila de `references`, idéntica a la que produce el lector de exports.
 *
 * La identidad va en el mismo orden que allí y por las mismas razones: el DOI
 * es universal y estable, el EID solo vale dentro de Scopus, y el título es el
 * último recurso.
 */
function comoFila(ficha) {
  const titulo = recortar(ficha['dc:title'], 500);
  if (!titulo) return null;

  const doi = limpiarDoi(ficha['prism:doi']);
  const eid = recortar(ficha.eid, 64);
  const resumen = String(ficha['dc:description'] ?? '').trim() || null;
  // `authkeywords` llega separado por « | ». Se pasa a comas, que es como se
  // guardan las etiquetas en esta tabla venga la fuente de donde venga.
  const etiquetas =
    recortar(String(ficha.authkeywords ?? '').replace(/\s*\|\s*/g, ', '), 500) ?? '';

  const sourceRef =
    (doi && `doi:${doi.toLowerCase()}`) ||
    (eid && `eid:${eid}`) ||
    `titulo:${normalizar(titulo).replace(/[^a-z0-9]/g, '').slice(0, 180)}`;

  const fila = {
    zoteroKey: null,
    version: 0,
    // SCOPUS y no un valor nuevo: para esta base, una fuente de Scopus es una
    // fuente de Scopus, haya entrado por la API o dentro de un CSV. Ver la
    // migración `20260917230000_scopus_del_tesista`.
    origin: 'SCOPUS',
    sourceRef: sourceRef.slice(0, 200),
    // El tipo llega como «Article», «Conference Paper», «Book Chapter». Se
    // guarda tal cual: `project.csl.tipoCsl` ya entiende ese vocabulario, y
    // traducirlo aquí sería traducirlo dos veces.
    itemType: recortar(ficha.subtypeDescription, 40) ?? 'journalArticle',
    title: titulo,
    authors: recortar(autores(ficha), 500) ?? '',
    year: anio(ficha['prism:coverDate']),
    source: recortar(ficha['prism:publicationName'], 300),
    volume: recortar(ficha['prism:volume'], 40),
    issue: recortar(ficha['prism:issueIdentifier'], 40),
    pages: paginas(ficha),
    doi,
    // El registro en Scopus, que es a donde quiere ir quien pulsa el enlace.
    url: enlaceDeScopus(ficha),
    abstract: resumen,
    // Sin nota, como todo lo que no escribió Acosta. El conector se apoya en
    // esa diferencia para no presentarlas como material curado.
    notes: null,
    tags: etiquetas,
  };

  return conBusqueda(fila);
}

/**
 * Rehace la columna con la que se busca.
 *
 * Va aparte porque la ficha se completa DESPUÉS de armarla —ver `completar`— y
 * una fila a la que se le añade el resumen sin rehacer esto queda con el
 * resumen guardado y sin poder encontrarse por él, que es el peor de los dos
 * mundos: ocupa sitio y no sirve.
 */
function conBusqueda(fila) {
  return {
    ...fila,
    busqueda: normalizar(
      [fila.title, fila.authors, fila.source, fila.year, fila.abstract, fila.tags]
        .filter(Boolean)
        .join(' '),
    ),
  };
}

/**
 * ¿Trae Scopus la ficha entera?
 *
 * Dos cosas, y las dos vienen solo con la vista COMPLETE, que exige token
 * institucional:
 *
 *   · el RESUMEN, sin el cual la fuente se puede citar pero Claude no la
 *     encuentra al redactar;
 *   · el REPARTO DE AUTORES. Sin él solo llega `dc:creator`, que es el PRIMER
 *     autor, y la bibliografía saldría con «Brignole, M.» donde el artículo
 *     tiene treinta firmantes. En APA eso está mal, y lo ve el asesor.
 *
 * Lo que devuelve esto decide si hace falta ir al catálogo abierto.
 */
function estaCompleta(ficha) {
  return (
    Array.isArray(ficha.author) &&
    ficha.author.length > 0 &&
    Boolean(String(ficha['dc:description'] ?? '').trim())
  );
}

/**
 * Completa una ficha de Scopus con lo que dan los catálogos abiertos.
 *
 * QUÉ MANDA EN CADA CAMPO, Y POR QUÉ
 * ----------------------------------
 * Los AUTORES los manda Crossref, y si no está, OpenAlex. Es el registro donde
 * el editor los depositó, con apellido y nombre separados; Scopus sin token
 * solo da el primero. Este campo acaba en la bibliografía del Word, así que se
 * prefiere el que viene completo aunque el de Scopus exista.
 *
 * El RESUMEN lo da OpenAlex, que es el único de los tres que lo trae aquí.
 *
 * Todo lo demás manda SCOPUS y solo se rellena si falta: el título, la revista
 * y el tipo de documento son lo que el tesista vio al marcar la casilla, y
 * cambiárselos por detrás por los de otro catálogo haría que la ficha guardada
 * no fuera la que eligió.
 *
 * LO QUE ENTRA POR AQUÍ SE RECORTA IGUAL QUE LO DE `comoFila`
 * ----------------------------------------------------------
 * `comoFila` recorta cada campo a la longitud de su columna, pero esta función
 * los REEMPLAZA por los del catálogo abierto, y esos no los ha medido nadie.
 * Crossref devuelve la lista COMPLETA de firmantes sin tope —OpenAlex corta en
 * ocho, Crossref no corta— y un artículo de cincuenta autores da un `authors`
 * de varios miles de caracteres para una columna de 500. MySQL no lo trunca:
 * lo rechaza con un 1406, que llega al tesista como «Ocurrió un error
 * inesperado» y tumba la importación ENTERA, incluidas las fichas que sí
 * cabían. Justo por eso el de Scopus sin token institucional —el que más
 * necesita completarse— era el que más fallaba.
 *
 * Las longitudes son las de `prisma/schema.prisma` y las mismas que usan
 * `comoFila` y el lector de exports. Si cambian allí, cambian en los tres.
 */
function completar(fila, { deOpenAlex = null, deCrossref = null } = {}) {
  if (!deOpenAlex && !deCrossref) return fila;

  const preferido = (...valores) => valores.find((valor) => valor) ?? null;

  return conBusqueda({
    ...fila,
    authors: recortar(preferido(deCrossref?.authors, deOpenAlex?.authors, fila.authors), 500) ?? '',
    // `abstract` y `busqueda` son TEXT: no se recortan, y no hace falta.
    abstract: preferido(fila.abstract, deOpenAlex?.abstract, deCrossref?.abstract),
    volume: recortar(preferido(fila.volume, deCrossref?.volume, deOpenAlex?.volume), 40),
    issue: recortar(preferido(fila.issue, deCrossref?.issue, deOpenAlex?.issue), 40),
    pages: recortar(preferido(fila.pages, deCrossref?.pages, deOpenAlex?.pages), 40),
    source: recortar(preferido(fila.source, deCrossref?.source, deOpenAlex?.source), 300),
    tags: fila.tags || recortar(deOpenAlex?.tags, 500) || '',
  });
}

module.exports = { comoResultado, comoFila, estaCompleta, completar, esEid, limpiarDoi };
