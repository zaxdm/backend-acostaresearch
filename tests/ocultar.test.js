'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ocultarSecretosEnUrl, ocultarConsulta } = require('../src/shared/utils/ocultar');

/**
 * El registro de peticiones guardaba la URL del conector entera, y esa URL es
 * la licencia. Lo que se prueba es que ninguna credencial llegue al journal y
 * que lo demás de la URL siga ahí, porque sin ruta el registro no sirve.
 */

const TOKEN = 'lbfnkXSmFZvZNLXSHv7ebWDjoh4_IMtyfXsWCMnh180';

test('la licencia del conector no llega al registro, solo una pista', () => {
  const limpia = ocultarSecretosEnUrl(`/mcp/${TOKEN}`);
  assert.equal(limpia, '/mcp/lbfn…');
  assert.ok(!limpia.includes(TOKEN.slice(4)));
});

test('también cuando Claude pregunta por OAuth delante del conector', () => {
  const limpia = ocultarSecretosEnUrl(`/.well-known/oauth-protected-resource/mcp/${TOKEN}`);
  assert.equal(limpia, '/.well-known/oauth-protected-resource/mcp/lbfn…');
});

test('el enlace firmado del Word se oculta aunque lleve puntos', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.QZxqiaLefpRJ3Vukm-duSaig';
  const limpia = ocultarSecretosEnUrl(`/api/v1/proyectos/descarga/${jwt}`);
  assert.equal(limpia, '/api/v1/proyectos/descarga/eyJh…');
  assert.ok(!limpia.includes('QZxq'));
});

test('los parámetros de la vuelta del OAuth de Zotero se ocultan y los demás no', () => {
  const limpia = ocultarSecretosEnUrl(
    '/api/v1/mi-zotero/vuelta?oauth_token=abc123&oauth_verifier=zzz&origen=panel',
  );
  assert.equal(limpia, '/api/v1/mi-zotero/vuelta?oauth_token=…&oauth_verifier=…&origen=panel');
});

test('una URL sin secretos sale igual, y lo que no es texto no se toca', () => {
  assert.equal(ocultarSecretosEnUrl('/api/v1/billing/plans'), '/api/v1/billing/plans');
  assert.equal(ocultarSecretosEnUrl(undefined), undefined);
  assert.equal(ocultarSecretosEnUrl(''), '');
});

test('la consulta ya troceada también se limpia', () => {
  assert.deepEqual(ocultarConsulta({ oauth_token: 'abc', origen: 'panel' }), {
    oauth_token: '…',
    origen: 'panel',
  });
  assert.equal(ocultarConsulta(null), null);
});
