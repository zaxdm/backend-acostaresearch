'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { dominioRecibeCorreo, revisarCorreos } = require('../src/shared/utils/correo');

/**
 * `zz@hou.com` no se parece a ningún proveedor, así que la revisión de erratas
 * lo dejó pasar y se generó un código hacia un dominio sin buzones. Lo que se
 * prueba aquí es la segunda barrera: preguntar al DNS si el dominio recibe
 * correo. Sin red: el DNS se simula.
 */

function errorDns(code) {
  return Object.assign(new Error(code), { code });
}

function dns(tabla) {
  const consultas = [];
  const resolverMx = async (dominio) => {
    consultas.push(dominio);
    const respuesta = tabla[dominio];
    if (respuesta instanceof Error) throw respuesta;
    return respuesta;
  };
  return { resolverMx, consultas, cache: new Map() };
}

test('un dominio con servidores de correo los recibe', async () => {
  const d = dns({ 'gmail.com': [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }] });
  assert.equal(await dominioRecibeCorreo('gmail.com', d), true);
});

test('sin registros MX no recibe correo, aunque la web exista', async () => {
  const d = dns({ 'hou.com': [], 'gamail.com': errorDns('ENODATA') });
  assert.equal(await dominioRecibeCorreo('hou.com', d), false);
  assert.equal(await dominioRecibeCorreo('gamail.com', d), false);
});

test('un dominio que no existe no recibe correo', async () => {
  const d = dns({ 'noexiste.com': errorDns('ENOTFOUND') });
  assert.equal(await dominioRecibeCorreo('noexiste.com', d), false);
});

test('el MX nulo (RFC 7505) dice expresamente que no acepta correo', async () => {
  const d = dns({ 'nada.com': [{ exchange: '', priority: 0 }] });
  assert.equal(await dominioRecibeCorreo('nada.com', d), false);
});

test('si el DNS falla no se sabe, y no se bloquea la venta por eso', async () => {
  const d = dns({ 'lento.com': errorDns('ETIMEOUT') });
  assert.equal(await dominioRecibeCorreo('lento.com', d), null);
});

test('una lista pregunta una sola vez por cada dominio', async () => {
  const d = dns({
    'gmail.com': [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }],
    'hou.com': [],
  });

  const revisiones = await revisarCorreos(
    ['ana@gmail.com', 'luis@gmail.com', 'zz@hou.com', 'kelin@gamail.com'],
    d,
  );

  assert.deepEqual(d.consultas.sort(), ['gmail.com', 'hou.com']);
  assert.equal(revisiones[0].problema, null);
  assert.equal(revisiones[1].problema, null);
  assert.match(revisiones[2].problema, /no recibe correos/);
  // La errata se corta antes, sin gastar una consulta, y conserva su sugerencia.
  assert.equal(revisiones[3].sugerencia, 'kelin@gmail.com');
});

test('la respuesta se recuerda y no se vuelve a preguntar', async () => {
  const d = dns({ 'gmail.com': [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }] });

  await revisarCorreos(['ana@gmail.com'], d);
  await revisarCorreos(['luis@gmail.com'], d);

  assert.deepEqual(d.consultas, ['gmail.com']);
});
