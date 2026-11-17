'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const sustituir = (m, exports) => {
  const id = require.resolve(m);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
const pasar = (_req, _res, next) => next();
sustituir('../src/middlewares/authenticate', (req, _res, next) => {
  if (!req.headers.authorization) return _res.status(401).end();
  req.user = { id: 'cliente' }; next();
});
sustituir('../src/config/env', { IMPORT_MAX_BYTES: 10000 });
sustituir('../src/middlewares/rateLimit', { scieloLimiter: pasar, openalexLimiter: pasar, externasLimiter: pasar, aliciaLimiter: pasar });
sustituir('../src/modules/scopus/scopus.cuentas', {});
sustituir('../src/modules/externas', {});
let guardadas;
sustituir('../src/modules/references/propias.service', {
  MAXIMO_A_MANO: 20, TIPOS: ['text/plain'], TIPOS_A_MANO: { tesis: 'thesis', libro: 'book', otro: 'document' },
  importarAMano: async ({ fuentes }) => { guardadas = fuentes; return { guardadas: fuentes.length, repetidas: 0 }; },
});
const titulo = 'Gestión de residuos sólidos en estudiantes universitarios del distrito de Pimentel durante 2024';
const entrada = { titulo, autores: 'Rosa Elena Quispe Díaz', anio: 2025, tipo: 'tesis' };
const ficha = { title: titulo, authors: 'Quispe Díaz, Rosa Elena', year: 2025, source: 'Universidad Señor de Sipán', itemType: 'masterThesis', url: 'https://hdl.handle.net/20.500.12802/123' };
let nacionales = [ficha], regionales = [], abiertas = [], falla = false;
let activas = 0, pico = 0, llamadas = [];
sustituir('../src/modules/references/alicia.client', { buscar: async (q, opciones) => {
  llamadas.push(['alicia', q, opciones]); activas++; pico = Math.max(pico, activas);
  await new Promise((r) => setTimeout(r, 4)); activas--;
  if (falla) throw new Error('sin red');
  return { fichas: nacionales };
} });
sustituir('../src/modules/references/lareferencia.client', { buscar: async () => { llamadas.push(['regional']); return { fichas: regionales }; } });
sustituir('../src/modules/references/openalex.client', { buscarPorTitulo: async () => { llamadas.push(['openalex']); return abiertas; } });
const servicio = require('../src/modules/references/identificar.service');
const router = require('../src/modules/references/propias.routes');
let server, base;
test.before(async () => {
  const app = express(); app.use(express.json()); app.use('/mis-fuentes', router);
  app.use((err, _req, res, _next) => res.status(err.statusCode ?? 500).json({ error: err.message }));
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}/mis-fuentes`;
});
test.after(() => server?.close());
test.beforeEach(() => { nacionales = [ficha]; regionales = []; abiertas = []; falla = false; llamadas = []; pico = 0; });
async function pedir(cuerpo, ruta = '/identificar', sesion = true) {
  const res = await fetch(base + ruta, { method: 'POST', headers: { 'content-type': 'application/json', ...(sesion ? { authorization: 'Bearer prueba' } : {}) }, body: JSON.stringify(cuerpo) });
  return { status: res.status, body: await res.text().then((s) => s ? JSON.parse(s) : null) };
}
test('endpoint con ALICIA simulada: devuelve datos oficiales y handle, no guarda', async () => {
  const r = await pedir({ fuentes: [entrada] });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.fichas[0].origen, 'ALICIA');
  assert.equal(r.body.data.fichas[0].url, ficha.url);
  assert.equal(r.body.data.fichas[0].grado, 'maestria');
  assert.equal(llamadas[0][2].reintentar, false);
});
test('título muy parecido pero de otra localidad se rechaza, incluso sobre el umbral', async () => {
  const largo = titulo + ' según indicadores ambientales socioeconómicos culturales educativos sanitarios económicos sociales regionales nacionales';
  nacionales = [{ ...ficha, title: largo.replace('Pimentel', 'Chiclayo') }];
  assert.ok(servicio.similitud(largo, nacionales[0].title) >= servicio.UMBRAL);
  const r = await pedir({ fuentes: [{ ...entrada, titulo: largo }] });
  assert.deepEqual(r.body.data.fichas, [null]);
});
test('rechaza año o autor contradictorio, y otro número en un título largo', () => {
  assert.equal(servicio.coincide(entrada, { ...ficha, year: 2024 }), false);
  assert.equal(servicio.coincide(entrada, { ...ficha, authors: 'Quispe Díaz, Rosa María' }), false);
  assert.equal(servicio.coincide(entrada, { ...ficha, title: titulo.replace('2024', '2023') }), false);
  assert.equal(servicio.coincide({ ...entrada, autores: 'Rosa Elena Quispe Díaz; Luis Torres Ramos' }, ficha), false);
});
test('normaliza tildes y puntuación y acepta iniciales sin atribuir el asesor', () => {
  assert.equal(servicio.coincide(entrada, { ...ficha, title: titulo.toUpperCase().replace('Gestión', 'GESTION') + '.', authors: 'Quispe Díaz, R. E.' }), true);
  assert.equal(servicio.coincide(entrada, { ...ficha, authors: 'Pérez Torres, Pedro' }), false);
});
test('si ALICIA falla o no coincide, usa LA Referencia', async () => {
  falla = true; regionales = [ficha];
  const r = await pedir({ fuentes: [entrada] });
  assert.equal(r.body.data.fichas[0].origen, 'LA Referencia');
});
test('OpenAlex solo para otros tipos, con las mismas comprobaciones', async () => {
  nacionales = []; abiertas = [{ ...ficha, itemType: 'book' }];
  let r = await pedir({ fuentes: [{ ...entrada, tipo: 'libro' }] });
  assert.equal(r.body.data.fichas[0].origen, 'OpenAlex');
  assert.equal(r.body.data.fichas[0].tipo, 'libro');
  r = await pedir({ fuentes: [entrada] });
  assert.deepEqual(r.body.data.fichas, [null]);
});
test('dos registros con título idéntico y distinta autoría son ambiguos', async () => {
  nacionales = [ficha, { ...ficha, authors: 'Torres Pérez, Luis' }];
  const r = await pedir({ fuentes: [{ ...entrada, autores: '' }] });
  assert.deepEqual(r.body.data.fichas, [null]);
});
test('límite global de tres búsquedas, también con dos lotes simultáneos; conserva orden', async () => {
  const [a, b] = await Promise.all([pedir({ fuentes: Array(7).fill(entrada) }), pedir({ fuentes: Array(5).fill(entrada) })]);
  assert.equal(a.body.data.fichas.length, 7); assert.equal(b.body.data.fichas.length, 5);
  assert.equal(pico, 3);
});
test('valida sesión, 1-20 fichas, longitudes y no permite PDF ni texto completo', async () => {
  assert.equal((await pedir({ fuentes: [entrada] }, '/identificar', false)).status, 401);
  for (const fuentes of [[], Array(21).fill(entrada), [{ ...entrada, titulo: 'corto' }], [{ ...entrada, pdf: 'bytes' }]]) {
    assert.equal((await pedir({ fuentes })).status, 422);
  }
  assert.equal((await pedir({ fuentes: [entrada], pdf: 'bytes' })).status, 422);
});
test('/a-mano conserva URL y grado tras revisar; no hay guardado automático', async () => {
  const r = await pedir({ fuentes: [{ ...entrada, fuente: ficha.source, grado: 'maestria', url: ficha.url }] }, '/a-mano');
  assert.equal(r.status, 200);
  assert.equal(guardadas[0].url, ficha.url); assert.equal(guardadas[0].grado, 'maestria');
});

test('las fichas y los null mantienen su posición y se omiten enlaces que no sean web', async () => {
  nacionales = [{ ...ficha, url: 'javascript:alert(1)' }];
  const r = await pedir({ fuentes: [{ ...entrada, titulo: 'Otra investigación completamente distinta sobre educación' }, entrada] });
  assert.equal(r.body.data.fichas[0], null);
  assert.equal(r.body.data.fichas[1].titulo, titulo);
  assert.equal(r.body.data.fichas[1].url, '');
});
