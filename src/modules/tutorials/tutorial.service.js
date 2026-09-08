'use strict';

const prisma = require('../../lib/prisma');
const { NotFoundError } = require('../../shared/errors/AppError');

/**
 * Los videos de la página de tutoriales.
 *
 * Los puntos se guardan como texto con un salto de línea por punto —así se
 * escriben en el panel— y salen como lista, que es como los pinta la página.
 * La conversión vive aquí y en un solo sitio: ni el panel ni la web tienen que
 * saber cómo están guardados.
 */

const aLista = (texto) =>
  String(texto ?? '')
    .split('\n')
    .map((linea) => linea.trim())
    .filter(Boolean);

const salida = (fila) => ({ ...fila, puntos: aLista(fila.puntos) });

const tutorialService = {
  /** Lo que ve el visitante: solo lo activo, en su orden. */
  async listPublic() {
    const filas = await prisma.tutorial.findMany({
      where: { active: true },
      orderBy: [{ orden: 'asc' }, { createdAt: 'asc' }],
    });
    return filas.map(salida);
  },

  /** Lo que ve el panel: todo, incluido lo apagado. */
  async listAll() {
    const filas = await prisma.tutorial.findMany({
      orderBy: [{ orden: 'asc' }, { createdAt: 'asc' }],
    });
    return filas.map(salida);
  },

  async create(datos) {
    const fila = await prisma.tutorial.create({ data: datos });
    return salida(fila);
  },

  async update(id, datos) {
    const existe = await prisma.tutorial.findUnique({ where: { id }, select: { id: true } });
    if (!existe) throw new NotFoundError('Ese tutorial no existe.');

    const fila = await prisma.tutorial.update({ where: { id }, data: datos });
    return salida(fila);
  },

  async remove(id) {
    const existe = await prisma.tutorial.findUnique({ where: { id }, select: { id: true } });
    if (!existe) throw new NotFoundError('Ese tutorial no existe.');

    await prisma.tutorial.delete({ where: { id } });
    return { id };
  },
};

module.exports = tutorialService;
