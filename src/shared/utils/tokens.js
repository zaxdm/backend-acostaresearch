'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const env = require('../../config/env');

/** Access token: JWT firmado, corto, sin estado en la BD. */
function signAccessToken({ userId, role, email }) {
  return jwt.sign({ role, email, typ: 'access' }, env.JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: env.JWT_ACCESS_TTL,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, {
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });
}

/**
 * Refresh token: valor opaco aleatorio. En la BD solo guardamos su SHA-256,
 * así una filtración de la tabla no permite suplantar sesiones.
 */
function generateOpaqueToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Código numérico de un solo uso para verificar el correo.
 * randomInt del módulo crypto reparte de forma uniforme; Math.random no sirve,
 * porque es predecible y no vale para nada relacionado con seguridad.
 */
function generateNumericCode(digits) {
  const maximo = 10 ** digits;
  return String(crypto.randomInt(0, maximo)).padStart(digits, '0');
}

/** Compara dos hashes hex en tiempo constante, sin filtrar por temporización. */
function safeCompareHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  generateOpaqueToken,
  generateNumericCode,
  hashToken,
  safeCompareHex,
  addDays,
  addMinutes,
};
