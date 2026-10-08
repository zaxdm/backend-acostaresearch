'use strict';

/**
 * La vista «Lado a lado»: el original y el resultado, emparejados, y la
 * verificación de citas, siglas, bibliografía y tablas.
 *
 * Lo que se fija aquí: que del resultado corregido se lea el texto con todo
 * ACEPTADO (lo tachado no cuenta), que una cita traducida con «y» en vez de
 * «&» siga contando como conservada, y que la bibliografía se compare de
 * verdad.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const documento = require('../src/modules/projects/project.documento');
const cambios = require('../src/modules/preparar/preparar.cambios');
const { comparar, citasEnTexto, seConserva, siglasDe } = require('../src/modules/preparar/preparar.comparar');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const SECCION = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';

function docx(cuerpo) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${cuerpo}${SECCION}</w:body></w:document>`,
    ),
  );
  return zip.toBuffer();
}

const p = (texto) => `<w:p><w:r><w:t xml:space="preserve">${texto}</w:t></w:r></w:p>`;
const parte = (buffer) => new AdmZip(buffer).getEntry('word/document.xml').getData().toString('utf8');

test('del resultado corregido se lee lo aceptado, no lo tachado', () => {
  const entrada = docx(p('The results shows that SEM have a effect (Pérez &amp; Gómez, 2020).') + p('Second paragraph stays.'));
  const { id, texto: original } = documento.parrafosDe(parte(entrada))[0];
  const { buffer: salida } = cambios.aplicar(entrada, {
    [id]: { original, texto: 'The results show that SEM has an effect (Pérez & Gómez, 2020).' },
  });

  const { parrafos, verificacion } = comparar({ entrada, salida, servicio: 'EDICION' });

  assert.equal(parrafos.length, 2);
  assert.equal(parrafos[0].resultado, 'The results show that SEM has an effect (Pérez & Gómez, 2020).');
  assert.equal(parrafos[0].cambiado, true);
  assert.equal(parrafos[1].cambiado, false);
  assert.deepEqual(parrafos[0].citasOriginal, ['(Pérez & Gómez, 2020)']);
  assert.deepEqual(verificacion.citas, { total: 1, conservadas: 1 });
  assert.deepEqual(verificacion.siglas, { total: 1, conservadas: 1 });
  assert.equal(verificacion.bibliografia, null);
});

test('una cita traducida con «y» sigue siendo la misma cita', () => {
  assert.ok(seConserva('(Pérez & Gómez, 2020)', 'como dicen (Pérez y Gómez, 2020).'));
  assert.ok(!seConserva('(Pérez & Gómez, 2020)', 'como dicen (Pérez y Gómez, 2021).'));
});

test('citas narrativas y entre paréntesis, sin repetir una dentro de otra', () => {
  const citas = citasEnTexto('Según Ramos et al. (2019) y otros (OMS, s.f.; Díaz, 2021a).', ['(OMS, s.f.; Díaz, 2021a)']);
  assert.deepEqual(citas.sort(), ['(OMS, s.f.; Díaz, 2021a)', 'Ramos et al. (2019)'].sort());
});

test('los números romanos y los títulos en mayúsculas no son siglas', () => {
  assert.deepEqual([...siglasDe('En el capítulo II se usa el modelo PLS-SEM con las TIC')].sort(), ['PLS', 'SEM', 'TIC']);
  assert.equal(siglasDe('CAPÍTULO II: MARCO TEÓRICO').size, 0);
});
