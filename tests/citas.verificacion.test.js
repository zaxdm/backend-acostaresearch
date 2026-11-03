'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * El autor lee lo que cita (ver `project.verificacion`).
 *
 * Lo que no puede fallar: que una cita confirmada vuelva a pedir lectura en
 * cuanto cambia su frase, que nadie pueda confirmar una cita que ya no está en
 * el texto, y que la misma fuente en dos capítulos se verifique por separado.
 */

const v = require('../src/modules/projects/project.verificacion');

const FUENTE = {
  ref: 'AR1A2B3C4D',
  title: 'Generative AI dependence and critical thinking',
  authors: 'García, L.; Pérez, M.',
  year: 2024,
  source: 'Computers & Education',
  doi: '10.1016/j.compedu.2024.105000',
  abstract: 'We surveyed 812 students and found a negative association between dependence and critical thinking.',
};
const porClave = new Map([[FUENTE.ref, FUENTE]]);

const intro = {
  code: 'articulo-fase2-introduccion',
  titulo: 'Introducción',
  texto:
    'La dependencia de la IA generativa se asocia con menos pensamiento crítico [AR1A2B3C4D:p. 12]. ' +
    'Otro estudio lo confirma en docentes [AR9999FFFF].',
};
const discusion = {
  code: 'articulo-fase6-discusion',
  titulo: 'Discusión',
  texto: 'Nuestro resultado coincide con lo hallado en estudiantes [AR1A2B3C4D].',
};

test('cada fuente citada sale por capítulo, con su frase, su página y su estado', () => {
  const items = v.inventario([intro, discusion], porClave, {});
  assert.equal(items.length, 3);

  const enIntro = items.find((i) => i.capitulo === intro.code && i.clave === FUENTE.ref);
  assert.equal(enIntro.estado, 'pendiente');
  assert.deepEqual(enIntro.paginas, ['12']);
  assert.match(enIntro.frases[0], /pensamiento crítico/);

  const rota = items.find((i) => i.clave === 'AR9999FFFF');
  assert.equal(rota.estado, 'sin_ficha');
});

test('lo que responde el autor se guarda y cuenta', () => {
  const items = v.inventario([intro, discusion], porClave, {});
  const { registro, aplicadas, rechazadas } = v.aplicar(
    {},
    [{ clave: 'AR1A2B3C4D', capitulo: intro.code, estado: 'lo_dice' }],
    items,
    new Date('2026-11-02T10:00:00Z'),
  );
  assert.equal(aplicadas.length, 1);
  assert.equal(rechazadas.length, 0);

  const despues = v.inventario([intro, discusion], porClave, registro);
  assert.equal(despues.find((i) => i.capitulo === intro.code && i.clave === FUENTE.ref).estado, 'lo_dice');
  // La misma fuente en la discusión sigue sin verificar: allí se le atribuye otra cosa.
  assert.equal(despues.find((i) => i.capitulo === discusion.code).estado, 'pendiente');
});

test('si la frase cambia, la cita vuelve a pedir lectura', () => {
  const items = v.inventario([intro], porClave, {});
  const { registro } = v.aplicar({}, [{ clave: 'AR1A2B3C4D', capitulo: intro.code, estado: 'lo_dice' }], items);

  const reescrita = { ...intro, texto: intro.texto.replace('menos pensamiento crítico', 'MÁS pensamiento crítico') };
  const despues = v.inventario([reescrita], porClave, registro);
  assert.equal(despues.find((i) => i.clave === FUENTE.ref).estado, 'cambio');
});

test('no se confirma lo que no está en el texto, ni una clave sin fuente, ni a ciegas entre capítulos', () => {
  const items = v.inventario([intro, discusion], porClave, {});
  const { aplicadas, rechazadas } = v.aplicar(
    {},
    [
      { clave: 'ARAAAAAAAA', capitulo: intro.code, estado: 'lo_dice' },
      { clave: 'AR9999FFFF', capitulo: intro.code, estado: 'lo_dice' },
      { clave: 'AR1A2B3C4D', estado: 'lo_dice' },
      { clave: 'AR1A2B3C4D', capitulo: intro.code, estado: 'seguro' },
    ],
    items,
  );
  assert.equal(aplicadas.length, 0);
  assert.equal(rechazadas.length, 4);
});

test('lo que está mal sale primero, y la ficha lleva el enlace para leerla', () => {
  const items = v.inventario([intro, discusion], porClave, {});
  const orden = v.porRevisar(items).map((i) => i.estado);
  assert.equal(orden[0], 'sin_ficha');

  const ficha = v.ficha(items.find((i) => i.capitulo === intro.code && i.clave === FUENTE.ref), 1);
  assert.match(ficha, /https:\/\/doi\.org\/10\.1016\/j\.compedu\.2024\.105000/);
  assert.match(ficha, /Página que cita el texto: 12/);
  assert.match(ficha, /orienta, no sustituye la lectura/);

  const r = v.recuento(items);
  assert.equal(r.total, 3);
  assert.equal(r.porLeer, 2);
});

test('solo el artículo empírico verifica citas; la revisión y la tesis, no (3-nov)', () => {
  const { verificaCitas } = require('../src/modules/productos/producto.perfil');
  assert.equal(verificaCitas('ARTICULO_SCIENTIFICOS'), true);
  assert.equal(verificaCitas('ARTICULOS_REVIEW'), false);
  assert.equal(verificaCitas('METODO_DE_TESIS_HUMANIZADOR'), false);
  assert.equal(verificaCitas('TSP_SUFICIENCIA'), false);
  assert.equal(verificaCitas('INFORME_ESTUDIANTIL'), false);
});
