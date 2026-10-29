'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const env = require('../../config/env');
const logger = require('../../config/logger');
const prisma = require('../../lib/prisma');
const { Prisma } = require('@prisma/client');
const { NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const plantilla = require('../projects/project.plantilla');
const esquemaDeCapitulos = require('../projects/project.esquema');
const projectRepository = require('../projects/project.repository');
const projectService = require('../projects/project.service');
const skillService = require('../skills/skill.service');
const { perfilDe } = require('../productos/producto.perfil');
const busqueda = require('./formato.busqueda');

/**
 * La biblioteca de formatos de universidad (28-oct).
 *
 * TRES COSAS
 * ----------
 * 1. El administrador sube el .docx de cada universidad desde /admin, con sus
 *    otros nombres y, si hace falta, la facultad y el grado.
 * 2. Cada formato puede llevar los capítulos de la guía de esa universidad (un
 *    esquema, como el de `project.esquema`), que se copian al proyecto.
 * 3. La plantilla que sube un tesista entra aquí «por aprobar». Hasta que el
 *    administrador la revisa no se le ofrece a nadie, porque suele venir con
 *    la tesis de ejemplo —o la del propio tesista— en la portada.
 *
 * APLICAR ES SUBIRLA POR ÉL
 * -------------------------
 * Aplicar un formato es pasar su .docx por `projectService.guardarPlantilla`,
 * lo mismo que si el tesista lo hubiera subido: no hay otra forma de leer una
 * plantilla, y la portada se llena con SUS datos. Por eso se guarda el .docx y
 * no los estilos ya sacados.
 *
 * El archivo va a disco por el id; el nombre con que se subió solo se enseña.
 */

/** Cómo empieza el nombre del formato en un proyecto al que se le aplicó uno de aquí. */
const DE_LA_BIBLIOTECA = 'De la biblioteca';

const rutaDe = (id) => path.join(env.formatosDir, `${id}.docx`);

const nombreLimpio = (nombre) =>
  path.basename(String(nombre ?? '').trim() || 'formato.docx').slice(0, 200);

const huella = (archivo) => crypto.createHash('sha256').update(archivo).digest('hex');

/**
 * Que sea una plantilla que se puede leer: las mismas comprobaciones que la
 * subida del tesista, con sus mensajes. Mejor saberlo al subirla que cuando un
 * tesista la pide.
 */
function comprobarDocx(archivo) {
  if (!Buffer.isBuffer(archivo) || archivo.length === 0) {
    throw new ValidationError('Falta el archivo .docx.');
  }
  try {
    plantilla.extraerEstilos(archivo);
  } catch (error) {
    if (error instanceof plantilla.PlantillaNoValida) throw new ValidationError(error.message);
    throw error;
  }
}

async function escribir(id, archivo) {
  await fs.mkdir(env.formatosDir, { recursive: true });
  await fs.writeFile(rutaDe(id), archivo);
}

async function buscarFila(id) {
  const fila = await prisma.formatoUniversidad.findUnique({ where: { id } });
  if (!fila) throw new NotFoundError('Ese formato no existe.');
  return fila;
}

/** Lo que ve el panel: sin la huella, que no le dice nada a nadie. */
function salida(fila) {
  const { sha256: _sha256, ...resto } = fila;
  return { ...resto, etiqueta: busqueda.etiqueta(fila) };
}

/** Aprobado sin universidad no se encontraría nunca: se dice antes. */
function exigirUniversidad(fila) {
  if (fila.aprobado && !String(fila.universidad ?? '').trim()) {
    throw new ValidationError('Ponle el nombre de la universidad antes de aprobarlo.');
  }
}

/**
 * Los capítulos de la guía, comprobados contra el catálogo del método al que
 * se refieren. Vacío = sin esquema.
 */
async function comprobarEsquema(esquema, esquemaProducto) {
  if (!esquema || (esquema.capitulos ?? []).length === 0) return { esquema: null, esquemaProducto: null };
  if (!esquemaProducto) throw new ValidationError('Elige de qué método son las fases de los capítulos.');
  const catalogo = await skillService.listCatalog(esquemaProducto);
  try {
    esquemaDeCapitulos.normalizar(esquema, { catalogo });
  } catch (error) {
    if (error instanceof esquemaDeCapitulos.EsquemaNoValido) throw new ValidationError(error.message);
    throw error;
  }
  return { esquema: { capitulos: esquema.capitulos }, esquemaProducto };
}

/**
 * Las fases de trabajo no son capítulo, salvo el cuestionario y la bitácora,
 * que un reglamento puede pedir como anexo (ver `project.esquema`).
 */
const ANEXABLES = new Set(['instrumento-investigacion', 'recoleccion-datos']);
const cabeEnUnCapitulo = (code) => !esquemaDeCapitulos.FASES_DE_TRABAJO.has(code) || ANEXABLES.has(code);

/** Los métodos de tesis (y TSP) que se venden: a cuáles puede referirse un esquema. */
async function metodos() {
  const planes = await prisma.plan.findMany({
    where: { kind: 'LICENSE', productCode: { not: null } },
    select: { productCode: true, name: true },
    orderBy: { createdAt: 'asc' },
  });
  const porCodigo = new Map();
  for (const p of planes) {
    if (porCodigo.has(p.productCode)) continue;
    if (perfilDe(p.productCode).tipo !== 'tesis' || /^HUMANIZ/i.test(p.productCode)) continue;
    porCodigo.set(p.productCode, p.name);
  }
  const lista = [];
  for (const [productCode, nombre] of porCodigo) {
    const catalogo = await skillService.listCatalog(productCode);
    lista.push({
      productCode,
      nombre,
      fases: catalogo.filter((s) => cabeEnUnCapitulo(s.code)).map((s) => ({ code: s.code, nombre: s.displayName })),
    });
  }
  return lista;
}

const formatoService = {
  /** Todos, los por aprobar primero. */
  async listar() {
    const filas = await prisma.formatoUniversidad.findMany({
      orderBy: [{ aprobado: 'asc' }, { universidad: 'asc' }, { createdAt: 'desc' }],
    });
    return filas.map(salida);
  },

  metodos,

  /** Uno nuevo desde el panel: aprobado salvo que se diga lo contrario. */
  async crear(datos, archivo, nombre) {
    comprobarDocx(archivo);
    const ficha = { ...datos, aprobado: datos.aprobado ?? true };
    exigirUniversidad(ficha);
    const fila = await prisma.formatoUniversidad.create({
      data: { ...ficha, archivoNombre: nombreLimpio(nombre), bytes: archivo.length, sha256: huella(archivo) },
    });
    try {
      await escribir(fila.id, archivo);
    } catch (error) {
      await prisma.formatoUniversidad.delete({ where: { id: fila.id } }).catch(() => {});
      throw error;
    }
    return salida(fila);
  },

  /** La ficha, el esquema o aprobarlo. */
  async actualizar(id, datos) {
    const antes = await buscarFila(id);
    const cambios = { ...datos };
    if (datos.esquema !== undefined || datos.esquemaProducto !== undefined) {
      Object.assign(
        cambios,
        await comprobarEsquema(
          datos.esquema !== undefined ? datos.esquema : antes.esquema,
          datos.esquemaProducto !== undefined ? datos.esquemaProducto : antes.esquemaProducto,
        ),
      );
    }
    exigirUniversidad({ ...antes, ...cambios });
    // Prisma pide `Prisma.DbNull` para vaciar un Json; con `null` a secas falla.
    if (cambios.esquema === null) cambios.esquema = Prisma.DbNull;
    return salida(await prisma.formatoUniversidad.update({ where: { id }, data: cambios }));
  },

  /** Otro .docx para la misma ficha. Los proyectos que ya lo tienen no cambian. */
  async reemplazarArchivo(id, archivo, nombre) {
    comprobarDocx(archivo);
    await buscarFila(id);
    await escribir(id, archivo);
    return salida(
      await prisma.formatoUniversidad.update({
        where: { id },
        data: { archivoNombre: nombreLimpio(nombre), bytes: archivo.length, sha256: huella(archivo) },
      }),
    );
  },

  /** Borrar y rechazar son lo mismo: lo que no sirve no se guarda. */
  async borrar(id) {
    await buscarFila(id);
    await prisma.formatoUniversidad.delete({ where: { id } });
    await fs.rm(rutaDe(id), { force: true });
    return { id };
  },

  /** Para revisarlo en Word antes de aprobarlo. */
  async paraDescargar(id) {
    const fila = await buscarFila(id);
    return { ruta: rutaDe(id), nombre: fila.archivoNombre || 'formato.docx' };
  },

  /** Los aprobados de esa universidad (ver `formato.busqueda`). */
  async buscar({ universidad, grado = null }) {
    if (!busqueda.normalizar(universidad)) return [];
    const filas = await prisma.formatoUniversidad.findMany({
      where: { aprobado: true, bytes: { gt: 0 } },
    });
    return busqueda.buscar(filas, { universidad, grado }).map(salida);
  },

  /**
   * Pone un formato de la biblioteca en el proyecto del tesista.
   *
   * Reemplaza el que tuviera: a esto solo se llega si no tenía ninguno o si él
   * eligió este. El esquema solo si es de su mismo método y si todavía no
   * tiene uno: el que dictó en la conversación manda.
   *
   * Null si no tiene licencia de ese método. `esquema` dice qué pasó con los
   * capítulos: 'puesto', 'ya-tenia', 'otro-metodo', 'no-valido' o null (no traía).
   */
  async aplicar({ userId, productCode, formatoId }) {
    const fila = await prisma.formatoUniversidad.findUnique({ where: { id: formatoId } });
    if (!fila || !fila.aprobado || fila.bytes === 0) throw new NotFoundError('Ese formato no está en la biblioteca.');

    const archivo = await fs.readFile(rutaDe(fila.id));
    const nombre = `${DE_LA_BIBLIOTECA}: ${busqueda.etiqueta(fila)}`.slice(0, 200);
    const guardada = await projectService.guardarPlantilla({ userId, productCode, buffer: archivo, nombre });
    if (!guardada) return null;

    let esquema = null;
    if (fila.esquema?.capitulos?.length) {
      if (fila.esquemaProducto !== productCode) {
        esquema = 'otro-metodo';
      } else {
        const proyecto = await projectRepository.buscar(userId, productCode);
        if (esquemaDeCapitulos.tieneEsquema(proyecto?.esquema)) {
          esquema = 'ya-tenia';
        } else {
          try {
            await projectService.guardarEsquema({ userId, productCode, capitulos: fila.esquema.capitulos });
            esquema = 'puesto';
          } catch (error) {
            // El catálogo cambió desde que se escribió: el formato se queda igual.
            if (!(error instanceof esquemaDeCapitulos.EsquemaNoValido)) throw error;
            logger.warn({ formatoId, error: error.message }, 'El esquema de la biblioteca ya no vale');
            esquema = 'no-valido';
          }
        }
      }
    }

    await prisma.formatoUniversidad.update({ where: { id: fila.id }, data: { usos: { increment: 1 } } });
    return { formato: salida(fila), mensaje: guardada.mensaje, esquema };
  },

  /**
   * La plantilla que acaba de subir un tesista, a la cola «por aprobar».
   *
   * Solo de tesis y TSP: la plantilla de un informe es de un curso o de una
   * empresa, y la de un artículo, de una revista. Un archivo idéntico a otro
   * de la biblioteca no se vuelve a encolar, y si el mismo tesista sube otra,
   * la suya anterior sin revisar se sustituye. Nunca falla hacia fuera: la
   * subida del tesista ya está hecha y esto no puede estropeársela.
   */
  async proponerDesdeTesista({ userId, productCode, buffer, nombre }) {
    try {
      if (perfilDe(productCode).tipo !== 'tesis' || /^HUMANIZ/i.test(productCode)) return null;
      const sha256 = huella(buffer);
      if (await prisma.formatoUniversidad.findFirst({ where: { sha256 }, select: { id: true } })) return null;

      const proyecto = await projectRepository.buscar(userId, productCode);
      if (!proyecto) return null;

      const anteriores = await prisma.formatoUniversidad.findMany({
        where: { origenProjectId: proyecto.id, aprobado: false },
        select: { id: true },
      });
      for (const { id } of anteriores) await formatoService.borrar(id);

      const fila = await prisma.formatoUniversidad.create({
        data: {
          universidad: String(proyecto.universidad ?? '').slice(0, 160),
          notas: proyecto.carrera ? `Lo subió un tesista de ${proyecto.carrera}.`.slice(0, 600) : 'Lo subió un tesista.',
          archivoNombre: nombreLimpio(nombre),
          bytes: buffer.length,
          sha256,
          aprobado: false,
          origenProjectId: proyecto.id,
        },
      });
      try {
        await escribir(fila.id, buffer);
      } catch (error) {
        await prisma.formatoUniversidad.delete({ where: { id: fila.id } }).catch(() => {});
        throw error;
      }
      return fila.id;
    } catch (error) {
      // `warn` y no `error`: el error avisa al móvil, y esto no le impide nada a nadie.
      logger.warn({ error: error.message, productCode }, 'No se pudo encolar la plantilla en la biblioteca');
      return null;
    }
  },

  /** La universidad que tiene guardada su proyecto, o null. */
  async universidadDelProyecto(userId, productCode) {
    const proyecto = await projectRepository.buscar(userId, productCode);
    return proyecto?.universidad || null;
  },

  /** La guarda en su proyecto si todavía no tenía ninguna. */
  async recordarUniversidad(userId, productCode, universidad) {
    const limpia = String(universidad ?? '').trim().slice(0, 160);
    if (!limpia) return;
    const proyecto = await projectRepository.buscar(userId, productCode);
    if (proyecto?.universidad) return;
    await projectRepository.asegurar(userId, productCode, { universidad: limpia });
  },
};

module.exports = { ...formatoService, DE_LA_BIBLIOTECA, comprobarDocx, huella };
