'use strict';

const logger = require('../../config/logger');
const { AppError, ValidationError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');
const parser = require('./scopus.parser');
const propiasRepository = require('./propias.repository');

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

const propiasService = {
  TIPOS,

  resumen(userId) {
    return propiasRepository.resumen(userId);
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
    if (!buffer || buffer.length === 0) {
      throw new ValidationError('El archivo llegó vacío.');
    }

    const { formato, filas, leidas, descartadas } = parser.leer(buffer);

    if (filas.length === 0) {
      throw new ValidationError(
        'No encontramos ninguna fuente en ese archivo. Exporta desde Scopus en CSV, RIS o ' +
          'BibTeX, y asegúrate de marcar al menos el título, los autores y el año.',
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
