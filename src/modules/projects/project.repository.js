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
  createdAt: true,
  updatedAt: true,
};

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
 */
function buscar(userId, productCode) {
  return prisma.project.findUnique({
    where: { userId_productCode: { userId, productCode } },
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

  return prisma.project.upsert({
    where: { userId_productCode: { userId, productCode } },
    create: { userId, productCode, ...limpio },
    update: limpio,
    select: proyectoSelect,
  });
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
  guardarEtapa,
  listarDeUsuario,
  productosConLicencia,
  reiniciar,
  nombreDe,
  marcarPlantilla,
  nombresDeProducto,
};
