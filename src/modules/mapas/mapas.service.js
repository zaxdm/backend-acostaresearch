'use strict';

const prisma = require('../../lib/prisma');
const openalex = require('../references/openalex.client');
const { AppError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');
const { construirMapa } = require('./mapas.coocurrencia');

/**
 * De dónde salen los documentos del mapa.
 *
 * DOS ORÍGENES, Y NINGUNO ES SCOPUS
 * ---------------------------------
 *   - «openalex»: una búsqueda por tema en OpenAlex. Sus datos son CC0 —se
 *     pueden reutilizar y publicar sin pedir permiso a nadie—, que es lo que
 *     hace falta para un mapa que el tesista va a meter en su tesis. Sus
 *     palabras clave las asigna un clasificador, no el autor, y el panel lo dice.
 *   - «mis-fuentes»: lo que el tesista subió de su propio export de Scopus o
 *     Web of Science, con las palabras clave DE AUTOR. Es el mapa clásico de
 *     VOSviewer, hecho con los datos que él descargó con la suscripción de su
 *     universidad.
 *
 * El buscador de Scopus por API no alimenta el mapa: con la clave de la casa
 * no trae palabras clave, y armar un producto derivado con su contenido es
 * justo lo que el acuerdo de Elsevier no deja.
 */

/** Por debajo de esto no sale un mapa que diga algo. */
const MINIMO_DE_DOCUMENTOS = 5;

/** Las palabras clave de sus fuentes, que se guardan como «a, b, c». */
function terminosDeEtiquetas(tags) {
  return String(tags ?? '')
    .split(/\s*[,;]\s*/)
    .map((t) => t.trim())
    .filter(Boolean);
}

async function documentosDeMisFuentes(userId) {
  const fuentes = await prisma.reference.findMany({
    where: { ownerUserId: userId },
    select: { tags: true, year: true },
  });

  return {
    documentos: fuentes.map((f) => ({ terminos: terminosDeEtiquetas(f.tags), anio: f.year ?? null })),
    total: fuentes.length,
  };
}

async function documentosDeOpenAlex({ tema, desdeAnio, hastaAnio, idioma, cuantas }) {
  const { obras, total, caida } = await openalex.obrasParaMapa({
    tema,
    desdeAnio,
    hastaAnio,
    idioma,
    cuantas,
  });

  if (caida) {
    throw new AppError(
      'El catálogo abierto (OpenAlex) no está respondiendo ahora. Inténtalo de nuevo en unos minutos.',
      // Con su propio código: SERVICE_UNAVAILABLE pondría la web en mantenimiento.
      { statusCode: 503, code: ERROR_CODES.CATALOG_UNAVAILABLE },
    );
  }

  return { documentos: obras, total };
}

/**
 * El mapa de coocurrencia de palabras clave, listo para VOSviewer.
 *
 * `total` es cuántos documentos hay en el origen: en OpenAlex, cuántos
 * encontró la búsqueda aunque solo se traigan los más citados; en sus fuentes,
 * cuántas tiene. Sirve para escribir el método: «de 3 412 documentos, se
 * analizaron los 500 más citados».
 */
async function coocurrencia(userId, datos) {
  const { origen } = datos;

  const { documentos, total } =
    origen === 'mis-fuentes'
      ? await documentosDeMisFuentes(userId)
      : await documentosDeOpenAlex(datos);

  const conTerminos = documentos.filter((d) => d.terminos.length > 0).length;
  if (conTerminos < MINIMO_DE_DOCUMENTOS) {
    const mensaje =
      origen === 'mis-fuentes'
        ? total === 0
          ? 'Todavía no tienes fuentes. Sube el export de Scopus o Web of Science con las palabras clave y vuelve a intentarlo.'
          : `Solo ${conTerminos} de tus ${total} fuentes traen palabras clave, y hacen falta al menos ${MINIMO_DE_DOCUMENTOS}. Vuelve a exportar de Scopus marcando «Abstract & keywords».`
        : 'La búsqueda encontró muy pocos artículos con palabras clave. Prueba con un tema más amplio o escrito en inglés.';
    throw new AppError(mensaje, { statusCode: 422, code: ERROR_CODES.VALIDATION_ERROR });
  }

  const titulo =
    origen === 'mis-fuentes'
      ? 'Coocurrencia de palabras clave de mis fuentes'
      : `Coocurrencia de palabras clave: ${datos.tema}`;
  const descripcion =
    origen === 'mis-fuentes'
      ? `Palabras clave de ${conTerminos} fuentes propias.`
      : `Palabras clave de ${documentos.length} artículos de OpenAlex (los más citados de ${total}).`;

  const mapa = construirMapa(documentos, {
    minimo: datos.minimo ?? null,
    maximo: datos.maximo,
    excluir: datos.excluir,
    sinonimos: datos.sinonimos,
    titulo,
    descripcion,
  });

  if (mapa.resumen.enElMapa < 2) {
    throw new AppError(
      'Con ese umbral no queda ningún par de términos que aparezcan juntos. Baja el mínimo de ocurrencias o amplía la búsqueda.',
      { statusCode: 422, code: ERROR_CODES.VALIDATION_ERROR },
    );
  }

  return {
    ...mapa,
    origen: {
      tipo: origen,
      total,
      analizados: documentos.length,
      ...(origen === 'openalex' && { tema: datos.tema, desdeAnio: datos.desdeAnio ?? null, hastaAnio: datos.hastaAnio ?? null }),
    },
  };
}

module.exports = { coocurrencia, terminosDeEtiquetas, MINIMO_DE_DOCUMENTOS };
