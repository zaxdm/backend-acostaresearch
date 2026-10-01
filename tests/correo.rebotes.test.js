'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { veredictoZeroBounce, sondearPorZeroBounce } = require('../src/shared/utils/correo');
const { procesarEventos, aMedias } = require('../src/modules/correo/rebotes.service');

/**
 * Las dos vías gratuitas para no venderle a un correo que no existe: ZeroBounce
 * antes de vender (100 al mes) y el rebote de Brevo después. Sin red: ZeroBounce,
 * la base, el correo y ntfy son falsos.
 */

test('ZeroBounce: solo «invalid» bloquea; lo dudoso no', () => {
  assert.equal(veredictoZeroBounce({ status: 'valid' }), true);
  assert.equal(veredictoZeroBounce({ status: 'invalid', sub_status: 'mailbox_not_found' }), false);
  assert.equal(veredictoZeroBounce({ status: 'catch-all' }), null);
  assert.equal(veredictoZeroBounce({ status: 'unknown' }), null);
  assert.equal(veredictoZeroBounce({ status: 'do_not_mail', sub_status: 'disposable' }), null);
  assert.equal(veredictoZeroBounce(null), null);
});

test('ZeroBounce sin créditos no bloquea y deja de preguntar un rato', async () => {
  let llamadas = 0;
  let hora = 1_000_000;
  const pedir = async () => {
    llamadas += 1;
    return { json: async () => ({ error: 'Invalid API key or your account ran out of credits' }) };
  };
  const o = { clave: 'k', pedir, ahora: () => hora };

  assert.equal(await sondearPorZeroBounce('ana@gmail.com', o), null);
  assert.equal(await sondearPorZeroBounce('ana@gmail.com', o), null);
  assert.equal(llamadas, 1);

  hora += 61 * 60 * 1000;
  const bien = { clave: 'k', ahora: () => hora, pedir: async () => ({ json: async () => ({ status: 'invalid' }) }) };
  assert.equal(await sondearPorZeroBounce('ana1909@gmail.com', bien), false);
});

test('ZeroBounce caído: no se sabe', async () => {
  const pedir = async () => {
    throw new Error('ECONNRESET');
  };
  assert.equal(await sondearPorZeroBounce('ana@gmail.com', { clave: 'k', pedir, ahora: () => 9e15 }), null);
});

function falsos({ admin = 'admin@acosta.com' } = {}) {
  const avisos = [];
  const correos = [];
  return {
    avisos,
    correos,
    opciones: {
      silencio: new Map(),
      buscarUsuario: async (email) => (email === 'juan1234@gmail.com' ? { firstName: 'Juan', lastName: 'Pérez' } : null),
      destinoAdmin: async () => admin,
      mandar: async (m) => correos.push(m),
      avisar: (a) => avisos.push(a),
    },
  };
}

test('un rebote duro avisa al móvil sin el correo entero y al correo con él', async () => {
  const f = falsos();
  const n = await procesarEventos(
    { event: 'hard_bounce', email: 'Juan1234@gmail.com', subject: 'Tu código de acceso', reason: '550 5.1.1 does not exist' },
    f.opciones,
  );

  assert.equal(n, 1);
  assert.equal(f.avisos.length, 1);
  assert.doesNotMatch(f.avisos[0].mensaje, /juan1234@gmail\.com/);
  assert.match(f.avisos[0].mensaje, /Juan · ju…34@gmail\.com/);

  assert.equal(f.correos.length, 1);
  assert.equal(f.correos[0].to, 'admin@acosta.com');
  assert.match(f.correos[0].text, /Juan Pérez <juan1234@gmail\.com>/);
  assert.match(f.correos[0].text, /550 5\.1\.1/);
});

test('rebotes suaves, aperturas y entregas no avisan; los repetidos tampoco', async () => {
  const f = falsos();
  const n = await procesarEventos(
    [
      { event: 'soft_bounce', email: 'a@gmail.com' },
      { event: 'delivered', email: 'b@gmail.com' },
      { event: 'opened', email: 'c@gmail.com' },
      { event: 'hard_bounce', email: 'd@gmail.com' },
      { event: 'hard_bounce', email: 'd@gmail.com' },
      { event: 'hard_bounce' },
    ],
    f.opciones,
  );
  assert.equal(n, 1);
  assert.equal(f.avisos.length, 1);
});

test('si rebota el propio administrador, solo va al móvil', async () => {
  const f = falsos({ admin: 'admin@acosta.com' });
  await procesarEventos({ event: 'hard_bounce', email: 'admin@acosta.com' }, f.opciones);
  assert.equal(f.avisos.length, 1);
  assert.equal(f.correos.length, 0);
});

test('a medias', () => {
  assert.equal(aMedias('juan1234@gmail.com'), 'ju…34@gmail.com');
  assert.equal(aMedias('ana@gmail.com'), 'a…@gmail.com');
});
