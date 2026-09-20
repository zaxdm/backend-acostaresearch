'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const env = require('../../config/env');
const prisma = require('../../lib/prisma');
const { avisarAlAdmin } = require('../../lib/notify');
const {
  NotFoundError,
  ConflictError,
  ValidationError,
} = require('../../shared/errors/AppError');
const puerta = require('../convocatorias/convocatoria.service');
const { CAPITULOS, NIVELES, AREAS, METODOS, nombreDe, catalogos } = require('./pedido.catalogo');

/**
 * Los encargos de revisión: el capítulo que manda un tesista para que se lo
 * observen.
 *
 * QUÉ HACE LA PLATAFORMA Y QUÉ SE HACE A MANO
 * -------------------------------------------
 * La plataforma recibe el encargo, avisa, lo enseña en el panel y le cuenta al
 * tesista en qué va. La revisión en sí —la pasada de máquina y las
 * observaciones del asesor— se hace fuera, en un documento compartido, y aquí
 * solo se guarda su enlace. Es a propósito: construir el editor de
 * observaciones antes de saber si alguien manda su capítulo sería construir la
 * parte cara de un servicio que todavía no se sabe si existe.
 *
 * EL CÓDIGO ES LA LLAVE
 * ---------------------
 * El tesista consulta su pedido con él, sin cuenta. Por eso es aleatorio: un
 * correlativo deja leer el pedido de al lado sumando uno.
 */

const TIPO = 'REVISION';

/** Sin letras que se confundan al dictarlas por teléfono. */
const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789';
const LARGO_CODIGO = 8;

function generarCodigo() {
  let codigo = '';
  for (let i = 0; i < LARGO_CODIGO; i += 1) {
    codigo += ALFABETO[crypto.randomInt(0, ALFABETO.length)];
  }
  return codigo;
}

const rutaDe = (id) => path.join(env.pedidosDir, `${id}.docx`);

/**
 * Que lo subido sea un .docx de verdad.
 *
 * Un .docx es un zip, así que empieza por «PK». El .doc de Word 97 empieza por
 * otra cosa y se distingue aquí para poder decírselo: «no es un Word» sería
 * falso y dejaría al tesista sin saber qué hacer, cuando la salida es
 * guardarlo otra vez con el formato de ahora.
 */
function comprobarDocx(archivo, nombre) {
  if (!Buffer.isBuffer(archivo) || archivo.length === 0) {
    throw new ValidationError('Falta el documento. Adjunta tu archivo de Word.');
  }
  if (archivo.length > env.PEDIDO_MAX_BYTES) {
    const megas = Math.floor(env.PEDIDO_MAX_BYTES / (1024 * 1024));
    throw new ValidationError(`El documento pasa de ${megas} MB.`);
  }

  const firma = archivo.subarray(0, 4);
  if (firma.toString('hex') === 'd0cf11e0') {
    throw new ValidationError(
      'Ese archivo es un Word antiguo (.doc). Ábrelo y guárdalo como .docx, y vuelve a subirlo.',
    );
  }
  if (firma.subarray(0, 2).toString('latin1') !== 'PK') {
    throw new ValidationError('Ese archivo no es un documento de Word (.docx).');
  }
  if (!/\.docx$/i.test(String(nombre ?? ''))) {
    throw new ValidationError('Sube tu trabajo en Word (.docx).');
  }
}

/** Sin carpetas y recortado a lo que cabe en la columna. */
const nombreLimpio = (nombre) =>
  path.basename(String(nombre ?? '').trim() || 'documento.docx').slice(0, 200);

const pedidoSelect = {
  id: true,
  codigo: true,
  nombre: true,
  email: true,
  telefono: true,
  universidad: true,
  nivel: true,
  area: true,
  metodo: true,
  capitulo: true,
  tema: true,
  mensaje: true,
  archivoNombre: true,
  bytes: true,
  estado: true,
  asesorId: true,
  enlaceObservaciones: true,
  notas: true,
  asignadoAt: true,
  entregadoAt: true,
  createdAt: true,
  asesor: { select: { id: true, nombre: true, estado: true } },
};

/** El pedido como lo lee el panel: los códigos, ya traducidos. */
const salida = (fila) => ({
  ...fila,
  nivelNombre: nombreDe(NIVELES, fila.nivel),
  areaNombre: nombreDe(AREAS, fila.area),
  metodoNombre: nombreDe(METODOS, fila.metodo),
  capituloNombre: nombreDe(CAPITULOS, fila.capitulo),
});

/**
 * Lo que ve el tesista en /pedido/<codigo>.
 *
 * NO LLEVA QUIÉN SE LO ESTÁ REVISANDO. Durante el piloto el asesor es anónimo
 * para él: no tiene nada que hacer con ese nombre salvo escribirle por fuera, y
 * el encargo se contrató con la plataforma. Tampoco van las notas internas, que
 * están escritas para nosotros.
 */
const salidaSeguimiento = (fila) => ({
  codigo: fila.codigo,
  nombre: fila.nombre,
  universidad: fila.universidad,
  capitulo: nombreDe(CAPITULOS, fila.capitulo),
  nivel: nombreDe(NIVELES, fila.nivel),
  estado: fila.estado,
  archivoNombre: fila.archivoNombre,
  enlaceObservaciones: fila.estado === 'ENTREGADO' ? fila.enlaceObservaciones : '',
  createdAt: fila.createdAt,
  entregadoAt: fila.entregadoAt,
});

/** Lo que necesita el formulario del tesista: la puerta más los catálogos. */
async function verConvocatoria(slug) {
  return { ...(await puerta.ver(TIPO, slug)), catalogos: catalogos() };
}

/** La convocatoria de revisión abierta al público, si la hay. */
async function convocatoriaPublica() {
  const convocatoria = await puerta.publica(TIPO);
  return convocatoria ? { ...convocatoria, catalogos: catalogos() } : null;
}

/**
 * Registra un encargo con su documento.
 *
 * Primero la fila —que da el identificador y el código— y luego el disco. Si el
 * disco falla, la fila se quita: un pedido sin documento es un tesista que cree
 * que mandó su capítulo y no mandó nada.
 */
async function crear(slug, datos, archivo, nombreArchivo) {
  const convocatoria = await puerta.paraEnviar(TIPO, slug);
  if (!convocatoria) throw new NotFoundError('Ese enlace no existe o ya no está disponible.');
  if (!convocatoria.abierta) {
    throw new ConflictError('Ahora mismo no estamos recibiendo trabajos por este enlace.');
  }

  comprobarDocx(archivo, nombreArchivo);

  let pedido;
  // Ocho caracteres de 31 son cuarenta bits: un choque es improbable, pero
  // improbable no es imposible y perder un pedido por eso no tiene excusa.
  for (let intento = 0; intento < 5 && !pedido; intento += 1) {
    try {
      pedido = await prisma.pedido.create({
        data: {
          codigo: generarCodigo(),
          nombre: datos.nombre,
          email: datos.email,
          telefono: datos.telefono,
          universidad: datos.universidad,
          nivel: datos.nivel,
          area: datos.area,
          metodo: datos.metodo,
          capitulo: datos.capitulo,
          tema: datos.tema,
          mensaje: datos.mensaje,
          archivoNombre: nombreLimpio(nombreArchivo),
          bytes: archivo.length,
        },
        select: pedidoSelect,
      });
    } catch (error) {
      if (error?.code !== 'P2002') throw error;
    }
  }
  if (!pedido) throw new ConflictError('No se pudo registrar tu pedido. Inténtalo otra vez.');

  try {
    await fs.mkdir(env.pedidosDir, { recursive: true });
    await fs.writeFile(rutaDe(pedido.id), archivo);
  } catch (error) {
    await prisma.pedido.delete({ where: { id: pedido.id } }).catch(() => {});
    throw error;
  }

  // Sin `await` y sin datos personales, como el resto de avisos: lo justo para
  // decidir si merece la pena mirarlo ahora.
  avisarAlAdmin({
    titulo: 'Nuevo capítulo para revisar',
    mensaje: `${nombreDe(CAPITULOS, pedido.capitulo)} · ${nombreDe(NIVELES, pedido.nivel)} · ${
      pedido.universidad
    } · código ${pedido.codigo}`,
    etiquetas: ['page_facing_up'],
    prioridad: 4,
  });

  return salida(pedido);
}

/** El estado de un pedido, por su código. Sin sesión: el código es la llave. */
async function seguimiento(codigo) {
  const pedido = await prisma.pedido.findUnique({ where: { codigo }, select: pedidoSelect });
  if (!pedido || pedido.estado === 'CANCELADO') {
    throw new NotFoundError('No encontramos ningún pedido con ese código.');
  }
  return salidaSeguimiento(pedido);
}

/** Todos los pedidos, el más nuevo primero. */
async function listar() {
  const filas = await prisma.pedido.findMany({
    orderBy: { createdAt: 'desc' },
    select: pedidoSelect,
  });
  return filas.map(salida);
}

/**
 * Asignar, entregar, anotar.
 *
 * Dos automatismos que ahorran tocar el mismo pedido dos veces: asignarle un
 * asesor a uno recién recibido lo pone en revisión —para el tesista es lo
 * mismo—, y entregar sella la fecha.
 *
 * Y un freno: no se entrega sin el documento de observaciones. Ese documento ES
 * el encargo; marcar «entregado» sin él le diría al tesista que ya está cuando
 * no tiene nada que leer.
 */
async function cambiar(id, cambios) {
  const actual = await prisma.pedido.findUnique({
    where: { id },
    select: { id: true, estado: true, asesorId: true, enlaceObservaciones: true },
  });
  if (!actual) throw new NotFoundError('Ese pedido no existe.');

  const datos = {};
  if (cambios.notas !== undefined) datos.notas = cambios.notas || null;
  if (cambios.enlaceObservaciones !== undefined) {
    datos.enlaceObservaciones = cambios.enlaceObservaciones;
  }

  if (cambios.asesorId !== undefined) {
    const asesorId = cambios.asesorId || null;
    if (asesorId) {
      const asesor = await prisma.asesor.findUnique({
        where: { id: asesorId },
        select: { id: true, estado: true },
      });
      if (!asesor) throw new NotFoundError('Ese asesor no existe.');
      // Solo los aprobados: asignarle un encargo a quien todavía no se ha
      // comprobado es saltarse el filtro que justifica todo lo demás.
      if (asesor.estado !== 'APROBADO') {
        throw new ConflictError('Ese asesor todavía no está aprobado.');
      }
    }
    datos.asesorId = asesorId;
    datos.asignadoAt = asesorId ? (actual.asesorId === asesorId ? undefined : new Date()) : null;
  }

  const estado = cambios.estado ?? (datos.asesorId && actual.estado === 'RECIBIDO' ? 'EN_REVISION' : undefined);
  if (estado) {
    if (estado === 'ENTREGADO') {
      const enlace = datos.enlaceObservaciones ?? actual.enlaceObservaciones;
      if (!enlace) {
        throw new ValidationError(
          'No puedes entregar un pedido sin el documento de observaciones: pega su enlace primero.',
        );
      }
    }
    datos.estado = estado;
    datos.entregadoAt = estado === 'ENTREGADO' ? new Date() : null;
  }

  const pedido = await prisma.pedido.update({ where: { id }, data: datos, select: pedidoSelect });
  return salida(pedido);
}

/** El documento que subió, para que el panel se lo pueda bajar. */
async function paraDescargar(id) {
  const pedido = await prisma.pedido.findUnique({
    where: { id },
    select: { id: true, codigo: true, archivoNombre: true, bytes: true },
  });
  if (!pedido || pedido.bytes === 0) throw new NotFoundError('Ese pedido no tiene documento.');

  return { ruta: rutaDe(pedido.id), nombre: `${pedido.codigo}-${pedido.archivoNombre}` };
}

module.exports = {
  verConvocatoria,
  convocatoriaPublica,
  crear,
  seguimiento,
  listar,
  cambiar,
  paraDescargar,
  crearConvocatoria: (datos, adminId) => puerta.crear(TIPO, datos, adminId),
  cambiarConvocatoria: (id, cambios) => puerta.cambiar(id, cambios),
  listarConvocatorias: () => puerta.listar(TIPO),
};
