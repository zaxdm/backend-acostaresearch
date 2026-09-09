'use strict';

const prisma = require('../../lib/prisma');

const proyectoSelect = {
  id: true,
  productCode: true,
  tema: true,
  carrera: true,
  universidad: true,
  createdAt: true,
  updatedAt: true,
};

const etapaSelect = {
  skillCode: true,
  estado: true,
  resumen: true,
  datos: true,
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
  for (const campo of ['tema', 'carrera', 'universidad']) {
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
async function guardarEtapa(projectId, skillCode, { estado, resumen, datos } = {}) {
  const limpio = {};
  if (estado !== undefined && estado !== null) limpio.estado = estado;
  if (resumen !== undefined && resumen !== null) limpio.resumen = resumen;
  if (datos !== undefined && datos !== null) limpio.datos = datos;

  return prisma.projectStage.upsert({
    where: { projectId_skillCode: { projectId, skillCode } },
    create: { projectId, skillCode, ...limpio },
    update: limpio,
    select: etapaSelect,
  });
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

module.exports = { buscar, asegurar, guardarEtapa, listarDeUsuario };
