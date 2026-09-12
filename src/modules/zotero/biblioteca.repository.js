'use strict';

const prisma = require('../../lib/prisma');

/**
 * La conexión de Zotero de cada tesista, y la limpieza de lo que ya no está.
 *
 * Las fuentes en sí NO se escriben aquí: van por `references/propias.repository`,
 * que es el que sabe escribir la biblioteca de una persona sin tocar el fondo de
 * la casa. Lo que vive en este archivo es la conexión —clave, colección,
 * marcador de versión, cerrojo— y el borrado de lo que salió de la colección.
 */

/**
 * Un cerrojo que lleva puesto más de esto se considera abandonado.
 *
 * Sincronizar una colección normal tarda segundos. Media hora solo se alcanza si
 * el proceso murió a media pasada —un despliegue en mitad de la noche, el VPS
 * reiniciado— y en ese caso el cerrojo se quedó puesto sin nadie dentro. Sin
 * este plazo, esa persona no vuelve a sincronizar nunca y nadie se entera.
 */
const MINUTOS_DE_CERROJO = 30;

/** El prefijo de `sourceRef` con el que se marcan las fuentes de su Zotero. */
const prefijoDe = (zoteroUserId) => `zotero:users/${zoteroUserId}:`;

const deUsuario = (userId) => prisma.zoteroAccount.findUnique({ where: { userId } });

/**
 * Guarda la conexión recién autorizada.
 *
 * Si vuelve a conectar LA MISMA cuenta de Zotero, se conserva la colección que
 * ya tenía elegida: reconectar suele ser «se me caducó» o «revoqué la clave sin
 * querer», y hacerle elegir otra vez lo que ya eligió es tratarlo como si fuera
 * nuevo.
 *
 * Si conecta OTRA cuenta, se borra la elección y el marcador de versión: la
 * colección de la cuenta anterior no existe en esta, y quedarse con su versión
 * haría que la primera pasada pidiera «lo cambiado desde» un número que no
 * significa nada aquí, y se trajera la mitad.
 */
async function guardarConexion({ userId, zoteroUserId, username, apiKeyCipher }) {
  const anterior = await deUsuario(userId);
  const mismaCuenta = anterior?.zoteroUserId === zoteroUserId;

  const datos = {
    zoteroUserId,
    username,
    apiKeyCipher,
    lastError: null,
    runningSince: null,
    ...(mismaCuenta
      ? {}
      : { collectionKey: null, collectionName: null, libraryVersion: 0, lastCount: 0 }),
  };

  return prisma.zoteroAccount.upsert({
    where: { userId },
    update: datos,
    create: { userId, ...datos },
  });
}

/**
 * Cambia la colección elegida y REARRANCA el marcador de versión.
 *
 * El cero es lo importante. El marcador dice «ya tengo todo lo anterior a esta
 * versión», y eso solo era cierto de la colección vieja: conservarlo dejaría la
 * colección nueva a medias, con lo poco que se hubiera tocado desde entonces, y
 * el tesista vería llegar seis fuentes de las doscientas que tiene.
 */
function elegirColeccion(userId, { collectionKey, collectionName }) {
  return prisma.zoteroAccount.update({
    where: { userId },
    data: { collectionKey, collectionName, libraryVersion: 0, lastError: null },
  });
}

function guardarPasada(userId, { libraryVersion, lastCount }) {
  return prisma.zoteroAccount.update({
    where: { userId },
    data: { libraryVersion, lastCount, lastRunAt: new Date(), lastError: null },
  });
}

/** El fallo se guarda recortado: es para enseñárselo, no para depurar. */
function anotarFallo(userId, mensaje) {
  return prisma.zoteroAccount.update({
    where: { userId },
    data: { lastError: String(mensaje).slice(0, 500), lastRunAt: new Date() },
  });
}

/**
 * Toma el turno de esta persona, si no lo tiene nadie.
 *
 * Es un `UPDATE` condicional, que es atómico: dos procesos que lo intenten a la
 * vez —el panel y la tarea nocturna— no pueden salir ambos con el turno, porque
 * el segundo encuentra la fila ya con hora y actualiza cero filas.
 *
 * El cerrojo es POR PERSONA, a diferencia del corpus de la casa: dos tesistas
 * sincronizando al mismo tiempo no compiten por nada más que las conexiones de
 * la base, y de eso se ocupa la cola de la tarea nocturna.
 */
async function tomarElTurno(userId) {
  const caducado = new Date(Date.now() - MINUTOS_DE_CERROJO * 60 * 1000);

  const { count } = await prisma.zoteroAccount.updateMany({
    where: {
      userId,
      OR: [{ runningSince: null }, { runningSince: { lt: caducado } }],
    },
    data: { runningSince: new Date() },
  });

  return count === 1;
}

function soltarElTurno(userId) {
  return prisma.zoteroAccount.updateMany({ where: { userId }, data: { runningSince: null } });
}

/**
 * Quién toca esta noche.
 *
 * Solo los que tienen colección elegida: conectar y no elegir es un intercambio
 * a medias, y no hay nada que traer. Los que fallaron entran igual — un fallo de
 * ayer puede ser una caída de Zotero de ayer.
 */
function conColeccion() {
  return prisma.zoteroAccount.findMany({
    where: { collectionKey: { not: null } },
    select: { userId: true },
    orderBy: { lastRunAt: 'asc' },
  });
}

/**
 * Borra las fuentes suyas que ya no están en la colección.
 *
 * Acotado tres veces, y ninguna sobra: por dueño, por el prefijo de SU cuenta de
 * Zotero, y por no estar entre las claves vivas. Sin el dueño, esto vacía la
 * biblioteca de otro; sin el prefijo, se lleva por delante lo que subió él mismo
 * desde Scopus, que no viene de ninguna colección y no está en esa lista.
 */
async function borrarLasQueYaNoEstan(userId, zoteroUserId, clavesVivas) {
  const prefijo = prefijoDe(zoteroUserId);

  const { count } = await prisma.reference.deleteMany({
    where: {
      ownerUserId: userId,
      sourceRef: {
        startsWith: prefijo,
        notIn: clavesVivas.map((clave) => `${prefijo}${clave}`),
      },
    },
  });

  return count;
}

/** Cuántas de las suyas vinieron de su Zotero. Es lo que enseña el panel. */
function contarDeZotero(userId, zoteroUserId) {
  return prisma.reference.count({
    where: { ownerUserId: userId, sourceRef: { startsWith: prefijoDe(zoteroUserId) } },
  });
}

/**
 * Desconectar.
 *
 * SE VA LA CONEXIÓN, NO LAS FUENTES. Lo que ya se importó está citado en sus
 * capítulos: borrarlo dejaría su tesis llena de claves que no resuelven, y eso
 * no es lo que pide quien pulsa «desconectar» — pide que dejemos de entrar en su
 * Zotero, que es justo lo que hace borrar la clave.
 */
function desconectar(userId) {
  return prisma.zoteroAccount.deleteMany({ where: { userId } });
}

// ── El OAuth a medias ───────────────────────────────────────────────────────

function guardarPeticion({ token, secretCipher, userId }) {
  return prisma.zoteroOauthRequest.create({ data: { token, secretCipher, userId } });
}

/**
 * Recoge la petición y la borra en el mismo paso.
 *
 * Se borra sí o sí, aunque el canje falle después: un token de estos sirve una
 * vez, y dejarlo vivo tras un intento fallido solo alarga la ventana en la que
 * alguien podría reutilizarlo.
 */
async function tomarPeticion(token) {
  const fila = await prisma.zoteroOauthRequest.findUnique({ where: { token } });
  if (fila) await prisma.zoteroOauthRequest.deleteMany({ where: { token } });
  return fila;
}

/** Los intercambios que nadie terminó. Se barren con la tarea nocturna. */
function limpiarPeticionesViejas(horas = 2) {
  return prisma.zoteroOauthRequest.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - horas * 60 * 60 * 1000) } },
  });
}

module.exports = {
  MINUTOS_DE_CERROJO,
  prefijoDe,
  deUsuario,
  guardarConexion,
  elegirColeccion,
  guardarPasada,
  anotarFallo,
  tomarElTurno,
  soltarElTurno,
  conColeccion,
  borrarLasQueYaNoEstan,
  contarDeZotero,
  desconectar,
  guardarPeticion,
  tomarPeticion,
  limpiarPeticionesViejas,
};
