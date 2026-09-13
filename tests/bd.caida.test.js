'use strict';

// El manejador de errores arrastra el logger, que no tiene nada que hacer
// durante las pruebas.
process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Prisma } = require('@prisma/client');

const { esCaidaDeBase } = require('../src/lib/dbAlert');
const errorHandler = require('../src/middlewares/errorHandler');
const { ERROR_CODES } = require('../src/config/constants');

/**
 * Lo que se prueba aquí nace del corte del 11 de septiembre de 2026: que un
 * corte de la base se distinga de un error de consulta, y que quien hace la
 * petición reciba un 503 con el que la web sabe sacar la pantalla de
 * mantenimiento. Cuándo suena el teléfono se prueba en `bd.vigia.test.js`.
 */

const errorConCodigo = (code) => Object.assign(new Error('prisma'), { code });

const errorDeArranque = (codigo) =>
  new Prisma.PrismaClientInitializationError(
    "Can't reach database server",
    Prisma.prismaVersion.client,
    codigo,
  );

// ── Qué cuenta como caída ───────────────────────────────────────────────────

test('los códigos del corte real se reconocen como caída', () => {
  for (const code of ['P1001', 'P1002', 'P1017', 'P2024']) {
    assert.equal(esCaidaDeBase(errorConCodigo(code)), true, code);
  }
});

test('el error de arranque de Prisma también es caída, aunque traiga el código en errorCode', () => {
  const error = errorDeArranque('P1001');
  assert.equal(error.code, undefined);
  assert.equal(esCaidaDeBase(error), true);
});

test('el error de arranque sin código también es caída: así llega contra un MySQL inalcanzable', () => {
  const error = errorDeArranque(undefined);
  assert.equal(error.code, undefined);
  assert.equal(error.errorCode, undefined);
  assert.equal(esCaidaDeBase(error), true);
});

test('un error de consulta no es una caída: la base estaba ahí para contestarlo', () => {
  assert.equal(esCaidaDeBase(errorConCodigo('P2002')), false);
  assert.equal(esCaidaDeBase(errorConCodigo('P2025')), false);
});

test('un error sin código no hace sonar nada', () => {
  assert.equal(esCaidaDeBase(new Error('cualquier cosa')), false);
  assert.equal(esCaidaDeBase(undefined), false);
  assert.equal(esCaidaDeBase({ code: 500 }), false);
});

// ── Qué ve quien hace la petición ───────────────────────────────────────────

function respuestaFalsa() {
  return {
    cabeceras: {},
    codigo: null,
    cuerpo: null,
    set(nombre, valor) {
      this.cabeceras[nombre] = valor;
      return this;
    },
    status(codigo) {
      this.codigo = codigo;
      return this;
    },
    json(cuerpo) {
      this.cuerpo = cuerpo;
      return this;
    },
  };
}

const peticionFalsa = { method: 'POST', originalUrl: '/api/v1/auth/login' };

test('una caída de la base sale como 503, no como 500', () => {
  const res = respuestaFalsa();
  errorHandler(errorConCodigo('P1001'), peticionFalsa, res, () => {});

  assert.equal(res.codigo, 503);
  assert.equal(res.cuerpo.error.code, ERROR_CODES.SERVICE_UNAVAILABLE);
  assert.equal(res.cuerpo.success, false);
});

test('un corte que pilla al cliente sin conectar también sale como 503', () => {
  const res = respuestaFalsa();
  errorHandler(errorDeArranque('P1001'), peticionFalsa, res, () => {});

  assert.equal(res.codigo, 503);
  assert.equal(res.cuerpo.error.code, ERROR_CODES.SERVICE_UNAVAILABLE);

  const sinCodigo = respuestaFalsa();
  errorHandler(errorDeArranque(undefined), peticionFalsa, sinCodigo, () => {});
  assert.equal(sinCodigo.codigo, 503);
});

test('el 503 lleva Retry-After: al cliente hay que decirle cuándo volver', () => {
  const res = respuestaFalsa();
  errorHandler(errorConCodigo('P1017'), peticionFalsa, res, () => {});

  assert.equal(res.codigo, 503);
  assert.equal(res.cabeceras['Retry-After'], '30');
});

test('un error de verdad sigue siendo 500 y sin Retry-After', () => {
  const res = respuestaFalsa();
  errorHandler(new Error('me olvidé de un await'), peticionFalsa, res, () => {});

  assert.equal(res.codigo, 500);
  assert.equal(res.cuerpo.error.code, ERROR_CODES.INTERNAL_ERROR);
  assert.equal(res.cabeceras['Retry-After'], undefined);
});

test('el mensaje del 503 no culpa a quien lo lee', () => {
  const res = respuestaFalsa();
  errorHandler(errorConCodigo('P2024'), peticionFalsa, res, () => {});

  assert.match(res.cuerpo.error.message, /Inténtalo de nuevo/);
});
