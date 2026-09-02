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

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  generateOpaqueToken,
  hashToken,
  addDays,
  addHours,
};
