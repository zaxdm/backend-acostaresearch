'use strict';

const crypto = require('node:crypto');

const env = require('../../config/env');
const prisma = require('../../lib/prisma');
const { avisarDelPiloto } = require('../pedidos/beta');
const { NotFoundError, ConflictError } = require('../../shared/errors/AppError');
const puerta = require('../convocatorias/convocatoria.service');
const {
  AREAS,
  METODOS,
  GRADOS,
  DOCUMENTOS,
  guardarLista,
  nombresDe,
  catalogos,
} = require('./asesor.catalogo');

/**
 * El registro de asesores.
 *
 * DOS INTERRUPTORES, NO UN DESPLIEGUE
 * -----------------------------------
 * `abierta` dice si la convocatoria admite fichas; `publica`, si se llega a
 * ella sin el enlace. El piloto arranca abierta y no pública: el formulario
 * está desplegado y funcionando, pero solo entra quien recibe el slug. Abrirlo
 * al público es marcar `publica` en el panel, no volver a desplegar.
 *
 * NADIE SE AUTOPUBLICA
 * --------------------
 * Toda ficha nace PENDIENTE. Que alguien rellene el formulario no lo convierte
 * en asesor: lo convierte en candidato. Quien decide es el administrador, y lo
 * hace después de comprobar el grado en SUNEDU.
 */

/**
 * La puerta —el enlace, los dos interruptores— vive en
 * `modules/convocatorias`, compartida con los pedidos de revisión: es la misma
 * mecánica para los dos lados del servicio. Aquí solo se le pasa el tipo.
 */
const TIPO = 'ASESORES';

/** La página que se reparte a los candidatos. */
const urlDeLaConvocatoria = (slug) => puerta.urlDe(TIPO, slug);

const asesorSelect = {
  id: true,
  convocatoriaId: true,
  nombre: true,
  tipoDocumento: true,
  numeroDocumento: true,
  email: true,
  telefono: true,
  grado: true,
  gradoUniversidad: true,
  gradoAnio: true,
  registroSunedu: true,
  enlaceCv: true,
  areas: true,
  metodos: true,
  especialidad: true,
  universidades: true,
  anosExperiencia: true,
  presentacion: true,
  aceptaReglas: true,
  estado: true,
  notas: true,
  visible: true,
  token: true,
  revisadoAt: true,
  createdAt: true,
};

/**
 * Su llave privada: la pantalla donde ve sus encargos y los entrega.
 *
 * Se le da al aprobarlo. Es un enlace y no una cuenta porque el encargo le
 * llega directo del tesista, sin pasar por nadie, y para eso tiene que poder
 * entrar hoy: montarle registro y contraseña para que dos asesores revisen
 * tesis es construir el edificio antes de saber si alguien va a vivir en él.
 */
const urlDelPanel = (token) =>
  token ? `${env.APP_URL.replace(/\/+$/, '')}/asesor/${token}` : '';

/** La ficha como la lee el panel: los códigos, ya traducidos. */
const salida = (fila) => ({
  ...fila,
  enlacePanel: urlDelPanel(fila.token),
  areas: nombresDe(fila.areas, AREAS),
  metodos: nombresDe(fila.metodos, METODOS),
  gradoNombre: GRADOS[fila.grado] ?? fila.grado,
  documentoNombre: DOCUMENTOS[fila.tipoDocumento]?.etiqueta ?? fila.tipoDocumento,
});

/** La convocatoria como la ve el panel, con lo que lleva recibido. */
function salidaConvocatoria(fila, conteo = {}) {
  return {
    ...fila,
    fichas: conteo.total ?? 0,
    pendientes: conteo.pendientes ?? 0,
  };
}

/** Lo que necesita la página del candidato: la puerta más el catálogo. */
async function verConvocatoria(slug) {
  return { ...(await puerta.ver(TIPO, slug)), catalogos: catalogos() };
}

/** La convocatoria de asesores abierta al público, si la hay. */
async function convocatoriaPublica() {
  const convocatoria = await puerta.publica(TIPO);
  return convocatoria ? { ...convocatoria, catalogos: catalogos() } : null;
}

/** Registra una ficha. Nace PENDIENTE: lo demás lo decide el panel. */
async function postular(slug, datos) {
  const convocatoria = await puerta.paraEnviar(TIPO, slug);
  if (!convocatoria) throw new NotFoundError('Ese enlace no existe o ya no está disponible.');
  if (!convocatoria.abierta) throw new ConflictError('Esta convocatoria ya no recibe fichas.');

  let asesor;
  try {
    asesor = await prisma.asesor.create({
      data: {
        convocatoriaId: convocatoria.id,
        nombre: datos.nombre,
        tipoDocumento: datos.tipoDocumento,
        numeroDocumento: datos.numeroDocumento,
        email: datos.email,
        telefono: datos.telefono,
        grado: datos.grado,
        gradoUniversidad: datos.gradoUniversidad,
        gradoAnio: datos.gradoAnio,
        registroSunedu: datos.registroSunedu,
        enlaceCv: datos.enlaceCv,
        areas: guardarLista(datos.areas, AREAS),
        metodos: guardarLista(datos.metodos, METODOS),
        especialidad: datos.especialidad,
        universidades: datos.universidades,
        anosExperiencia: datos.anosExperiencia,
        presentacion: datos.presentacion,
        aceptaReglas: datos.aceptaReglas,
      },
      select: asesorSelect,
    });
  } catch (error) {
    // El correo es único: quien insiste corrige la suya, no abre otra.
    if (error?.code === 'P2002') {
      throw new ConflictError(
        'Ya recibimos una ficha con ese correo. Escríbenos si quieres cambiarla.',
      );
    }
    throw error;
  }

  // Sin `await`: que su ficha quede registrada no puede depender de que el
  // servidor de avisos conteste. Y va sin correo ni documento, como el resto
  // de avisos: lo justo para decidir si merece la pena mirarlo ahora.
  const areasDichas = nombresDe(asesor.areas, AREAS).join(', ') || 'sin área';
  avisarDelPiloto({
    titulo: 'Nueva ficha de asesor',
    mensaje: `${asesor.nombre.split(/\s+/)[0]} · ${GRADOS[asesor.grado] ?? asesor.grado} · ${areasDichas}`,
    etiquetas: ['mortar_board'],
    prioridad: 3,
  });

  return salida(asesor);
}

/** Lo que se escribe de una ficha, venga de una postulación o de un alta. */
const camposDeLaFicha = (datos) => ({
  nombre: datos.nombre,
  tipoDocumento: datos.tipoDocumento,
  numeroDocumento: datos.numeroDocumento,
  email: datos.email,
  telefono: datos.telefono,
  grado: datos.grado,
  gradoUniversidad: datos.gradoUniversidad,
  gradoAnio: datos.gradoAnio,
  registroSunedu: datos.registroSunedu,
  enlaceCv: datos.enlaceCv,
  areas: guardarLista(datos.areas, AREAS),
  metodos: guardarLista(datos.metodos, METODOS),
  especialidad: datos.especialidad,
  universidades: datos.universidades,
  anosExperiencia: datos.anosExperiencia,
  presentacion: datos.presentacion,
  aceptaReglas: datos.aceptaReglas,
});

/** Un correo, una ficha. El choque se cuenta en palabras, no en códigos. */
function siEsCorreoRepetido(error) {
  if (error?.code === 'P2002') {
    return new ConflictError('Ya hay una ficha con ese correo.');
  }
  return error;
}

/**
 * Dar de alta a un asesor a mano, desde el panel.
 *
 * POR QUÉ NACE APROBADO
 * ---------------------
 * Porque no se postuló: se le llamó. El estado PENDIENTE existe para lo que
 * llega solo y hay que comprobar; una ficha que escribe el propio
 * administrador, de alguien a quien ya conoce, no tiene a quién esperar. Que
 * pasara por «pendiente» para que él mismo se la aprobara acto seguido sería un
 * trámite consigo mismo.
 *
 * Y nace con su enlace, que es lo único que hay que mandarle después.
 */
async function darDeAlta(datos, adminId) {
  let asesor;
  try {
    asesor = await prisma.asesor.create({
      data: {
        ...camposDeLaFicha(datos),
        // Sin convocatoria: no vino por ninguna.
        convocatoriaId: null,
        estado: 'APROBADO',
        visible: true,
        token: crypto.randomBytes(24).toString('hex'),
        revisadoAt: new Date(),
        revisadoPorId: adminId ?? null,
      },
      select: asesorSelect,
    });
  } catch (error) {
    throw siEsCorreoRepetido(error);
  }
  return salida(asesor);
}

/** Corregir sus datos. Lo que sale en su tarjeta se escribe aquí. */
async function editarFicha(id, datos) {
  const existe = await prisma.asesor.findUnique({ where: { id }, select: { id: true } });
  if (!existe) throw new NotFoundError('Esa ficha no existe.');

  try {
    const asesor = await prisma.asesor.update({
      where: { id },
      data: camposDeLaFicha(datos),
      select: asesorSelect,
    });
    return salida(asesor);
  } catch (error) {
    throw siEsCorreoRepetido(error);
  }
}

/**
 * Rehacer su enlace.
 *
 * Su enlace es su llave: no hay contraseña detrás. Si se le escapa —lo reenvía,
 * lo pega donde no debe—, esto es lo que lo apaga. El viejo deja de valer en
 * cuanto se hace el nuevo, así que hay que volver a mandárselo.
 */
async function rehacerEnlace(id) {
  const existe = await prisma.asesor.findUnique({
    where: { id },
    select: { id: true, estado: true },
  });
  if (!existe) throw new NotFoundError('Esa ficha no existe.');
  if (existe.estado !== 'APROBADO') {
    throw new ConflictError('Solo los asesores aprobados tienen enlace.');
  }

  const asesor = await prisma.asesor.update({
    where: { id },
    data: { token: crypto.randomBytes(24).toString('hex') },
    select: asesorSelect,
  });
  return salida(asesor);
}

/** Todas las fichas, la más nueva primero. */
async function listar() {
  const filas = await prisma.asesor.findMany({
    orderBy: { createdAt: 'desc' },
    select: asesorSelect,
  });
  return filas.map(salida);
}

/**
 * Aprobar, rechazar o devolver a pendiente.
 *
 * Se puede volver atrás a propósito: un grado que no se pudo comprobar hoy se
 * comprueba mañana, y obligar a rechazar para poder revisar otra vez haría que
 * nadie rechazara nunca.
 */
async function revisar(id, { estado, notas, visible }, adminId) {
  const existe = await prisma.asesor.findUnique({ where: { id }, select: { id: true, token: true } });
  if (!existe) throw new NotFoundError('Esa ficha no existe.');

  const pendiente = estado === 'PENDIENTE';
  const asesor = await prisma.asesor.update({
    where: { id },
    data: {
      estado,
      notas: notas || null,
      revisadoAt: pendiente ? null : new Date(),
      revisadoPorId: pendiente ? null : (adminId ?? null),
      // Aprobarlo es darle la llave. Si ya tenía una, se respeta: rehacerla a
      // cada aprobación dejaría muerto el enlace que ya le mandaste.
      token: estado === 'APROBADO' && !existe.token ? crypto.randomBytes(24).toString('hex') : undefined,
      // Y vuelve al directorio, por si se le había apagado. Si el panel manda
      // uno explícito, manda ese: es lo que permite sacarlo sin rechazarlo.
      visible: visible ?? (estado === 'APROBADO' ? true : undefined),
    },
    select: asesorSelect,
  });

  return salida(asesor);
}

/** Las convocatorias de asesores, con cuántas fichas lleva cada una. */
async function listarConvocatorias() {
  const filas = await puerta.listar(TIPO);

  const porConvocatoria = await prisma.asesor.groupBy({
    by: ['convocatoriaId', 'estado'],
    _count: { _all: true },
  });

  const conteo = new Map();
  for (const fila of porConvocatoria) {
    const actual = conteo.get(fila.convocatoriaId) ?? { total: 0, pendientes: 0 };
    actual.total += fila._count._all;
    if (fila.estado === 'PENDIENTE') actual.pendientes += fila._count._all;
    conteo.set(fila.convocatoriaId, actual);
  }

  return filas.map((fila) => salidaConvocatoria(fila, conteo.get(fila.id)));
}

/** Una convocatoria nueva. Nace abierta y NO pública: el enlace es la llave. */
async function crearConvocatoria({ nombre, intro }, adminId) {
  return salidaConvocatoria(await puerta.crear(TIPO, { nombre, intro }, adminId));
}

/** Cerrarla, abrirla o hacerla pública. Lo que no venga, no se toca. */
async function cambiarConvocatoria(id, cambios) {
  return salidaConvocatoria(await puerta.cambiar(id, cambios));
}

module.exports = {
  darDeAlta,
  editarFicha,
  rehacerEnlace,
  verConvocatoria,
  convocatoriaPublica,
  postular,
  listar,
  revisar,
  listarConvocatorias,
  crearConvocatoria,
  cambiarConvocatoria,
  urlDeLaConvocatoria,
};