'use strict';

/**
 * El filtro que va delante del conector, para no gastar una consulta en cada
 * licencia inventada. Lo que importa: que una licencia de verdad pasa siempre,
 * que lo que no tiene su forma no llega a la base, que una inexistente se
 * recuerda solo un rato, y que la memoria no crece sin fin.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { crearFiltro, RECUERDO_MS, MAXIMO_RECORDADAS } = require('../src/modules/mcp/mcp.acceso');

/** Como se generan de verdad las licencias y los conectores de prueba. */
const licencia = () => crypto.randomBytes(32).toString('base64url');

test('una licencia con la forma de las de verdad pasa el filtro', () => {
  const filtro = crearFiltro();
  for (let i = 0; i < 50; i += 1) assert.ok(filtro.pareceLicencia(licencia()));
});

test('lo que no tiene su forma se descarta sin consultar', () => {
  const filtro = crearFiltro();
  for (const basura of ['', 'abc', 'x'.repeat(42), 'x'.repeat(44), `${'a'.repeat(42)}/`, `${'a'.repeat(42)}=`, null, 42]) {
    assert.equal(filtro.pareceLicencia(basura), false, String(basura));
  }
});

test('una inexistente se recuerda diez minutos, y después se vuelve a preguntar', () => {
  let ahora = 1_000_000;
  const filtro = crearFiltro({ ahora: () => ahora });
  const token = licencia();

  assert.equal(filtro.esDesconocida(token), false);
  filtro.recordarDesconocida(token);
  assert.equal(filtro.esDesconocida(token), true);

  ahora += RECUERDO_MS + 1;
  assert.equal(filtro.esDesconocida(token), false);
});

test('con el tope lleno se olvida la más antigua, no se crece sin fin', () => {
  const filtro = crearFiltro();
  const primera = licencia();
  filtro.recordarDesconocida(primera);
  for (let i = 0; i < MAXIMO_RECORDADAS; i += 1) filtro.recordarDesconocida(licencia());

  assert.equal(filtro.esDesconocida(primera), false);
});
