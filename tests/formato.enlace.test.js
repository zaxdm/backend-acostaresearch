'use strict';

/**
 * El enlace para subir el formato de la universidad.
 *
 * Es una puerta sin sesión a la tesis de alguien, así que se prueba sobre todo
 * lo que NO tiene que abrir: una sesión, el enlace de subir datos de R, un
 * enlace caducado o retocado.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const env = require('../src/config/env');
const formato = require('../src/modules/projects/project.subida-formato');
const enlacesR = require('../src/modules/r/r.enlaces');
const { signAccessToken } = require('../src/shared/utils/tokens');

const tokenDe = (url) => url.split('/').pop();

test('el enlace lleva a la página de subir el formato y dice de quién y de qué método es', () => {
  const { url, minutos } = formato.enlace({ userId: 'u1', productCode: 'METODO' });
  assert.ok(url.startsWith(`${String(env.APP_URL).replace(/\/$/, '')}/subir-formato/`));
  assert.equal(minutos, 30);

  const datos = formato.verificar(tokenDe(url));
  assert.equal(datos.userId, 'u1');
  assert.equal(datos.productCode, 'METODO');
  assert.ok(datos.caduca > new Date());
});

test('el enlace de subir datos de R no sirve para subir el formato, ni al revés', () => {
  const deR = tokenDe(enlacesR.enlaceDeSubida({ userId: 'u1', productCode: 'METODO' }).url);
  assert.throws(() => formato.verificar(deR));

  const deFormato = tokenDe(formato.enlace({ userId: 'u1', productCode: 'METODO' }).url);
  assert.throws(() => enlacesR.verificarSubida(deFormato));
});

test('una sesión no vale como enlace de formato', () => {
  const sesion = signAccessToken({ userId: 'u1', role: 'USER', email: 'a@b.c' });
  assert.throws(() => formato.verificar(sesion));
});

test('un enlace caducado o retocado no abre nada', () => {
  const viejo = jwt.sign(
    { typ: 'subir-formato', pc: 'METODO', exp: Math.floor(Date.now() / 1000) - 10 },
    env.JWT_ACCESS_SECRET,
    { subject: 'u1', issuer: env.JWT_ISSUER, audience: `${env.JWT_AUDIENCE}:subir-formato` },
  );
  assert.throws(() => formato.verificar(viejo));

  const [cabecera, , firma] = tokenDe(formato.enlace({ userId: 'u1', productCode: 'METODO' }).url).split('.');
  const otro = Buffer.from(JSON.stringify({ typ: 'subir-formato', pc: 'OTRO', sub: 'u2' })).toString('base64url');
  assert.throws(() => formato.verificar(`${cabecera}.${otro}.${firma}`));
});
