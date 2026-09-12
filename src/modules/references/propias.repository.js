'use strict';

const prisma = require('../../lib/prisma');

/**
 * Las fuentes que sube un comprador desde su export de Scopus.
 *
 * Vive aparte de `reference.repository` a propósito: aquel escribe el fondo de
 * la casa —una sola biblioteca, sincronizada desde Zotero, con su marcador de
 * versión y su borrado de retiradas— y este escribe la de UNA persona. Mezclar
 * los dos dejaba funciones con un `ownerUserId` opcional por todas partes, y
 * ese parámetro opcional es exactamente el que un día se olvida en la consulta
 * que no debía olvidarlo.
 *
 * Aquí toda consulta lleva dueño. No hay forma de llamar a nada de este archivo
 * sin decir de quién es lo que se toca.
 */

/** Cuántas fuentes puede acumular un comprador en total. */
const TOPE_POR_USUARIO = 5000;

/**
 * Guarda un lote.
 *
 * `ON DUPLICATE KEY UPDATE` sobre el índice (`ownerUserId`, `sourceRef`): volver
 * a subir el mismo export refresca la ficha en vez de duplicarla, que es lo que
 * pasa de verdad —el tesista amplía su búsqueda en Scopus y vuelve a exportar
 * todo, no solo lo nuevo—.
 *
 * Se devuelve cuántas filas eran nuevas, no cuántas se escribieron: MySQL
 * informa de dos filas afectadas por cada actualización y de una por cada alta,
 * así que la cuenta se hace antes, mirando qué referencias ya existían.
 */
async function guardarLote(userId, filas) {
  if (filas.length === 0) return { guardadas: 0, repetidas: 0 };

  const referencias = filas.map((fila) => fila.sourceRef);

  const yaEstaban = await prisma.reference.findMany({
    where: { ownerUserId: userId, sourceRef: { in: referencias } },
    select: { sourceRef: true },
  });

  const conocidas = new Set(yaEstaban.map((fila) => fila.sourceRef));

  // De una en una y no en una sentencia gigante: son cientos de filas, no
  // decenas de miles como en el fondo de la casa, y el `upsert` de Prisma acierta
  // con el índice compuesto sin tener que escribir SQL crudo para esto.
  for (const fila of filas) {
    const { sourceRef, ...datos } = fila;

    await prisma.reference.upsert({
      where: { ownerUserId_sourceRef: { ownerUserId: userId, sourceRef } },
      // Ni `id` ni el dueño: la fila es la misma y solo se refresca su ficha.
      update: datos,
      create: { ...datos, sourceRef, ownerUserId: userId },
    });
  }

  return {
    guardadas: filas.filter((fila) => !conocidas.has(fila.sourceRef)).length,
    repetidas: filas.filter((fila) => conocidas.has(fila.sourceRef)).length,
  };
}

/**
 * Los DOI de sus fuentes, que son las semillas de la bola de nieve.
 *
 * Solo las que tienen DOI: sin él no hay forma de preguntarle a nadie a quién
 * cita esa fuente. Las más recientes primero, porque una bola de nieve que
 * parte de lo último que le interesó se parece más a su tema de hoy que una que
 * parte de lo que subió el primer día.
 */
async function doisDe(userId, limite) {
  const filas = await prisma.reference.findMany({
    where: { ownerUserId: userId, doi: { not: null } },
    select: { doi: true },
    orderBy: { createdAt: 'desc' },
    take: limite,
  });

  return filas.map((fila) => fila.doi);
}

/** Cuántas tiene ya. Se consulta antes de importar, para aplicar el tope. */
function contar(userId) {
  return prisma.reference.count({ where: { ownerUserId: userId } });
}

/**
 * Cuántas de las suyas se guardaron sin resumen.
 *
 * Es el síntoma de haber exportado de Scopus sin marcar «Abstract & keywords»,
 * que no viene marcado por defecto. Una ficha sin resumen se puede citar
 * perfectamente, pero para BUSCARLA solo queda el título, y eso reduce a casi
 * nada las posibilidades de que aparezca cuando hace falta.
 *
 * Se cuenta contra la biblioteca entera y no contra el archivo recién subido
 * porque es un estado, no un suceso: el aviso tiene que seguir ahí mañana, y
 * desaparecer solo cuando el tesista vuelva a exportar bien.
 */
function contarSinResumen(userId) {
  return prisma.reference.count({
    where: {
      ownerUserId: userId,
      // Nulo o vacío: el parser guarda null, pero una columna de texto admite
      // las dos cosas y contar solo una dejaría el aviso apagado a medias.
      OR: [{ abstract: null }, { abstract: '' }],
    },
  });
}

/** Lo que enseña su panel: cuántas hay, de cuándo es la última y si están completas. */
async function resumen(userId) {
  const [total, sinResumen, ultima] = await Promise.all([
    contar(userId),
    contarSinResumen(userId),
    prisma.reference.findFirst({
      where: { ownerUserId: userId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ]);

  return {
    total,
    sinResumen,
    ultimaCarga: ultima?.createdAt ?? null,
    tope: TOPE_POR_USUARIO,
  };
}

/**
 * Vacía su biblioteca.
 *
 * Es el deshacer de una importación. Existe porque un import no se puede
 * revisar antes —son cientos de fichas— y sin una salida clara, quien sube el
 * archivo equivocado se queda con él dentro para siempre.
 *
 * El `ownerUserId` en el `where` no es una comodidad: es lo que impide que esto
 * llegue nunca al fondo de la casa, cuyas filas lo tienen nulo.
 */
async function vaciar(userId) {
  const { count } = await prisma.reference.deleteMany({ where: { ownerUserId: userId } });
  return count;
}

module.exports = { guardarLote, doisDe, contar, contarSinResumen, resumen, vaciar, TOPE_POR_USUARIO };
