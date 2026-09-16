'use strict';

/**
 * El enlace para subir el documento del tesista desde la conversación, y cómo
 * se le dan los enlaces a Claude: como «haz clic aquí», sin la dirección.
 *
 * El enlace es una puerta sin sesión a la tesis de alguien, así que se prueba
 * sobre todo lo que NO tiene que abrir.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const env = require('../src/config/env');
const documento = require('../src/modules/projects/project.subida-documento');
const formato = require('../src/modules/projects/project.subida-formato');
const { signAccessToken } = require('../src/shared/utils/tokens');
const { enlaceClic } = require('../src/shared/utils/enlaceClic');

const tokenDe = (url) => url.split('/').pop();

test('el enlace lleva a la página de subir el documento y dice de quién y de qué método es', () => {
  const { url, minutos } = documento.enlace({ userId: 'u1', productCode: 'METODO' });
  assert.ok(url.startsWith(`${String(env.APP_URL).replace(/\/$/, '')}/subir-documento/`));
  assert.equal(minutos, 30);

  const datos = documento.verificar(tokenDe(url));
  assert.equal(datos.userId, 'u1');
  assert.equal(datos.productCode, 'METODO');
});

test('ni el enlace del formato ni una sesión sirven para subir el documento, ni al revés', () => {
  const deFormato = tokenDe(formato.enlace({ userId: 'u1', productCode: 'METODO' }).url);
  assert.throws(() => documento.verificar(deFormato));

  const deDocumento = tokenDe(documento.enlace({ userId: 'u1', productCode: 'METODO' }).url);
  assert.throws(() => formato.verificar(deDocumento));

  assert.throws(() => documento.verificar(signAccessToken({ userId: 'u1', role: 'USER', email: 'a@b.c' })));
});

test('un enlace caducado o retocado no abre nada', () => {
  const viejo = jwt.sign(
    { typ: 'subir-documento', pc: 'METODO', exp: Math.floor(Date.now() / 1000) - 10 },
    env.JWT_ACCESS_SECRET,
    { subject: 'u1', issuer: env.JWT_ISSUER, audience: `${env.JWT_AUDIENCE}:subir-documento` },
  );
  assert.throws(() => documento.verificar(viejo));

  const [cabecera, , firma] = tokenDe(documento.enlace({ userId: 'u1', productCode: 'METODO' }).url).split('.');
  const otro = Buffer.from(JSON.stringify({ typ: 'subir-documento', pc: 'OTRO', sub: 'u2' })).toString('base64url');
  assert.throws(() => documento.verificar(`${cabecera}.${otro}.${firma}`));
});

test('el enlace se le da a Claude hecho, como texto que se pulsa y sin enseñar la dirección', () => {
  const linea = enlaceClic({ texto: 'Haz clic aquí [para] subir (tu) documento', url: 'https://x.y/a.b.c', minutos: 30 });
  const [enlace, instruccion] = linea.split('\n');
  // Sin corchetes ni paréntesis en el texto, que romperían el Markdown.
  assert.equal(enlace, '[Haz clic aquí para subir tu documento](https://x.y/a.b.c)');
  assert.match(instruccion, /NO escribas la dirección/);
  assert.match(instruccion, /30 minutos/);
});
