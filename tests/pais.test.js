'use strict';

/**
 * El perfil por país: lo que `mi_proyecto` le dice a Claude para adaptar el
 * método a un TFG o un TFM de España, y el campo con que se guarda.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const paises = require('../src/modules/projects/project.pais');
const { guardarAvanceSchema } = require('../src/modules/projects/project.schema');

test('el código se normaliza a dos letras en minúscula, y lo demás no vale', () => {
  assert.equal(paises.codigoDe(' ES '), 'es');
  assert.equal(paises.codigoDe('España'), null);
  assert.equal(paises.codigoDe(null), null);
});

test('España tiene perfil; Perú y un país sin perfil no añaden nada', () => {
  const perfil = paises.perfilPara('es');
  assert.match(perfil, /^PERFIL ESPAÑA/);
  assert.equal(paises.perfilPara('pe'), null);
  assert.equal(paises.perfilPara('mx'), null);
  assert.equal(paises.perfilPara(null), null);
});

test('el perfil de España cambia lo que el método da por peruano', () => {
  const perfil = paises.perfilPara('es');
  for (const debe of ['TFG', 'TFM', 'estructura_de_la_tesis', 'RGPD', 'LOPDGDD', 'Dialnet', 'TESEO', 'INE', 'iso690-author-date-es']) {
    assert.ok(perfil.includes(debe), `falta «${debe}»`);
  }
  assert.match(perfil, /NUNCA la Ley 29733/);
});

test('las claves que propone para la estructura existen en el método', () => {
  const perfil = paises.perfilPara('es');
  for (const clave of ['problema-y-objetivos', 'marco-teorico', 'metodologia', 'analisis-datos-rstudio', 'analisis-cualitativo', 'discusion', 'conclusiones-abstract']) {
    assert.ok(perfil.includes(clave), clave);
  }
});

test('las normas que nombra el perfil existen', () => {
  const normas = require('../src/modules/projects/project.normas');
  assert.ok(normas.IDS_DE_NORMA.includes('iso690-author-date-es'));
  assert.ok(normas.IDS_DE_NORMA.includes('iso690-full-note-es'));
});

test('el nombre del país sale legible en la cabecera', () => {
  assert.equal(paises.nombreDe('es'), 'España');
  assert.equal(paises.nombreDe('pe'), 'Perú');
  assert.equal(paises.nombreDe('fr'), 'FR');
  assert.equal(paises.nombreDe(''), null);
});

test('guardar_avance acepta el país en dos letras y lo pasa a minúscula', () => {
  assert.equal(guardarAvanceSchema.parse({ pais: 'ES' }).pais, 'es');
  assert.throws(() => guardarAvanceSchema.parse({ pais: 'España' }));
});
