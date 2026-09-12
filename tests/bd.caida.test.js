'use strict';

// El manejador de errores arrastra el logger y el aviso al móvil. Ni uno ni otro
// tienen nada que hacer durante las pruebas.
process.env.LOG_LEVEL = 'silent';
process.env.NTFY_TOPIC = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const { esCaidaDeBase, crearDetector } = require('../src/lib/dbAlert');
const errorHandler = require('../src/middlewares/errorHandler');
const { ERROR_CODES } = require('../src/config/constants');

/**
 * Dos cosas se prueban aquí, y las dos nacen del corte del 11 de septiembre de
 * 2026: que un corte de la base se distinga de un error de consulta, y que
 * cuando se repita suene el teléfono una vez y no treinta y ocho.
 */

const errorConCodigo = (code) => Object.assign(new Error('prisma'), { code });

// ── Qué cuenta como caída ───────────────────────────────────────────────────

test('los códigos del corte real se reconocen como caída', () => {
  for (const code of ['P1001', 'P1002', 'P1017', 'P2024']) {
    assert.equal(esCaidaDeBase(errorConCodigo(code)), true, code);
  }
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

// ── Cuándo se avisa ─────────────────────────────────────────────────────────

test('un fallo suelto no avisa: la red parpadea y se recupera sola', () => {
  const registrar = crearDetector();
  assert.equal(registrar(1000), false);
  assert.equal(registrar(2000), false);
});

test('tres fallos en menos de un minuto sí avisan', () => {
  const registrar = crearDetector();
  registrar(1000);
  registrar(2000);
  assert.equal(registrar(3000), true);
});

test('los fallos viejos salen de la ventana y no arrastran al aviso', () => {
  const registrar = crearDetector();
  registrar(0);
  registrar(30_000);
  // Este llega pasado el minuto del primero: dentro solo quedan dos.
  assert.equal(registrar(61_000), false);
});

test('un corte largo avisa una vez, no con cada error', () => {
  const registrar = crearDetector();
  registrar(0);
  registrar(1000);
  assert.equal(registrar(2000), true);

  // Así fue el corte real: cuatro minutos escupiendo errores.
  let avisosDeMas = 0;
  for (let t = 3000; t < 4 * 60_000; t += 5000) {
    if (registrar(t)) avisosDeMas += 1;
  }
  assert.equal(avisosDeMas, 0);
});

test('pasado el silencio, un corte nuevo vuelve a avisar', () => {
  const registrar = crearDetector();
  registrar(0);
  registrar(1000);
  assert.equal(registrar(2000), true);

  const despues = 16 * 60_000;
  registrar(despues);
  registrar(despues + 1000);
  assert.equal(registrar(despues + 2000), true);
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
