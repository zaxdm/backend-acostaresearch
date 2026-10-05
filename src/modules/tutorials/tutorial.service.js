'use strict';

const prisma = require('../../lib/prisma');
const { ConflictError, NotFoundError } = require('../../shared/errors/AppError');

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

  /**
   * Renumera 1, 2, 3… según el orden de `ids`.
   *
   * Tiene que venir la lista completa: si faltara uno, quedaría con su número
   * viejo y chocaría con el de otro. En una transacción, para que un fallo a
   * medias no deje dos videos con el mismo número.
   */
  async reorder(ids) {
    const existentes = await prisma.tutorial.findMany({ select: { id: true } });
    const conocidos = new Set(existentes.map((fila) => fila.id));
    const completa =
      new Set(ids).size === ids.length &&
      ids.length === conocidos.size &&
      ids.every((id) => conocidos.has(id));
    if (!completa) {
      throw new ConflictError('La lista cambió mientras la ordenabas. Recarga y vuelve a intentarlo.');
    }

    await prisma.$transaction(
      ids.map((id, i) => prisma.tutorial.update({ where: { id }, data: { orden: i + 1 } })),
    );
    return tutorialService.listAll();
  },

  /**
   * El título de un video por oEmbed, que es público y no pide clave.
   *
   * Solo el título: la duración no viene en oEmbed, y la página del video al
   * servidor le pide iniciar sesión. La duración la lee el panel con el
   * reproductor incrustado (`youtube-datos.ts` en la web). Null si YouTube no
   * contesta o el video es privado: el título se escribe a mano.
   */
  async datosDeYouTube(videoId) {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`,
    )}`;
    try {
      const respuesta = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!respuesta.ok) return { titulo: null };
      const datos = await respuesta.json();
      const titulo = typeof datos.title === 'string' ? datos.title.trim().slice(0, 160) : '';
      return { titulo: titulo || null };
    } catch {
      return { titulo: null };
    }
  },

  async remove(id) {
    const existe = await prisma.tutorial.findUnique({ where: { id }, select: { id: true } });
    if (!existe) throw new NotFoundError('Ese tutorial no existe.');

    await prisma.tutorial.delete({ where: { id } });
    return { id };
  },
};

module.exports = tutorialService;
