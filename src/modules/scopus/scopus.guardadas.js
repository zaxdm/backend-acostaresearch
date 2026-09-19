'use strict';

const prisma = require('../../lib/prisma');
const { NotFoundError } = require('../../shared/errors/AppError');

/**
 * Las búsquedas guardadas y las conversaciones del copiloto de Scopus.
 *
 * Es la columna de la izquierda del buscador: las del copiloto se guardan
 * solas al llegar el resumen; las normales, al pulsar «Guardar búsqueda».
 *
 * CADA UNO SOLO VE LAS SUYAS. Toda consulta va por `userId` además del `id`:
 * un identificador adivinado o copiado de otra cuenta da «no existe», nunca
 * la búsqueda de otro.
 *
 * Se guarda la ecuación y el estado del buscador, no los artículos. Al abrir
 * una se vuelve a pedir a Scopus: guardar sus resultados sería almacenar su
 * contenido, que es lo que su acuerdo prohíbe.
 */

/**
 * Cuántas se guardan por persona. Al pasar de aquí se va la más antigua: es un
 * historial, y lo de hace meses no se echa de menos; lo que no puede pasar es
 * que guardar una falle porque hay demasiadas.
 */
const MAXIMO_POR_USUARIO = 100;

/** Lo que va en la lista: sin el estado ni el hilo, que pueden pesar. */
const RESUMIDA = { id: true, tipo: true, titulo: true, total: true, createdAt: true, updatedAt: true };

async function listar(userId) {
  return prisma.scopusBusqueda.findMany({
    where: { userId },
    select: RESUMIDA,
    orderBy: { updatedAt: 'desc' },
    take: MAXIMO_POR_USUARIO,
  });
}

async function una(userId, id) {
  const busqueda = await prisma.scopusBusqueda.findFirst({ where: { id, userId } });
  if (!busqueda) throw new NotFoundError('Esa búsqueda ya no existe.');
  return busqueda;
}

async function crear(userId, { tipo, titulo, ecuacion, estado, hilo = null, total = 0 }) {
  const creada = await prisma.scopusBusqueda.create({
    data: { userId, tipo, titulo, ecuacion, estado, hilo: hilo ?? undefined, total },
    select: RESUMIDA,
  });

  // Las que sobran, fuera. Después de crear y no antes: si esto fallara, la
  // nueva ya está guardada, que es lo que pidió.
  const sobrantes = await prisma.scopusBusqueda.findMany({
    where: { userId },
    select: { id: true },
    orderBy: { updatedAt: 'desc' },
    skip: MAXIMO_POR_USUARIO,
  });
  if (sobrantes.length > 0) {
    await prisma.scopusBusqueda.deleteMany({ where: { userId, id: { in: sobrantes.map((s) => s.id) } } });
  }

  return creada;
}

/** Cambia lo que venga; lo que no viene se queda como estaba. */
async function actualizar(userId, id, cambios) {
  await una(userId, id);
  const datos = {};
  for (const campo of ['titulo', 'ecuacion', 'estado', 'hilo', 'total']) {
    if (cambios[campo] !== undefined) datos[campo] = cambios[campo];
  }
  return prisma.scopusBusqueda.update({ where: { id }, data: datos, select: RESUMIDA });
}

async function borrar(userId, id) {
  const { count } = await prisma.scopusBusqueda.deleteMany({ where: { id, userId } });
  if (count === 0) throw new NotFoundError('Esa búsqueda ya no existe.');
}

module.exports = { listar, una, crear, actualizar, borrar, MAXIMO_POR_USUARIO };
