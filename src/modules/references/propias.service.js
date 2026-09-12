'use strict';

const logger = require('../../config/logger');
const { AppError, ValidationError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');
const parser = require('./scopus.parser');
const openalex = require('./openalex.client');
const crossref = require('./crossref.client');
const { normalizar } = require('./zotero.mapper');
const propiasRepository = require('./propias.repository');

const recortar = (valor, largo) => {
  const texto = String(valor ?? '').trim();
  return texto ? texto.slice(0, largo) : null;
};

/**
 * De ficha de OpenAlex a fila de la tabla.
 *
 * Es la misma forma que produce el lector de exports —mismas columnas, misma
 * identidad por DOI, mismo `busqueda` normalizado—, y a propósito: las dos vías
 * entran a la misma tabla y tienen que ser indistinguibles una vez dentro. Si
 * no lo fueran, buscar encontraría unas y otras no según por dónde entraron.
 */
function comoFila(ficha) {
  const etiquetas = recortar(ficha.tags, 500) ?? '';

  const fila = {
    zoteroKey: null,
    version: 0,
    origin: 'SCOPUS',
    sourceRef: `doi:${ficha.doi.toLowerCase()}`.slice(0, 200),
    itemType: recortar(ficha.itemType, 40) ?? 'article',
    title: recortar(ficha.title, 500) ?? '(sin título)',
    authors: recortar(ficha.authors, 500) ?? '',
    year: ficha.year ?? null,
    source: recortar(ficha.source, 300),
    volume: recortar(ficha.volume, 40),
    issue: recortar(ficha.issue, 40),
    pages: recortar(ficha.pages, 40),
    doi: recortar(ficha.doi, 200),
    url: recortar(ficha.url, 500),
    abstract: ficha.abstract || null,
    // Sin nota, como todo lo que no escribió Acosta. El conector se apoya en esa
    // diferencia para no presentarlas como material curado.
    notes: null,
    tags: etiquetas,
  };

  fila.busqueda = normalizar(
    [fila.title, fila.authors, fila.source, fila.year, fila.abstract, etiquetas]
      .filter(Boolean)
      .join(' '),
  );

  return fila;
}

/**
 * La biblioteca propia de cada comprador.
 *
 * POR QUÉ UN ARCHIVO Y NO LA API DE SCOPUS
 * ----------------------------------------
 * La API de Elsevier exige que la INSTITUCIÓN esté suscrita y un token atado a
 * ella, y su acceso gratuito es explícitamente para uso no comercial. Este
 * producto se vende, así que esa puerta no está cerrada por precio sino por
 * licencia, y no hay ingeniería que la rodee.
 *
 * Pero no hace falta: el tesista SÍ tiene Scopus, por su universidad. El método
 * ya le arma la ecuación de búsqueda para que la pegue allí; lo único que
 * faltaba era por dónde subir lo que exporta. Un archivo no necesita
 * credenciales de terceros, ni cifrarlas, ni una cola de sincronización, ni
 * lidiar con claves que caducan.
 *
 * QUÉ NO SE HACE CON ESAS FUENTES
 * -------------------------------
 * No se funden con el fondo de la casa ni se le sirven a nadie más. Ese export
 * lo descargó él con la suscripción de su universidad: cargarlo a su propia
 * biblioteca es una cosa y repartirlo entre otros compradores es otra muy
 * distinta. Por eso el dueño va en la fila, y por eso se borra con la cuenta.
 */

/** Lo que se acepta subir. El formato real lo decide el lector, no esto. */
const TIPOS = [
  'text/csv',
  'application/csv',
  'text/plain',
  'application/x-research-info-systems',
  'application/x-bibtex',
  'text/x-bibtex',
  'application/octet-stream',
];

/** Cuántos DOIs se aceptan de una tacada. Cada uno es una consulta a OpenAlex. */
const MAXIMO_DOIS = 60;

const propiasService = {
  TIPOS,
  MAXIMO_DOIS,

  resumen(userId) {
    return propiasRepository.resumen(userId);
  },

  /**
   * Fuentes a partir de los DOIs que el navegador sacó de unos PDFs.
   *
   * POR QUÉ LLEGAN DOIs Y NO PDFs
   * -----------------------------
   * El PDF se lee en el navegador del tesista y no sale de su equipo. De él solo
   * viaja el DOI: veinte caracteres en vez de tres megas. Eso ahorra a la vez el
   * ancho de banda, el almacenamiento, el trabajo de este servidor y —lo que más
   * pesa— tener aquí copias de artículos con copyright que él descargó con el
   * acceso de su universidad.
   *
   * PARA QUÉ SIRVE, EN TOKENS
   * -------------------------
   * Un artículo de 40 páginas dentro de una conversación de Claude son unos
   * 25.000 tokens. La ficha equivalente son 250. Cien veces menos, y por seis
   * fuentes es la diferencia entre caber en una conversación y no caber.
   *
   * LO QUE NO RESUELVE, DICHO AQUÍ PARA QUE NO SE OLVIDE
   * ---------------------------------------------------
   * Esto sirve para CITAR un artículo, no para que el asistente lo LEA. El
   * resumen no dice con qué muestra se hizo ni qué prueba estadística se aplicó.
   * Para eso sigue haciendo falta el texto completo, que es otra decisión y no
   * está tomada.
   */
  async importarPorDoi({ userId, dois }) {
    const lista = [...new Set((dois ?? []).map((d) => String(d).trim()).filter(Boolean))];

    if (lista.length === 0) {
      throw new ValidationError('No llegó ningún DOI que buscar.');
    }

    if (lista.length > MAXIMO_DOIS) {
      throw new ValidationError(
        `Son demasiados de una vez: el máximo es ${MAXIMO_DOIS}. Sube los PDF en dos tandas.`,
      );
    }

    const tiene = await propiasRepository.contar(userId);
    if (tiene + lista.length > propiasRepository.TOPE_POR_USUARIO) {
      throw new AppError(
        `Tu biblioteca admite ${propiasRepository.TOPE_POR_USUARIO} fuentes y con esas pasarías ` +
          `de ahí (tienes ${tiene}).`,
        { statusCode: 409, code: ERROR_CODES.VALIDATION_ERROR },
      );
    }

    const filas = [];
    const noEncontrados = [];

    // De una en una y no en paralelo: son consultas a un servicio ajeno y
    // gratuito, y lanzarle sesenta a la vez es la forma de que empiece a
    // rechazarlas. Sesenta secuenciales son unos segundos.
    for (const doi of lista) {
      // OpenAlex primero: es el que trae resumen, y sin resumen la ficha sirve
      // para citar pero no para que el asistente la encuentre.
      const deOpenAlex = await openalex.porDoi(doi);

      // Crossref cubre dos huecos distintos. Si OpenAlex no conoce el DOI
      // —pasa con lo recién publicado, que tarda días en indexarse allí y en
      // Crossref existe desde el primer minuto— es la única ficha que habrá. Y
      // si lo conoce pero sin volumen ni páginas, las completa: es el registro
      // donde el editor las depositó, y sin ellas la referencia no está
      // completa en APA.
      const ficha = deOpenAlex
        ? await crossref.completar(deOpenAlex)
        : await crossref.porDoi(doi);

      if (!ficha) {
        noEncontrados.push(doi);
        continue;
      }
      filas.push(comoFila(ficha));
    }

    if (filas.length === 0) {
      throw new ValidationError(
        'No encontramos ninguno de esos DOI en el catálogo abierto. Comprueba que estén bien ' +
          'copiados, o añade esas fuentes desde el export de tu base de datos.',
      );
    }

    const { guardadas, repetidas } = await propiasRepository.guardarLote(userId, filas);

    logger.info(
      { userId, pedidos: lista.length, guardadas, repetidas, sinFicha: noEncontrados.length },
      'Fuentes propias importadas por DOI',
    );

    return {
      pedidos: lista.length,
      guardadas,
      repetidas,
      /** Los que OpenAlex no conoce. Se devuelven para poder nombrarlos. */
      noEncontrados,
      total: tiene + guardadas,
      sinResumenEnTotal: await propiasRepository.contarSinResumen(userId),
    };
  },

  vaciar(userId) {
    return propiasRepository.vaciar(userId);
  },

  /**
   * Lee el archivo y guarda lo que trae.
   *
   * Se guarda directamente, sin un paso de confirmación previo. Es seguro
   * porque una importación solo SUMA: no pisa el fondo de la casa, no borra
   * nada de lo que ya tenía y repetir el mismo archivo refresca las fichas en
   * vez de duplicarlas. El deshacer, para quien suba el archivo equivocado, es
   * vaciar la biblioteca; pedirle además que confirme cientos de fichas que no
   * puede revisar de una en una sería un trámite, no una salvaguarda.
   *
   * Lo que sí se devuelve es la cuenta de lo que pasó —cuántas nuevas, cuántas
   * ya tenía, cuántas se descartaron— porque un import que no dice nada deja al
   * comprador sin saber si funcionó.
   */
  async importar({ userId, buffer }) {
    /**
     * Un tipo que no sabemos leer no llega como archivo vacío: no llega.
     *
     * `express.raw` solo construye el Buffer si el `Content-Type` está en la
     * lista; con cualquier otro deja `req.body` como un objeto normal y aquí no
     * hay nada que mirar. El caso real es el PDF —quien tiene una carpeta de
     * artículos prueba a soltar uno, que es lo razonable— y decirle «el archivo
     * llegó vacío» le hace pensar que su PDF está roto.
     */
    if (!Buffer.isBuffer(buffer)) {
      throw new ValidationError(
        'Ese tipo de archivo todavía no lo leemos. Aquí van los EXPORTS de la base de datos ' +
          '—CSV, RIS, BibTeX o TXT—, no los PDF de los artículos: en Scopus es el botón «Export», ' +
          'no «Download».',
      );
    }

    if (buffer.length === 0) {
      throw new ValidationError('El archivo llegó vacío.');
    }

    const { formato, filas, leidas, descartadas } = parser.leer(buffer);

    if (filas.length === 0) {
      throw new ValidationError(
        'No encontramos ninguna fuente en ese archivo. Exporta desde Scopus en CSV, RIS, ' +
          'BibTeX o texto plano (TXT), y asegúrate de marcar al menos el título, los autores y ' +
          'el año.',
      );
    }

    // El tope se comprueba contra lo que YA tiene, no contra el archivo: quien
    // sube tres exports de doscientas se acerca igual que quien sube uno de
    // seiscientas.
    const tiene = await propiasRepository.contar(userId);
    if (tiene + filas.length > propiasRepository.TOPE_POR_USUARIO) {
      throw new AppError(
        `Tu biblioteca admite ${propiasRepository.TOPE_POR_USUARIO} fuentes y con esas pasarías ` +
          `de ahí (tienes ${tiene}). Sube una selección más ajustada a tu tema, o vacíala y ` +
          'vuelve a empezar.',
        { statusCode: 409, code: ERROR_CODES.VALIDATION_ERROR },
      );
    }

    const { guardadas, repetidas } = await propiasRepository.guardarLote(userId, filas);

    /**
     * Cuántas del archivo venían sin resumen.
     *
     * Es el único error que este flujo permite cometer SIN ENTERARSE. En la
     * ventana de Export de Scopus, «Abstract & keywords» no viene marcado: si no
     * se marca, el CSV llega con la cita completa y sin una línea de contenido.
     * El import entonces funciona —guarda, cuenta, dice que fue bien— y lo único
     * que falla es la búsqueda, semanas después, cuando el tesista no entiende
     * por qué no aparece nada de lo que subió.
     *
     * Todo lo demás de esta pantalla falla de frente: un archivo que no se
     * entiende se rechaza, uno equivocado se ve. Esto no, así que se cuenta y se
     * dice.
     */
    const sinResumenEnElArchivo = filas.filter((fila) => !fila.abstract).length;

    logger.info(
      { userId, formato, leidas, guardadas, repetidas, descartadas, sinResumenEnElArchivo },
      'Fuentes propias importadas desde un export bibliográfico',
    );

    return {
      formato,
      /** Fichas que traía el archivo, antes de descartar nada. */
      leidas,
      /** Fuentes nuevas de verdad. */
      guardadas,
      /** Ya las tenía: se refrescó la ficha, no se duplicó. */
      repetidas,
      /** Filas sin título utilizable. Casi siempre, relleno del export. */
      descartadas,
      /** De este archivo, cuántas llegaron sin resumen. Ver la nota de arriba. */
      sinResumen: sinResumenEnElArchivo,
      total: tiene + guardadas,
      /**
       * Y cuántas hay así en TODA su biblioteca.
       *
       * Va aparte del número del archivo porque la corrección es distinta: si
       * este vino mal pero el resto está bien, se vuelve a exportar ese; si toda
       * la biblioteca está sin resúmenes, se rehace entera. Con un solo número
       * no se puede saber cuál de las dos.
       */
      sinResumenEnTotal: await propiasRepository.contarSinResumen(userId),
    };
  },
};

module.exports = propiasService;
