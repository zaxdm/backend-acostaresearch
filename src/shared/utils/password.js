'use strict';

const argon2 = require('argon2');

// Argon2id con parámetros por encima del mínimo recomendado por OWASP.
// Todo el hashing vive aquí: cambiar de algoritmo es cambiar solo este archivo.
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

async function hashPassword(plain) {
  return argon2.hash(plain, OPTIONS);
}

async function verifyPassword(hash, plain) {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // Hash corrupto o de otro algoritmo: se trata como credencial inválida.
    return false;
  }
}

/**
 * Consume tiempo equivalente a una verificación real cuando el correo no existe,
 * para no revelar por temporización qué cuentas están registradas.
 */
async function fakeVerify(plain) {
  await argon2.hash(plain, OPTIONS);
}

module.exports = { hashPassword, verifyPassword, fakeVerify };
