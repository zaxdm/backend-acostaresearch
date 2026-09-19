'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const env = require('../../config/env');
const prisma = require('../../lib/prisma');
const { NotFoundError, ValidationError } = require('../../shared/errors/AppError');

/**
 * Las guías en PDF de la página de guías.
 *
 * La ficha va a la base y el PDF a disco, en GUIAS_DIR, con el identificador por
 * nombre: así el nombre con el que se subió nunca decide dónde se escribe. La
 * guía de siempre (`guia-instalacion.pdf`) sigue en la misma carpeta, porque el
 * correo de compra ya repartido enlaza a ella.
 */

const rutaDe = (id) => path.join(env.GUIAS_DIR, `${id}.pdf`);

/** Un PDF de verdad empieza por «%PDF-». Lo demás no se guarda. */
function comprobarPdf(archivo) {
  if (!Buffer.isBuffer(archivo) || archivo.length === 0) {
    throw new ValidationError('Falta el archivo PDF.');
  }
  if (archivo.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new ValidationError('Ese archivo no es un PDF.');
  }
}

/** El nombre del archivo, sin carpetas y recortado a lo que cabe en la columna. */
const nombreLimpio = (nombre) => path.basename(String(nombre ?? '').trim() || 'guia.pdf').slice(0, 200);

async function escribir(id, archivo) {
  await fs.mkdir(env.GUIAS_DIR, { recursive: true });
  await fs.writeFile(rutaDe(id), archivo);
}

async function buscar(id) {
  const fila = await prisma.guia.findUnique({ where: { id } });
  if (!fila) throw new NotFoundError('Esa guía no existe.');
  return fila;
}

/** «Guía de instalación» → «guia-de-instalacion.pdf», para el nombre de la descarga. */
function nombreDeDescarga(titulo) {
  const base = String(titulo)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return `${base || 'guia'}.pdf`;
}

const guiaService = {
  /** Lo que ve el visitante: solo lo visible y con PDF, en su orden. */
  listPublic() {
    return prisma.guia.findMany({
      where: { active: true, bytes: { gt: 0 } },
      orderBy: [{ orden: 'asc' }, { createdAt: 'asc' }],
    });
  },

  /** Lo que ve el panel: todo, incluido lo oculto. */
  listAll() {
    return prisma.guia.findMany({ orderBy: [{ orden: 'asc' }, { createdAt: 'asc' }] });
  },

  /**
   * Una guía nueva, con su PDF. Primero la fila (da el identificador) y luego el
   * disco; si el disco falla, la fila se quita para no dejar una guía sin archivo.
   */
  async create(datos, archivo, nombre) {
    comprobarPdf(archivo);
    const fila = await prisma.guia.create({
      data: { ...datos, archivoNombre: nombreLimpio(nombre), bytes: archivo.length },
    });
    try {
      await escribir(fila.id, archivo);
    } catch (error) {
      await prisma.guia.delete({ where: { id: fila.id } }).catch(() => {});
      throw error;
    }
    return fila;
  },

  async update(id, datos) {
    await buscar(id);
    return prisma.guia.update({ where: { id }, data: datos });
  },

  /** Cambia el PDF y deja la ficha como estaba. */
  async reemplazarArchivo(id, archivo, nombre) {
    comprobarPdf(archivo);
    await buscar(id);
    await escribir(id, archivo);
    return prisma.guia.update({
      where: { id },
      data: { archivoNombre: nombreLimpio(nombre), bytes: archivo.length },
    });
  },

  async remove(id) {
    await buscar(id);
    await prisma.guia.delete({ where: { id } });
    await fs.rm(rutaDe(id), { force: true });
    return { id };
  },

  /** Para descargarla: la ruta en disco y el nombre con el que se baja. Solo las visibles. */
  async paraDescargar(id) {
    const fila = await buscar(id);
    if (!fila.active || fila.bytes === 0) throw new NotFoundError('Esa guía no existe.');
    return { ruta: rutaDe(id), nombre: nombreDeDescarga(fila.titulo) };
  },
};

module.exports = { ...guiaService, comprobarPdf, nombreDeDescarga };
