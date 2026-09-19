'use strict';

const prisma = require('../../lib/prisma');

/**
 * La conexión de Mendeley de cada tesista, y la limpieza de lo que ya no está.
 *
 * Mismo reparto que `zotero/biblioteca.repository`: las fuentes se escriben por
 * `references/propias.repository`, que sabe escribir la biblioteca de una
 * persona sin tocar el fondo de la casa. Aquí vive la conexión —tokens,
 * carpeta, cerrojo— y el borrado de lo que salió de la carpeta.
 */

/** Un cerrojo más viejo que esto es de un proceso que murió a media pasada. */
const MINUTOS_DE_CERROJO = 30;

/** El prefijo de `sourceRef` con el que se marcan las fuentes de su Mendeley. */
const prefijoDe = (profileId) => `mendeley:${profileId}:`;

const deUsuario = (userId) => prisma.mendeleyAccount.findUnique({ where: { userId } });

/**
 * Guarda la conexión recién autorizada.
 *
 * Si reconecta LA MISMA cuenta de Mendeley se conserva la carpeta elegida:
 * reconectar suele ser «se me caducó». Si es OTRA cuenta, la carpeta de la
 * anterior no existe en esta y se borra la elección.
 */
async function guardarConexion({ userId, profileId, displayName, accessTokenCipher, refreshTokenCipher, expiresAt }) {
  const anterior = await deUsuario(userId);
  const mismaCuenta = anterior?.profileId === profileId;

  const datos = {
    profileId,
    displayName,
    accessTokenCipher,
    refreshTokenCipher,
    expiresAt,
    lastError: null,
    runningSince: null,
    ...(mismaCuenta ? {} : { folderId: null, folderName: null, lastCount: 0 }),
  };

  return prisma.mendeleyAccount.upsert({
    where: { userId },
    update: datos,
    create: { userId, ...datos },
  });
}

/** Tras un refresco. El de refresco solo se cambia si Mendeley dio uno nuevo. */
function guardarTokens(userId, { accessTokenCipher, refreshTokenCipher, expiresAt }) {
  return prisma.mendeleyAccount.update({
    where: { userId },
    data: {
      accessTokenCipher,
      expiresAt,
      ...(refreshTokenCipher && { refreshTokenCipher }),
    },
  });
}

function elegirCarpeta(userId, { folderId, folderName }) {
  return prisma.mendeleyAccount.update({
    where: { userId },
    data: { folderId, folderName, lastError: null },
  });
}

function guardarPasada(userId, { lastCount }) {
  return prisma.mendeleyAccount.update({
    where: { userId },
    data: { lastCount, lastRunAt: new Date(), lastError: null },
  });
}

/** El fallo se guarda recortado: es para enseñárselo, no para depurar. */
function anotarFallo(userId, mensaje) {
  return prisma.mendeleyAccount.update({
    where: { userId },
    data: { lastError: String(mensaje).slice(0, 500), lastRunAt: new Date() },
  });
}

/** Toma el turno de esta persona con un UPDATE condicional, que es atómico. */
async function tomarElTurno(userId) {
  const caducado = new Date(Date.now() - MINUTOS_DE_CERROJO * 60 * 1000);

  const { count } = await prisma.mendeleyAccount.updateMany({
    where: {
      userId,
      OR: [{ runningSince: null }, { runningSince: { lt: caducado } }],
    },
    data: { runningSince: new Date() },
  });

  return count === 1;
}

function soltarElTurno(userId) {
  return prisma.mendeleyAccount.updateMany({ where: { userId }, data: { runningSince: null } });
}

/** Quién toca esta noche: los que eligieron qué traer. */
function conCarpeta() {
  return prisma.mendeleyAccount.findMany({
    where: { folderId: { not: null } },
    select: { userId: true },
    orderBy: { lastRunAt: 'asc' },
  });
}

/**
 * Borra las fuentes suyas de Mendeley que ya no están en lo elegido.
 *
 * Acotado por dueño, por el prefijo de SU cuenta y por origen: sin el dueño
 * vacía la biblioteca de otro; sin el prefijo, se lleva lo que subió de Scopus
 * o trajo de Zotero. Y nunca lo que ya cita en un capítulo: ver `citadas`.
 */
async function borrarLasQueYaNoEstan(userId, profileId, idsVivos, citadas = []) {
  const prefijo = prefijoDe(profileId);

  const { count } = await prisma.reference.deleteMany({
    where: {
      ownerUserId: userId,
      origin: 'MENDELEY',
      sourceRef: {
        startsWith: prefijo,
        notIn: idsVivos.map((id) => `${prefijo}${id}`),
      },
      ...(citadas.length > 0 && { ref: { notIn: citadas } }),
    },
  });

  return count;
}

function contarDeMendeley(userId, profileId) {
  return prisma.reference.count({
    where: { ownerUserId: userId, sourceRef: { startsWith: prefijoDe(profileId) } },
  });
}

/** Se va la conexión, NO las fuentes: están citadas en sus capítulos. */
function desconectar(userId) {
  return prisma.mendeleyAccount.deleteMany({ where: { userId } });
}

// ── El OAuth a medias ───────────────────────────────────────────────────────

function guardarEstado({ state, userId }) {
  return prisma.mendeleyOauthState.create({ data: { state, userId } });
}

/**
 * Recoge el `state` y lo borra en el mismo paso: el borrado decide quién se lo
 * queda si llegan dos vueltas con el mismo, y uno de hace más de dos horas ya
 * no vale.
 */
async function tomarEstado(state, horas = 2) {
  const fila = await prisma.mendeleyOauthState.findUnique({ where: { state } });
  if (!fila) return null;

  const { count } = await prisma.mendeleyOauthState.deleteMany({
    where: { state, createdAt: { gt: new Date(Date.now() - horas * 60 * 60 * 1000) } },
  });
  if (count !== 1) return null;

  return fila;
}

function limpiarEstadosViejos(horas = 2) {
  return prisma.mendeleyOauthState.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - horas * 60 * 60 * 1000) } },
  });
}

module.exports = {
  MINUTOS_DE_CERROJO,
  prefijoDe,
  deUsuario,
  guardarConexion,
  guardarTokens,
  elegirCarpeta,
  guardarPasada,
  anotarFallo,
  tomarElTurno,
  soltarElTurno,
  conCarpeta,
  borrarLasQueYaNoEstan,
  contarDeMendeley,
  desconectar,
  guardarEstado,
  tomarEstado,
  limpiarEstadosViejos,
};
