'use strict';

/**
 * El enlace de descarga del Word y a qué ítem de Zotero apunta cada cita.
 *
 * El enlace es la única puerta a una tesis que no pasa por la sesión, así que
 * lo que se prueba es sobre todo lo que NO tiene que abrir: una sesión que se
 * hace pasar por enlace, un enlace caducado o uno retocado.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const env = require('../src/config/env');
const descarga = require('../src/modules/projects/project.descarga');
const { signAccessToken } = require('../src/shared/utils/tokens');
const { urisDeZotero } = require('../src/modules/projects/project.zotero-campos');

// ── El enlace ───────────────────────────────────────────────────────────────

test('un enlace firmado dice de quién es y de qué proyecto', () => {
  const token = descarga.firmar({ userId: 'u1', productCode: 'METODO_9_SKILLS' });
  assert.deepEqual(descarga.verificar(token), { userId: 'u1', productCode: 'METODO_9_SKILLS' });
});

test('una sesión no vale como enlace de descarga', () => {
  const sesion = signAccessToken({ userId: 'u1', role: 'USER', email: 'a@b.c' });
  assert.throws(() => descarga.verificar(sesion));
});

test('un enlace no vale como sesión', () => {
  const { verifyAccessToken } = require('../src/shared/utils/tokens');
  const token = descarga.firmar({ userId: 'u1', productCode: 'METODO_9_SKILLS' });
  assert.throws(() => verifyAccessToken(token));
});

test('un enlace caducado no abre nada', () => {
  const viejo = jwt.sign(
    { typ: 'descarga-word', pc: 'METODO_9_SKILLS', exp: Math.floor(Date.now() / 1000) - 10 },
    env.JWT_ACCESS_SECRET,
    { subject: 'u1', issuer: env.JWT_ISSUER, audience: `${env.JWT_AUDIENCE}:descarga-word` },
  );
  assert.throws(() => descarga.verificar(viejo));
});

test('un enlace retocado no abre nada', () => {
  const token = descarga.firmar({ userId: 'u1', productCode: 'METODO_9_SKILLS' });
  const [cabecera, , firma] = token.split('.');
  const otro = Buffer.from(JSON.stringify({ typ: 'descarga-word', pc: 'OTRO', sub: 'u2' })).toString('base64url');
  assert.throws(() => descarga.verificar(`${cabecera}.${otro}.${firma}`));
});

test('la dirección sale de la del conector, sin el /mcp', () => {
  const { url, minutos } = descarga.enlace({ userId: 'u1', productCode: 'METODO_9_SKILLS' });
  const base = String(env.MCP_PUBLIC_URL).replace(/\/mcp\/?$/, '');

  assert.ok(url.startsWith(`${base}${env.API_PREFIX}/proyectos/descarga/`));
  assert.equal(minutos, 30);
});

// ── A qué ítem de Zotero apunta cada cita ───────────────────────────────────

const CUENTA = { zoteroUserId: '11174139' };

test('una fuente de su Zotero apunta a su ítem', () => {
  const fuente = { ref: 'AR11111111', ownerUserId: 'u1', sourceRef: 'zotero:users/11174139:GUMS2P7U' };
  assert.deepEqual(urisDeZotero(fuente, { cuenta: CUENTA }), ['http://zotero.org/users/11174139/items/GUMS2P7U']);
});

test('una fuente de la casa apunta a su ítem solo si su cuenta ES la biblioteca de la casa', () => {
  const fuente = { ref: 'AR22222222', ownerUserId: null, zoteroKey: 'ABCD2345' };

  assert.deepEqual(urisDeZotero(fuente, { cuenta: CUENTA, bibliotecaDeLaCasa: 'users/11174139' }), [
    'http://zotero.org/users/11174139/items/ABCD2345',
  ]);
  assert.deepEqual(urisDeZotero(fuente, { cuenta: CUENTA, bibliotecaDeLaCasa: 'users/999' }), [
    'https://acostaresearch.com/fuentes/AR22222222',
  ]);
});

test('sin Zotero conectado, o si la fuente es de otra cuenta, apunta a Acosta', () => {
  const deOtraCuenta = { ref: 'AR33333333', ownerUserId: 'u1', sourceRef: 'zotero:users/555:KEY12345' };

  assert.deepEqual(urisDeZotero(deOtraCuenta, { cuenta: CUENTA }), ['https://acostaresearch.com/fuentes/AR33333333']);
  assert.deepEqual(urisDeZotero(deOtraCuenta), ['https://acostaresearch.com/fuentes/AR33333333']);
});
