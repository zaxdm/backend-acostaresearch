'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerSchema, loginSchema } = require('../src/modules/auth/auth.schema');

/**
 * El correo del registro, contra las erratas.
 *
 * A ese correo va el código de activación. Con `gamail.com` la persona se queda
 * esperando un correo que no llega nunca y abandona. La web avisa mientras se
 * escribe; esto es lo que no se puede saltar.
 */

const base = { firstName: 'Rosa', lastName: 'Tecocha', password: 'Contrasena123' };

test('un correo con el dominio mal escrito no se registra, y se propone el bueno', () => {
  const r = registerSchema.safeParse({ ...base, email: 'rosa@gamail.com' });
  assert.equal(r.success, false);
  assert.match(r.error.issues[0].message, /¿Quisiste decir rosa@gmail\.com\?/);
});

test('los correos de verdad se registran sin tocar', () => {
  for (const email of ['rosa@gmail.com', 't528100220@unitru.edu.pe', 'rosa@hotmail.es']) {
    assert.equal(registerSchema.safeParse({ ...base, email }).success, true, email);
  }
});

test('para entrar no se buscan erratas: no se deja fuera a quien ya tiene cuenta', () => {
  assert.equal(loginSchema.safeParse({ email: 'rosa@gamail.com', password: 'x' }).success, true);
});
