'use strict';

/**
 * El cifrado con el que se guardan las claves de Zotero de los tesistas.
 *
 * Es el primer secreto de OTRA PERSONA que guarda este servidor, así que las
 * pruebas miran lo que de verdad se puede romper aquí y no que «cifra y
 * descifra»:
 *
 *   · Que dos cifrados del mismo texto no salgan iguales. Si salieran, cualquiera
 *     con acceso al volcado vería qué dos tesistas conectaron la misma cuenta, y
 *     un GCM con el mismo III repetido es un cifrado roto de verdad.
 *   · Que un texto manipulado NO se descifre en silencio. Es lo que aporta GCM
 *     sobre CBC, y sin prueba no se sabe si está puesto.
 *   · Que una llave corta se rechace al arrancar. Una frase escrita a mano en
 *     SECRETS_KEY es la forma silenciosa de no tener cifrado.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const rutaEnv = require.resolve('../src/config/env');

/** 32 bytes, que es lo que exige AES-256. */
const LLAVE = Buffer.alloc(32, 7).toString('base64');

const env = { SECRETS_KEY: LLAVE };
require.cache[rutaEnv] = { id: rutaEnv, filename: rutaEnv, loaded: true, exports: env };

const secretos = require('../src/shared/utils/secretos');

test('lo cifrado vuelve tal cual', () => {
  const clave = 'P9xKzQ2mNv7bT4rH';
  assert.equal(secretos.descifrar(secretos.cifrar(clave)), clave);
});

test('el mismo texto no produce dos veces el mismo cifrado', () => {
  const uno = secretos.cifrar('la misma clave');
  const otro = secretos.cifrar('la misma clave');

  assert.notEqual(uno, otro, 'un IV repetido rompe GCM: tiene que sortearse en cada cifrado');
  assert.equal(secretos.descifrar(uno), secretos.descifrar(otro));
});

test('un cifrado manipulado falla en vez de devolver basura', () => {
  const guardado = secretos.cifrar('P9xKzQ2mNv7bT4rH');
  const [version, iv, etiqueta, cifrado] = guardado.split(':');

  // Se le cambia un byte al texto cifrado, dejando la etiqueta intacta.
  const bytes = Buffer.from(cifrado, 'base64');
  bytes[0] ^= 0xff;
  const tocado = [version, iv, etiqueta, bytes.toString('base64')].join(':');

  assert.throws(() => secretos.descifrar(tocado));
});

test('un formato que no es el nuestro se rechaza sin reventar por dentro', () => {
  for (const basura of ['', 'v1:solo:dos', 'v2:a:b:c', 'texto plano']) {
    assert.throws(() => secretos.descifrar(basura), /formato esperado|nada que descifrar/);
  }
});

test('la llave se acepta en hexadecimal además de en base64', () => {
  env.SECRETS_KEY = Buffer.alloc(32, 3).toString('hex');
  assert.equal(secretos.descifrar(secretos.cifrar('vale')), 'vale');
  env.SECRETS_KEY = LLAVE;
});

test('una llave corta no cifra: se para al arrancar', () => {
  env.SECRETS_KEY = 'mi-contrasenia-secreta';
  assert.equal(secretos.configurado(), false);
  assert.throws(() => secretos.cifrar('lo que sea'), /hacen falta 32/);
  env.SECRETS_KEY = LLAVE;
});

test('sin llave configurada se dice qué falta, no «undefined»', () => {
  env.SECRETS_KEY = undefined;
  assert.equal(secretos.configurado(), false);
  assert.throws(() => secretos.cifrar('lo que sea'), /SECRETS_KEY/);
  env.SECRETS_KEY = LLAVE;
});

test('la pista enseña el final y nunca la clave entera', () => {
  assert.equal(secretos.pista('P9xKzQ2mNv7bT4rH'), '…T4rH');
  assert.equal(secretos.pista('abc'), '…');
});
