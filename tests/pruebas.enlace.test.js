'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  estadoDelEnlace,
  generarSlug,
  correoDeInvitado,
} = require('../src/modules/trials/trial.service');
const { createTrialSchema, slugParamSchema } = require('../src/modules/trials/trial.schema');

/**
 * Los enlaces de prueba reparten conectores a gente sin cuenta. Lo que se prueba
 * aquí es lo que protege eso: que el enlace no se adivine, que el titular de
 * relleno no pueda recibir correo ni convertirse en una cuenta de verdad, y que
 * un enlace apagado nunca se anuncie como abierto.
 */

test('un enlace apagado se dice apagado aunque esté lleno', () => {
  assert.equal(estadoDelEnlace({ active: false, seats: 30, claimed: 30 }), 'APAGADO');
  assert.equal(estadoDelEnlace({ active: false, seats: 30, claimed: 0 }), 'APAGADO');
});

test('un enlace encendido está lleno al entregar el último cupo, no antes', () => {
  assert.equal(estadoDelEnlace({ active: true, seats: 30, claimed: 29 }), 'ABIERTO');
  assert.equal(estadoDelEnlace({ active: true, seats: 30, claimed: 30 }), 'LLENO');
});

test('el enlace es largo, aleatorio y sin caracteres que se confundan', () => {
  const vistos = new Set();
  for (let i = 0; i < 200; i += 1) {
    const slug = generarSlug();
    assert.match(slug, /^[a-z0-9]{12}$/);
    assert.doesNotMatch(slug, /[01lo]/);
    vistos.add(slug);
  }
  assert.equal(vistos.size, 200);
});

test('el enlace generado pasa la validación de la ruta pública', () => {
  const slug = generarSlug();
  assert.equal(slugParamSchema.parse({ slug }).slug, slug);
  assert.throws(() => slugParamSchema.parse({ slug: '../admin' }));
});

test('el correo del invitado es único y de un dominio que no existe', () => {
  const a = correoDeInvitado();
  const b = correoDeInvitado();
  assert.notEqual(a, b);
  // .invalid está reservado: ningún correo sale hacia allí y nadie puede tener
  // una cuenta de Google con esa dirección para quedarse con el invitado.
  assert.match(a, /@prueba\.invalid$/);
  assert.ok(a.length <= 255);
});

test('un enlace nuevo trae 30 cupos si no se dice otra cosa', () => {
  const datos = createTrialSchema.parse({
    name: 'Taller UNMSM',
    productCode: 'metodo_9_skills',
    accessDays: 15,
  });
  assert.equal(datos.seats, 30);
  assert.equal(datos.productCode, 'METODO_9_SKILLS');
  assert.equal(datos.callsPerDay, 0);
});

test('los topes tienen techo: un cero de más no pasa', () => {
  const base = { name: 'Taller', productCode: 'METODO_9_SKILLS', accessDays: 15 };
  assert.throws(() => createTrialSchema.parse({ ...base, seats: 5000 }));
  assert.throws(() => createTrialSchema.parse({ ...base, callsLimitTotal: 100000 }));
  assert.throws(() => createTrialSchema.parse({ ...base, accessDays: 0 }));
});
