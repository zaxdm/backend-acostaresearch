'use strict';

/**
 * Los enlaces de subir y bajar de R son puertas sin sesión: se prueba sobre
 * todo lo que NO tienen que abrir.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const enlaces = require('../src/modules/r/r.enlaces');
const descargaWord = require('../src/modules/projects/project.descarga');
const { signAccessToken } = require('../src/shared/utils/tokens');

const DE_QUIEN = { userId: 'u1', productCode: 'METODO_9_SKILLS' };
const tokenDe = (url) => url.split('/').pop();

test('el enlace de subida lleva a la página de la web y dice de quién es', () => {
  const { url, minutos } = enlaces.enlaceDeSubida(DE_QUIEN);
  assert.match(url, /\/subir-datos\/[^/]+$/);
  assert.equal(minutos, 30);

  const v = enlaces.verificarSubida(tokenDe(url));
  assert.equal(v.userId, 'u1');
  assert.equal(v.productCode, 'METODO_9_SKILLS');
  assert.ok(v.caduca > new Date());
});

test('el de descarga va a la API y nombra el archivo', () => {
  const { url } = enlaces.enlaceDeDescarga({ ...DE_QUIEN, archivo: 'resultados.csv' });
  assert.match(url, /\/r\/descarga\/[^/]+$/);
  assert.equal(enlaces.verificarDescarga(tokenDe(url)).archivo, 'resultados.csv');
});

test('un gráfico de la sesión también se puede bajar', () => {
  const { url } = enlaces.enlaceDeDescarga({ ...DE_QUIEN, archivo: 'graficos/grafico-01.png' });
  assert.equal(enlaces.verificarDescarga(tokenDe(url)).archivo, 'graficos/grafico-01.png');
});

test('el de subir no vale para bajar, ni al revés', () => {
  const subir = tokenDe(enlaces.enlaceDeSubida(DE_QUIEN).url);
  const bajar = tokenDe(enlaces.enlaceDeDescarga({ ...DE_QUIEN, archivo: 'a.csv' }).url);
  assert.throws(() => enlaces.verificarDescarga(subir));
  assert.throws(() => enlaces.verificarSubida(bajar));
});

test('ni una sesión ni el enlace del Word valen como enlace de R', () => {
  const sesion = signAccessToken({ userId: 'u1', role: 'USER', email: 'a@b.c' });
  const word = descargaWord.firmar(DE_QUIEN);
  for (const token of [sesion, word]) {
    assert.throws(() => enlaces.verificarSubida(token));
    assert.throws(() => enlaces.verificarDescarga(token));
  }
});

test('un enlace retocado no abre nada', () => {
  const token = tokenDe(enlaces.enlaceDeSubida(DE_QUIEN).url);
  const [cabecera, , firma] = token.split('.');
  const otro = Buffer.from(JSON.stringify({ typ: 'subir-datos-r', pc: 'OTRO', sub: 'u2' })).toString('base64url');
  assert.throws(() => enlaces.verificarSubida(`${cabecera}.${otro}.${firma}`));
});

test('no se firma una descarga de un archivo con ruta', () => {
  for (const archivo of ['../.env', '/etc/passwd', 'graficos/../../x', 'a/b.csv', '.oculto']) {
    assert.throws(() => enlaces.enlaceDeDescarga({ ...DE_QUIEN, archivo }), archivo);
  }
});
