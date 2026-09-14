'use strict';

/**
 * Los dos enlaces que da Claude en una sesión de R: subir los datos y bajar un
 * archivo.
 *
 * Mismo esquema que el enlace del Word (ver `project.descarga`): un JWT firmado
 * con el secreto de la sesión pero con OTRA audiencia y otro tipo, así que un
 * enlace no vale como sesión, una sesión no vale como enlace, y el de subir no
 * vale para bajar. Lleva dentro de quién es y qué método: tocar la dirección no
 * cambia de tesis.
 *
 * El de subida vale media hora y admite volver a subir dentro de ese plazo: lo
 * normal es que el primer archivo tenga un fallo —una columna de más, el Excel
 * equivocado— y pedir otro enlace por eso sería un clic que no aporta nada.
 */

const jwt = require('jsonwebtoken');

const env = require('../../config/env');
const { baseDeLaApi } = require('../projects/project.descarga');

const MINUTOS = 30;
const SUBIDA = 'subir-datos-r';
const DESCARGA = 'descarga-r';

/** Nombres de archivo que puede tener una descarga: sin rutas ni sorpresas. */
const NOMBRE_SEGURO = /^(?:graficos\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

const audiencia = (tipo) => `${env.JWT_AUDIENCE}:${tipo}`;

function firmar(tipo, { userId, productCode, archivo }) {
  const carga = { typ: tipo, pc: productCode };
  if (archivo) carga.f = archivo;

  return jwt.sign(carga, env.JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: `${MINUTOS}m`,
    issuer: env.JWT_ISSUER,
    audience: audiencia(tipo),
  });
}

function verificar(tipo, token) {
  const datos = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    issuer: env.JWT_ISSUER,
    audience: audiencia(tipo),
  });

  if (datos.typ !== tipo || !datos.sub || !datos.pc) {
    throw new Error('No es un enlace de esta clase.');
  }
  if (tipo === DESCARGA && !NOMBRE_SEGURO.test(datos.f ?? '')) {
    throw new Error('El enlace no nombra un archivo válido.');
  }

  return {
    userId: datos.sub,
    productCode: datos.pc,
    archivo: datos.f ?? null,
    caduca: new Date(datos.exp * 1000),
  };
}

/** La página de la web donde se sube el archivo. */
function enlaceDeSubida({ userId, productCode }) {
  const token = firmar(SUBIDA, { userId, productCode });
  const web = String(env.APP_URL).replace(/\/$/, '');
  return { url: `${web}/subir-datos/${token}`, minutos: MINUTOS };
}

/** La dirección que baja un archivo de la carpeta de la sesión. */
function enlaceDeDescarga({ userId, productCode, archivo }) {
  if (!NOMBRE_SEGURO.test(archivo)) throw new Error('Nombre de archivo no válido.');
  const token = firmar(DESCARGA, { userId, productCode, archivo });
  return { url: `${baseDeLaApi()}/r/descarga/${token}`, minutos: MINUTOS };
}

module.exports = {
  enlaceDeSubida,
  enlaceDeDescarga,
  verificarSubida: (token) => verificar(SUBIDA, token),
  verificarDescarga: (token) => verificar(DESCARGA, token),
  NOMBRE_SEGURO,
  MINUTOS,
};
