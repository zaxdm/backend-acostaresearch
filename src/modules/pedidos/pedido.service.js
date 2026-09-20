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
const { GRADOS, nombresDe } = require('../asesores/asesor.catalogo');

/**
 * Los encargos de revisión.
 *
 * EL TESISTA ELIGE Y EL ENCARGO VA DIRECTO
 * ----------------------------------------
 * No hay reparto desde la casa. El tesista entra al directorio, mira a quién
 * confiarle su capítulo y se lo manda; si lo eligió será por algo, y meter a un
 * administrador a bendecir esa decisión no añade criterio, añade espera.
 *
 * QUIEN ACEPTA ES EL ASESOR, Y HASTA ENTONCES NO VE EL DOCUMENTO
 * --------------------------------------------------------------
 * Mientras el encargo espera, el asesor ve el tema, el capítulo, la
 * universidad, el nivel y qué le preocupa al tesista: de sobra para saber si
 * puede con ello. El Word se le abre al aceptar.
 *
 * Esto no es una formalidad. Es lo que impide que alguien entre al directorio,
 * reciba encargos y se dedique a leer tesis ajenas sin comprometerse a nada: el
 * único modo de abrir un documento es hacerse responsable de revisarlo, y eso
 * queda registrado con su nombre y su fecha.
 *
 * LO QUE SIGUE SIENDO DE LA CASA
 * ------------------------------
 * Quién entra al directorio. Esa puerta se queda: el tesista elige entre
 * asesores comprobados, no entre desconocidos.
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

/** Cuántas reseñas hacen falta para que una media signifique algo. */
const RESENAS_PARA_NOTA = 3;

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

/** «Esteban Zait Dioses Muñoz» → «ED», para la tarjeta del directorio. */
function iniciales(nombre) {
  const partes = String(nombre ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (partes.length === 0) return '??';
  const primera = partes[0][0];
  const segunda = partes.length > 2 ? partes[2][0] : (partes[1]?.[0] ?? '');
  return `${primera}${segunda}`.toUpperCase();
}

const asesorPublicoSelect = {
  id: true,
  nombre: true,
  grado: true,
  especialidad: true,
  areas: true,
  metodos: true,
  universidades: true,
  anosExperiencia: true,
  presentacion: true,
};

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
  motivoRechazo: true,
  notas: true,
  asignadoAt: true,
  aceptadoAt: true,
  entregadoAt: true,
  createdAt: true,
  asesor: { select: { id: true, nombre: true, grado: true, especialidad: true, estado: true } },
  resena: { select: { estrellas: true, comentario: true, createdAt: true } },
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
 * La ficha pública de un asesor, con lo que decide una elección.
 *
 * La nota solo viaja cuando hay reseñas suficientes. Con una o dos, una media
 * dice más del azar que de la persona, y un 5,0 de un solo tesista parece
 * inflado: mientras tanto se enseña lo verificable, que es más difícil de
 * fingir que una estrella.
 */
function asesorPublico(fila, estadisticas = {}) {
  const resenas = estadisticas.resenas ?? 0;
  return {
    id: fila.id,
    nombre: fila.nombre,
    iniciales: iniciales(fila.nombre),
    grado: fila.grado,
    gradoNombre: GRADOS[fila.grado] ?? fila.grado,
    especialidad: fila.especialidad,
    areas: nombresDe(fila.areas, AREAS),
    areasCodigos: fila.areas.split(/[\s,;]+/).filter(Boolean),
    metodos: nombresDe(fila.metodos, METODOS),
    metodosCodigos: fila.metodos.split(/[\s,;]+/).filter(Boolean),
    universidades: fila.universidades,
    anosExperiencia: fila.anosExperiencia,
    presentacion: fila.presentacion,
    tesisRevisadas: estadisticas.entregados ?? 0,
    resenas,
    nota: resenas >= RESENAS_PARA_NOTA ? estadisticas.nota : null,
    ultimasResenas: estadisticas.ultimas ?? [],
  };
}

/** Lo que ve el tesista en /pedido/<codigo>. */
function salidaSeguimiento(fila) {
  const entregado = fila.estado === 'ENTREGADO';
  return {
    codigo: fila.codigo,
    nombre: fila.nombre,
    universidad: fila.universidad,
    capitulo: nombreDe(CAPITULOS, fila.capitulo),
    nivel: nombreDe(NIVELES, fila.nivel),
    tema: fila.tema,
    estado: fila.estado,
    archivoNombre: fila.archivoNombre,
    // Sí se le dice quién es: lo eligió él, y saber a quién está esperando es
    // la mitad de la tranquilidad mientras espera.
    asesor: fila.asesor
      ? {
          nombre: fila.asesor.nombre,
          iniciales: iniciales(fila.asesor.nombre),
          gradoNombre: GRADOS[fila.asesor.grado] ?? fila.asesor.grado,
          especialidad: fila.asesor.especialidad,
        }
      : null,
    motivoRechazo: fila.motivoRechazo,
    enlaceObservaciones: entregado ? fila.enlaceObservaciones : '',
    resena: fila.resena,
    /** ¿Le toca calificar? Entregado y sin haberlo hecho ya. */
    puedeResenar: entregado && !fila.resena,
    createdAt: fila.createdAt,
    aceptadoAt: fila.aceptadoAt,
    entregadoAt: fila.entregadoAt,
  };
}

/**
 * Lo que ve el asesor de un encargo suyo.
 *
 * Mientras espera su respuesta NO lleva el documento ni el contacto del
 * tesista: lo que hace falta para decidir si puede con ello, y nada más. Al
 * aceptar se le abre todo.
 */
function salidaParaAsesor(fila) {
  const aceptado = fila.estado === 'EN_REVISION' || fila.estado === 'ENTREGADO';
  return {
    id: fila.id,
    codigo: fila.codigo,
    estado: fila.estado,
    capitulo: nombreDe(CAPITULOS, fila.capitulo),
    nivel: nombreDe(NIVELES, fila.nivel),
    area: nombreDe(AREAS, fila.area),
    metodo: nombreDe(METODOS, fila.metodo),
    universidad: fila.universidad,
    tema: fila.tema,
    mensaje: fila.mensaje,
    archivoNombre: aceptado ? fila.archivoNombre : '',
    bytes: fila.bytes,
    tesista: aceptado ? { nombre: fila.nombre, email: fila.email, telefono: fila.telefono } : null,
    enlaceObservaciones: fila.enlaceObservaciones,
    resena: fila.resena,
    createdAt: fila.createdAt,
    aceptadoAt: fila.aceptadoAt,
    entregadoAt: fila.entregadoAt,
  };
}

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
 * Las notas y el trabajo hecho de cada asesor, en dos consultas.
 *
 * Aparte del listado y no dentro de él: pedirlo por asesor serían tantas
 * consultas como asesores, y el directorio es lo primero que ve un tesista.
 */
async function estadisticasDe(ids) {
  if (ids.length === 0) return new Map();

  const [entregados, notas, ultimas] = await Promise.all([
    prisma.pedido.groupBy({
      by: ['asesorId'],
      where: { asesorId: { in: ids }, estado: 'ENTREGADO' },
      _count: { _all: true },
    }),
    prisma.resena.groupBy({
      by: ['asesorId'],
      where: { asesorId: { in: ids } },
      _count: { _all: true },
      _avg: { estrellas: true },
    }),
    prisma.resena.findMany({
      where: { asesorId: { in: ids }, comentario: { not: '' } },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { asesorId: true, estrellas: true, comentario: true, createdAt: true },
    }),
  ]);

  const mapa = new Map(ids.map((id) => [id, { entregados: 0, resenas: 0, nota: null, ultimas: [] }]));
  for (const fila of entregados) {
    const actual = mapa.get(fila.asesorId);
    if (actual) actual.entregados = fila._count._all;
  }
  for (const fila of notas) {
    const actual = mapa.get(fila.asesorId);
    if (!actual) continue;
    actual.resenas = fila._count._all;
    actual.nota = fila._avg.estrellas === null ? null : Math.round(fila._avg.estrellas * 10) / 10;
  }
  for (const resena of ultimas) {
    const actual = mapa.get(resena.asesorId);
    // Tres por asesor: la tarjeta no es sitio para treinta.
    if (actual && actual.ultimas.length < 3) {
      actual.ultimas.push({
        estrellas: resena.estrellas,
        comentario: resena.comentario,
        createdAt: resena.createdAt,
      });
    }
  }
  return mapa;
}

/**
 * El directorio: entre quiénes elige el tesista.
 *
 * Solo aprobados y visibles. Se devuelven todos y filtra el navegador: con un
 * catálogo de esta talla, pedirle al servidor una consulta por cada clic en un
 * filtro es más lento de lo que tarda el navegador en repasar una lista corta.
 */
async function directorio(slug) {
  await puerta.ver(TIPO, slug);

  const filas = await prisma.asesor.findMany({
    where: { estado: 'APROBADO', visible: true },
    orderBy: [{ anosExperiencia: 'desc' }, { createdAt: 'asc' }],
    select: asesorPublicoSelect,
  });

  const estadisticas = await estadisticasDe(filas.map((fila) => fila.id));
  return filas.map((fila) => asesorPublico(fila, estadisticas.get(fila.id)));
}

/**
 * Entre quiénes puede elegir el tesista al que le dijeron que no.
 *
 * Por su código y no por el slug de la convocatoria: quien llega rechazado
 * viene de su página de seguimiento, donde lo único que tiene es el código. Y
 * sin el que ya lo rechazó, que sería ofrecerle volver a chocarse con la misma
 * puerta.
 */
async function directorioParaPedido(codigo) {
  const pedido = await prisma.pedido.findUnique({
    where: { codigo },
    select: { asesorId: true, estado: true },
  });
  if (!pedido) throw new NotFoundError('No encontramos ningún pedido con ese código.');

  const filas = await prisma.asesor.findMany({
    where: { estado: 'APROBADO', visible: true },
    orderBy: [{ anosExperiencia: 'desc' }, { createdAt: 'asc' }],
    select: asesorPublicoSelect,
  });

  const otros = filas.filter((fila) => fila.id !== pedido.asesorId);
  const estadisticas = await estadisticasDe(otros.map((fila) => fila.id));
  return otros.map((fila) => asesorPublico(fila, estadisticas.get(fila.id)));
}

/** Que ese asesor exista, esté aprobado y siga aceptando encargos. */
async function asesorElegible(asesorId) {
  const asesor = await prisma.asesor.findUnique({
    where: { id: asesorId },
    select: { id: true, nombre: true, estado: true, visible: true },
  });
  if (!asesor || asesor.estado !== 'APROBADO') {
    throw new NotFoundError('Ese asesor ya no está disponible. Elige otro.');
  }
  if (!asesor.visible) {
    throw new ConflictError(`${asesor.nombre.split(/\s+/)[0]} no está aceptando encargos ahora. Elige otro.`);
  }
  return asesor;
}

/**
 * Registra un encargo con su documento y se lo manda a su asesor.
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

  const asesor = await asesorElegible(datos.asesorId);
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
          asesorId: asesor.id,
          asignadoAt: new Date(),
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

  // Sin `await` y sin datos personales: lo justo para saber que el piloto se
  // está moviendo. Quien tiene que actuar es el asesor, no la casa.
  avisarAlAdmin({
    titulo: 'Encargo nuevo en el directorio',
    mensaje: `${nombreDe(CAPITULOS, pedido.capitulo)} · ${pedido.universidad} · esperando a ${
      asesor.nombre.split(/\s+/)[0]
    } · código ${pedido.codigo}`,
    etiquetas: ['page_facing_up'],
    prioridad: 3,
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

/**
 * Su asesor no pudo, y elige otro sin volver a subir nada.
 *
 * Es la salida de un rechazo. Sin esto, a quien le dicen que no tendría que
 * empezar otra vez —rellenar, buscar el archivo, subirlo— por algo que no hizo
 * él, y es justo el momento en el que se va a otra parte.
 */
async function reasignar(codigo, asesorId) {
  const pedido = await prisma.pedido.findUnique({
    where: { codigo },
    select: { id: true, estado: true, asesorId: true },
  });
  if (!pedido) throw new NotFoundError('No encontramos ningún pedido con ese código.');
  if (pedido.estado !== 'RECHAZADO') {
    throw new ConflictError('Este pedido ya está en marcha: no hace falta elegir otro asesor.');
  }
  if (asesorId === pedido.asesorId) {
    throw new ConflictError('Ese es el asesor que no pudo tomarlo. Elige otro.');
  }

  await asesorElegible(asesorId);

  const guardado = await prisma.pedido.update({
    where: { id: pedido.id },
    data: {
      asesorId,
      estado: 'ESPERANDO',
      motivoRechazo: '',
      asignadoAt: new Date(),
      aceptadoAt: null,
    },
    select: pedidoSelect,
  });
  return salidaSeguimiento(guardado);
}

/** La nota que pone el tesista. Una por pedido y solo si ya le entregaron. */
async function resenar(codigo, { estrellas, comentario }) {
  const pedido = await prisma.pedido.findUnique({
    where: { codigo },
    select: { id: true, estado: true, asesorId: true, resena: { select: { id: true } } },
  });
  if (!pedido) throw new NotFoundError('No encontramos ningún pedido con ese código.');
  if (pedido.estado !== 'ENTREGADO') {
    throw new ConflictError('Podrás calificar cuando recibas tus observaciones.');
  }
  if (pedido.resena) throw new ConflictError('Ya calificaste esta revisión.');
  if (!pedido.asesorId) throw new ConflictError('Este pedido ya no tiene asesor.');

  await prisma.resena.create({
    data: { pedidoId: pedido.id, asesorId: pedido.asesorId, estrellas, comentario },
  });

  const guardado = await prisma.pedido.findUnique({
    where: { id: pedido.id },
    select: pedidoSelect,
  });
  return salidaSeguimiento(guardado);
}

// ── El asesor, por su enlace privado ────────────────────────────────────────

/** De quién es este enlace. Sin token válido no hay nada que enseñar. */
async function asesorPorToken(token) {
  const asesor = await prisma.asesor.findUnique({
    where: { token },
    select: { id: true, nombre: true, estado: true, visible: true, especialidad: true, grado: true },
  });
  if (!asesor || asesor.estado !== 'APROBADO') {
    throw new NotFoundError('Ese enlace no existe o ya no está disponible.');
  }
  return asesor;
}

/** Su pantalla: quién es, si está aceptando encargos y todo lo que le llegó. */
async function panelDelAsesor(token) {
  const asesor = await asesorPorToken(token);

  const filas = await prisma.pedido.findMany({
    where: { asesorId: asesor.id, estado: { not: 'CANCELADO' } },
    orderBy: { createdAt: 'desc' },
    select: pedidoSelect,
  });

  const estadisticas = await estadisticasDe([asesor.id]);
  const suyas = estadisticas.get(asesor.id) ?? {};

  return {
    asesor: {
      nombre: asesor.nombre,
      iniciales: iniciales(asesor.nombre),
      gradoNombre: GRADOS[asesor.grado] ?? asesor.grado,
      especialidad: asesor.especialidad,
      visible: asesor.visible,
      tesisRevisadas: suyas.entregados ?? 0,
      resenas: suyas.resenas ?? 0,
      nota: (suyas.resenas ?? 0) >= RESENAS_PARA_NOTA ? suyas.nota : null,
    },
    encargos: filas.map(salidaParaAsesor),
  };
}

/** Apagarse cuando está lleno, sin que nadie tenga que rechazarlo. */
async function cambiarDisponibilidad(token, visible) {
  const asesor = await asesorPorToken(token);
  await prisma.asesor.update({ where: { id: asesor.id }, data: { visible } });
  return panelDelAsesor(token);
}

/** El encargo, comprobando que de verdad es suyo. */
async function encargoSuyo(asesorId, pedidoId) {
  const pedido = await prisma.pedido.findUnique({ where: { id: pedidoId }, select: pedidoSelect });
  if (!pedido || pedido.asesorId !== asesorId) throw new NotFoundError('Ese encargo no es tuyo.');
  return pedido;
}

/** Decir que sí. Es el momento en que se le abre el documento. */
async function aceptar(token, pedidoId) {
  const asesor = await asesorPorToken(token);
  const pedido = await encargoSuyo(asesor.id, pedidoId);
  if (pedido.estado !== 'ESPERANDO') {
    throw new ConflictError('Este encargo ya no está esperando respuesta.');
  }

  const guardado = await prisma.pedido.update({
    where: { id: pedido.id },
    data: { estado: 'EN_REVISION', aceptadoAt: new Date() },
    select: pedidoSelect,
  });
  return salidaParaAsesor(guardado);
}

/**
 * Decir que no, con el motivo.
 *
 * El motivo no es burocracia: al tesista le llega, y no es lo mismo «ahora
 * mismo no tengo hueco» —vuelve dentro de un mes— que «esto no es lo mío»
 * —elige a otro con otra especialidad—.
 */
async function rechazar(token, pedidoId, motivo) {
  const asesor = await asesorPorToken(token);
  const pedido = await encargoSuyo(asesor.id, pedidoId);
  if (pedido.estado !== 'ESPERANDO') {
    throw new ConflictError('Este encargo ya no está esperando respuesta.');
  }

  const guardado = await prisma.pedido.update({
    where: { id: pedido.id },
    data: { estado: 'RECHAZADO', motivoRechazo: motivo },
    select: pedidoSelect,
  });
  return salidaParaAsesor(guardado);
}

/**
 * Entregar: pegar el documento de observaciones y darlo por hecho.
 *
 * No se entrega sin ese enlace porque ese documento ES el encargo. Marcarlo sin
 * él le diría al tesista que ya está cuando no tiene nada que leer.
 */
async function entregar(token, pedidoId, enlaceObservaciones) {
  const asesor = await asesorPorToken(token);
  const pedido = await encargoSuyo(asesor.id, pedidoId);
  if (pedido.estado !== 'EN_REVISION') {
    throw new ConflictError('Solo se entrega un encargo que estés revisando.');
  }
  if (!enlaceObservaciones) {
    throw new ValidationError('Pega el enlace de tu documento de observaciones.');
  }

  const guardado = await prisma.pedido.update({
    where: { id: pedido.id },
    data: { estado: 'ENTREGADO', enlaceObservaciones, entregadoAt: new Date() },
    select: pedidoSelect,
  });

  avisarAlAdmin({
    titulo: 'Revisión entregada',
    mensaje: `${asesor.nombre.split(/\s+/)[0]} entregó el código ${guardado.codigo}`,
    etiquetas: ['white_check_mark'],
    prioridad: 2,
  });

  return salidaParaAsesor(guardado);
}

/**
 * El documento, para el asesor que lo aceptó.
 *
 * El freno está aquí y no solo en la pantalla: si dependiera de que el botón no
 * se dibuje, bastaría con adivinar la dirección para leer una tesis sin haberse
 * comprometido a revisarla.
 */
async function documentoParaAsesor(token, pedidoId) {
  const asesor = await asesorPorToken(token);
  const pedido = await encargoSuyo(asesor.id, pedidoId);
  if (pedido.estado !== 'EN_REVISION' && pedido.estado !== 'ENTREGADO') {
    throw new ConflictError('Acepta el encargo para poder abrir el documento.');
  }
  if (pedido.bytes === 0) throw new NotFoundError('Ese pedido no tiene documento.');

  return { ruta: rutaDe(pedido.id), nombre: `${pedido.codigo}-${pedido.archivoNombre}` };
}

// ── El panel de la casa ─────────────────────────────────────────────────────

/** Todos los pedidos, el más nuevo primero. Para mirar, no para repartir. */
async function listar() {
  const filas = await prisma.pedido.findMany({
    orderBy: { createdAt: 'desc' },
    select: pedidoSelect,
  });
  return filas.map(salida);
}

/**
 * Lo que la casa sí puede tocar: anotar y cancelar.
 *
 * Ya no asigna ni entrega: eso es del tesista y del asesor. Queda cancelar, que
 * es lo que hace falta cuando algo se tuerce y alguien tiene que poder pararlo.
 */
async function cambiar(id, cambios) {
  const actual = await prisma.pedido.findUnique({ where: { id }, select: { id: true } });
  if (!actual) throw new NotFoundError('Ese pedido no existe.');

  const datos = {};
  if (cambios.notas !== undefined) datos.notas = cambios.notas || null;
  if (cambios.estado === 'CANCELADO') datos.estado = 'CANCELADO';

  const pedido = await prisma.pedido.update({ where: { id }, data: datos, select: pedidoSelect });
  return salida(pedido);
}

/** El documento, para la casa. Hace falta cuando hay que dirimir algo. */
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
  directorio,
  directorioParaPedido,
  crear,
  seguimiento,
  reasignar,
  resenar,
  panelDelAsesor,
  cambiarDisponibilidad,
  aceptar,
  rechazar,
  entregar,
  documentoParaAsesor,
  listar,
  cambiar,
  paraDescargar,
  crearConvocatoria: (datos, adminId) => puerta.crear(TIPO, datos, adminId),
  cambiarConvocatoria: (id, cambios) => puerta.cambiar(id, cambios),
  listarConvocatorias: () => puerta.listar(TIPO),
};
