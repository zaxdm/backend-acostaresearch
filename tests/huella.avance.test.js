'use strict';

/**
 * «Revisar IA de mi avance» (11-nov-2026): solo con plan de IA; sin capítulos
 * no manda nada; manda el Word del proyecto con la sesión firmada de Huella
 * (que Huella pueda leer con su mismo secreto) y devuelve el enlace con `ver`;
 * el tope diario de Huella llega como 429 con su mensaje.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const SECRETO = 's'.repeat(40);
sustituir('../src/config/env', { HUELLA_SECRETO: SECRETO, HUELLA_URL: 'https://huella.prueba/' });

let plan = null;
sustituir('../src/modules/acostaia/acostaia.planes', { deUsuario: async () => plan });
let documento = null;
sustituir('../src/modules/projects/project.service', { armarWord: async () => documento });

const huella = require('../src/modules/huella/huella.service');

/** Lee un token como lo haría Huella (acceso.leer_firmado). */
function leer(token) {
  const [cuerpo, firma] = token.split('.');
  const esperada = crypto.createHmac('sha256', SECRETO).update(cuerpo).digest('base64url');
  assert.equal(firma, esperada, 'la firma la acepta Huella');
  return JSON.parse(Buffer.from(cuerpo, 'base64url').toString());
}

test.beforeEach(() => {
  plan = { nivel: 'ESTANDAR', expiresAt: new Date(Date.now() + 86400000) };
  documento = { buffer: Buffer.from('docx'), nombreArchivo: 'Tesis de Ana.docx' };
});

test('sin plan de IA no manda nada', async () => {
  plan = null;
  let llamado = false;
  await assert.rejects(
    huella.analizarAvance({ userId: 'u1', email: 'a@b.pe', productCode: 'METODO' }, { pedir: async () => (llamado = true) }),
    (e) => e.statusCode === 403 && e.code === 'SIN_PLAN_IA',
  );
  assert.equal(llamado, false);
});

test('sin capítulos escritos, lo dice', async () => {
  documento = null;
  await assert.rejects(
    huella.analizarAvance({ userId: 'u1', email: 'a@b.pe', productCode: 'METODO' }, { pedir: async () => assert.fail() }),
    (e) => e.statusCode === 404,
  );
});

test('manda el Word con la sesión firmada y devuelve el enlace que lo abre', async () => {
  let envio;
  const pedir = async (url, opciones) => {
    envio = { url, opciones };
    return { ok: true, status: 200, json: async () => ({ id: 'abcdefghijklmnopqr', restantes: 3 }) };
  };
  const r = await huella.analizarAvance({ userId: 'u1', email: 'Ana@Gmail.com', productCode: 'METODO' }, { pedir });

  assert.equal(envio.url, 'https://huella.prueba/api/analizar');
  const sesion = leer(envio.opciones.headers.Cookie.replace('huella_sesion=', ''));
  assert.equal(sesion.email, 'ana@gmail.com');
  assert.ok(sesion.exp - Date.now() <= 2 * 60 * 1000, 'la sesión del envío dura 2 minutos');
  assert.equal(envio.opciones.body.get('archivo').name, 'Tesis de Ana.docx');

  assert.equal(r.id, 'abcdefghijklmnopqr');
  assert.equal(r.restantes, 3);
  assert.match(r.url, /^https:\/\/huella\.prueba\/\?t=.+&ver=abcdefghijklmnopqr$/);
  const t = decodeURIComponent(r.url.match(/t=([^&]+)/)[1]);
  assert.equal(leer(t).email, 'ana@gmail.com');
});

test('el tope diario de Huella llega como 429 con su mensaje', async () => {
  const pedir = async () => ({ ok: false, status: 429, json: async () => ({ detail: 'Ya usaste tus 5 análisis de hoy.' }) });
  await assert.rejects(
    huella.analizarAvance({ userId: 'u1', email: 'a@b.pe', productCode: 'METODO' }, { pedir }),
    (e) => e.statusCode === 429 && e.message === 'Ya usaste tus 5 análisis de hoy.',
  );
});
