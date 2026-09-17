'use strict';

const prisma = require('../../lib/prisma');

/**
 * La conexión de Scopus de cada tesista, y el intercambio a medias.
 *
 * Las fuentes NO se escriben aquí. Van por `references/propias.repository`,
 * igual que su export de Scopus y que su Zotero: es el único archivo que sabe
 * escribir la biblioteca de UNA persona sin poder tocar el fondo de la casa, y
 * tener una segunda forma de escribir en `references` sería tener una segunda
 * forma de equivocarse con el dueño.
 *
 * Aquí vive la conexión y nada más.
 */

const deUsuario = (userId) => prisma.scopusConnection.findUnique({ where: { userId } });

/**
 * Guarda la conexión recién autorizada.
 *
 * `imported` NO se toca al reconectar. Reconectar suele ser «se me caducó» o
 * «cambié de cuenta», y poner a cero lo que ya trajo le diría que perdió sus
 * fuentes, que siguen exactamente donde estaban.
 */
function guardarConexion({
  userId,
  mode,
  scopusUserId = null,
  scopusName = null,
  accessTokenCipher = null,
  refreshTokenCipher = null,
  expiresAt = null,
}) {
  const datos = {
    mode,
    scopusUserId,
    scopusName,
    accessTokenCipher,
    refreshTokenCipher,
    expiresAt,
    status: 'ACTIVA',
    lastError: null,
  };

  return prisma.scopusConnection.upsert({
    where: { userId },
    update: datos,
    create: { userId, ...datos },
  });
}

/** Tokens nuevos tras un refresco. Elsevier puede no mandar uno de refresco nuevo. */
function guardarTokens(userId, { accessTokenCipher, refreshTokenCipher, expiresAt }) {
  return prisma.scopusConnection.update({
    where: { userId },
    data: {
      accessTokenCipher,
      // Sin uno nuevo se conserva el que había: muchos servidores solo lo
      // devuelven la primera vez, y pisarlo con null deja la conexión sin
      // forma de renovarse cuando venza el siguiente de acceso.
      ...(refreshTokenCipher ? { refreshTokenCipher } : {}),
      expiresAt,
      status: 'ACTIVA',
      lastError: null,
    },
  });
}

/**
 * La conexión dejó de valer.
 *
 * CADUCADA se arregla volviendo a pulsar el botón; REVOCADA no —Elsevier
 * retiró el permiso— y por eso se distinguen: el panel le dice una cosa u otra
 * y no le manda a reintentar algo que va a fallar igual.
 */
function anotarFallo(userId, mensaje, status = 'CADUCADA') {
  return prisma.scopusConnection.updateMany({
    where: { userId },
    data: { status, lastError: String(mensaje).slice(0, 500) },
  });
}

function anotarBusqueda(userId) {
  return prisma.scopusConnection.updateMany({
    where: { userId },
    data: { lastSearchAt: new Date(), lastError: null },
  });
}

/** Suma lo que acaba de importar. `increment` para no perder importaciones a la vez. */
function sumarImportadas(userId, cuantas) {
  if (cuantas <= 0) return Promise.resolve(null);
  return prisma.scopusConnection.updateMany({
    where: { userId },
    data: { imported: { increment: cuantas } },
  });
}

/**
 * Desconectar.
 *
 * SE VA LA CONEXIÓN, NO LAS FUENTES. Lo mismo que en Zotero y por lo mismo: lo
 * que ya se importó está citado en sus capítulos, y llevárselo le dejaría la
 * tesis con claves que no resuelven. Quien pulsa «desconectar» pide que
 * dejemos de entrar en Scopus a su nombre, que es justo lo que hace borrar
 * esta fila con sus tokens dentro.
 */
function desconectar(userId) {
  return prisma.scopusConnection.deleteMany({ where: { userId } });
}

// ── El OAuth a medias ───────────────────────────────────────────────────────

function guardarEstado({ state, verifierCipher, userId }) {
  return prisma.scopusOauthState.create({ data: { state, verifierCipher, userId } });
}

/**
 * Recoge el intercambio y lo borra en el mismo paso.
 *
 * El borrado DECIDE quién se lo queda: si dos vueltas llegan con el mismo
 * `state`, solo una borra la fila y solo esa sigue. La caducidad se aplica
 * aquí y no solo en el barrido nocturno, porque un intercambio de ayer ya no
 * vale y el barrido puede no haber pasado todavía.
 */
async function tomarEstado(state, horas = 2) {
  const fila = await prisma.scopusOauthState.findUnique({ where: { state } });
  if (!fila) return null;

  const { count } = await prisma.scopusOauthState.deleteMany({
    where: { state, createdAt: { gt: new Date(Date.now() - horas * 60 * 60 * 1000) } },
  });
  if (count !== 1) return null;

  return fila;
}

/** Los intercambios que nadie terminó. Se barren con la tarea nocturna. */
function limpiarEstadosViejos(horas = 2) {
  return prisma.scopusOauthState.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - horas * 60 * 60 * 1000) } },
  });
}

module.exports = {
  deUsuario,
  guardarConexion,
  guardarTokens,
  anotarFallo,
  anotarBusqueda,
  sumarImportadas,
  desconectar,
  guardarEstado,
  tomarEstado,
  limpiarEstadosViejos,
};
