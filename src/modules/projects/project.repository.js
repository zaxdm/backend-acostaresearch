'use strict';

const prisma = require('../../lib/prisma');

const proyectoSelect = {
  id: true,
  plantillaAt: true,
  plantillaNombre: true,
  productCode: true,
  tema: true,
  carrera: true,
  universidad: true,
  estiloCitas: true,
  idiomaCitas: true,
  ranura: true,
  nombre: true,
  activadaAt: true,
  createdAt: true,
  updatedAt: true,
};

/** La activa primero: la de fecha más reciente y, si empatan, la más nueva. */
const activaPrimero = [{ activadaAt: 'desc' }, { ranura: 'desc' }];

const etapaSelect = {
  skillCode: true,
  estado: true,
  resumen: true,
  datos: true,
  palabras: true,
  textoAt: true,
  updatedAt: true,
};

/**
 * El proyecto de este comprador para este método, con sus etapas.
 *
 * Devuelve nulo si todavía no existe, y eso es normal: el proyecto no se crea
 * al comprar, sino la primera vez que hay algo que recordar. Crear una fila
 * vacía a cada uno solo serviría para no distinguir «no ha empezado» de «no ha
 * comprado».
 *
 * Quien tiene varias tesis del mismo método (un administrador) recibe la
 * activa. Todo lo demás —el conector, el Word, la norma, borrar— trabaja sobre
 * lo que devuelve esto, así que elegir la activa en el panel lo cambia todo a
 * la vez.
 */
function buscar(userId, productCode) {
  return prisma.project.findFirst({
    where: { userId, productCode },
    orderBy: activaPrimero,
    select: {
      ...proyectoSelect,
      stages: { select: etapaSelect, orderBy: { updatedAt: 'desc' } },
    },
  });
}

/**
 * Crea el proyecto si no lo había, y actualiza lo que venga.
 *
 * Los campos que no vengan NO se tocan. Es la diferencia entre guardar el
 * avance de un capítulo y borrarle la universidad al tesista porque esa llamada
 * no la mencionaba.
 */
async function asegurar(userId, productCode, cambios = {}) {
  const limpio = {};
  for (const campo of ['tema', 'carrera', 'universidad', 'estiloCitas', 'idiomaCitas']) {
    if (cambios[campo] !== undefined && cambios[campo] !== null) limpio[campo] = cambios[campo];
  }

  const activa = await prisma.project.findFirst({
    where: { userId, productCode },
    orderBy: activaPrimero,
    select: { id: true },
  });
  if (activa) {
    return prisma.project.update({ where: { id: activa.id }, data: limpio, select: proyectoSelect });
  }

  // La primera nace en la ranura 0 con `upsert`, no con `create`: Claude llama a
  // varias herramientas a la vez, y dos que lleguen juntas a un tesista sin
  // proyecto crearían dos. Con la ranura única, la segunda actualiza la primera.
  return prisma.project.upsert({
    where: { userId_productCode_ranura: { userId, productCode, ranura: 0 } },
    create: { userId, productCode, ...limpio },
    update: limpio,
    select: proyectoSelect,
  });
}

/**
 * Abre otra tesis del mismo método y la deja activa. Solo para administradores:
 * eso lo decide la ruta, no esto.
 *
 * Va en la ranura siguiente a la más alta. Si dos peticiones chocan en la misma
 * ranura, la base rechaza la segunda por el índice único y se reintenta una vez.
 */
async function crearTesis(userId, productCode, nombre) {
  for (let intento = 0; ; intento += 1) {
    const { _max } = await prisma.project.aggregate({
      where: { userId, productCode },
      _max: { ranura: true },
    });
    const ranura = _max.ranura === null ? 0 : _max.ranura + 1;

    try {
      return await prisma.project.create({
        data: { userId, productCode, ranura, nombre, activadaAt: new Date() },
        select: proyectoSelect,
      });
    } catch (error) {
      if (error?.code !== 'P2002' || intento > 0) throw error;
    }
  }
}

/** Una tesis concreta, solo si es de esa persona y de ese método. */
function buscarTesis(userId, productCode, id) {
  return prisma.project.findFirst({
    where: { id, userId, productCode },
    select: proyectoSelect,
  });
}

/** Cuántas tesis tiene de ese método. */
function contarTesis(userId, productCode) {
  return prisma.project.count({ where: { userId, productCode } });
}

/** La deja activa. Devuelve cuántas filas tocó: 0 = no es suya. */
async function activarTesis(userId, productCode, id) {
  const { count } = await prisma.project.updateMany({
    where: { id, userId, productCode },
    data: { activadaAt: new Date() },
  });
  return count;
}

/** Borra la fila; sus etapas se van en cascada. El disco es cosa del servicio. */
async function eliminarTesis(userId, productCode, id) {
  const { count } = await prisma.project.deleteMany({ where: { id, userId, productCode } });
  return count;
}

/**
 * Escribe el avance de una etapa.
 *
 * Igual que arriba: lo que no venga se queda como estaba. Un asistente que
 * marca el capítulo como LISTO sin mandar resumen no puede llevarse por delante
 * el resumen que había.
 */
async function guardarEtapa(
  projectId,
  skillCode,
  { estado, resumen, datos, palabras, textoAt } = {},
) {
  const limpio = {};
  if (estado !== undefined && estado !== null) limpio.estado = estado;
  if (resumen !== undefined && resumen !== null) limpio.resumen = resumen;
  if (datos !== undefined && datos !== null) limpio.datos = datos;
  if (palabras !== undefined && palabras !== null) limpio.palabras = palabras;
  if (textoAt !== undefined && textoAt !== null) limpio.textoAt = textoAt;

  return prisma.projectStage.upsert({
    where: { projectId_skillCode: { projectId, skillCode } },
    create: { projectId, skillCode, ...limpio },
    update: limpio,
    select: etapaSelect,
  });
}

/**
 * Los métodos de los que tiene licencia vigente: activa y sin caducar.
 *
 * Es el mismo criterio con el que se acepta un análisis desde la web. Sirve al
 * panel para enseñar en blanco un método comprado que todavía no tiene nada
 * guardado —o que se acaba de borrar—, en vez de hacer como si no lo tuviera.
 */
async function productosConLicencia(userId) {
  const licencias = await prisma.license.findMany({
    where: {
      userId,
      status: 'ACTIVE',
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { productCode: true },
    distinct: ['productCode'],
  });
  return licencias.map((l) => l.productCode);
}

/** Para el panel del comprador: sus proyectos, sin las etapas. */
function listarDeUsuario(userId) {
  return prisma.project.findMany({
    where: { userId },
    select: {
      ...proyectoSelect,
      stages: { select: etapaSelect, orderBy: { updatedAt: 'desc' } },
    },
    orderBy: { updatedAt: 'desc' },
  });
}

/** Deja constancia de que subió (o quitó) la plantilla de su facultad. */
function marcarPlantilla(projectId, nombre) {
  return prisma.project.update({
    where: { id: projectId },
    data: { plantillaAt: nombre === null ? null : new Date(), plantillaNombre: nombre },
  });
}

/**
 * Deja el proyecto como recién creado: sin etapas y sin nada de lo que se
 * anotó. La fila se queda —es lo que hace que el panel siga enseñando el método
 * con sus fases en blanco—; lo demás, fuera, en una sola transacción.
 */
function reiniciar(projectId) {
  return prisma.$transaction([
    prisma.projectStage.deleteMany({ where: { projectId } }),
    prisma.project.update({
      where: { id: projectId },
      data: {
        tema: null,
        carrera: null,
        universidad: null,
        estiloCitas: null,
        idiomaCitas: null,
        plantillaAt: null,
        plantillaNombre: null,
      },
    }),
  ]);
}

/** El nombre del tesista, para la portada del Word. */
async function nombreDe(userId) {
  const usuario = await prisma.user.findUnique({
    where: { id: userId },
    select: { firstName: true, lastName: true },
  });
  if (!usuario) return null;
  return [usuario.firstName, usuario.lastName].filter(Boolean).join(' ') || null;
}

/**
 * El nombre de venta de cada producto, por su código.
 *
 * Gana el plan activo: un producto puede arrastrar planes viejos con nombres
 * antiguos, y el bueno es el del que está a la venta. Es el mismo criterio que
 * usa el panel para las licencias, para que la pestaña y la licencia se llamen
 * igual.
 */
async function nombresDeProducto(codigos) {
  const planes = await prisma.plan.findMany({
    where: { kind: 'LICENSE', productCode: { in: codigos } },
    select: { productCode: true, name: true, active: true },
  });

  const nombres = new Map();
  for (const plan of planes) {
    if (plan.active || !nombres.has(plan.productCode)) nombres.set(plan.productCode, plan.name);
  }
  return nombres;
}

module.exports = {
  buscar,
  asegurar,
  crearTesis,
  buscarTesis,
  contarTesis,
  activarTesis,
  eliminarTesis,
  guardarEtapa,
  listarDeUsuario,
  productosConLicencia,
  reiniciar,
  nombreDe,
  marcarPlantilla,
  nombresDeProducto,
};
