const test = require('node:test');
const assert = require('node:assert/strict');
const { pareceAfiliacion } = require('../src/modules/references/afiliacion');

test('la afiliación que Crossref deposita como autor se descarta', () => {
  assert.equal(
    pareceAfiliacion('Associate Professor, Department of Accounting and Information Systems, Comilla University, Cumilla, Bangladesh.'),
    true,
  );
});

test('una institución autora de verdad se conserva', () => {
  for (const nombre of ['World Health Organization', 'Universidad Nacional de Trujillo', 'Department of Health and Human Services', 'Hossain, T.']) {
    assert.equal(pareceAfiliacion(nombre), false, nombre);
  }
});

test('una universidad entre personas es la afiliación; sola, es la autora', () => {
  const { quitarAfiliaciones } = require('../src/modules/references/afiliacion');
  assert.deepEqual(quitarAfiliaciones(['University Tun Hussein Onn Malaysia', 'Ahmad, K.', 'Zabri, S. M.']), ['Ahmad, K.', 'Zabri, S. M.']);
  assert.deepEqual(quitarAfiliaciones(['Universidad Nacional de Trujillo']), ['Universidad Nacional de Trujillo']);
  assert.deepEqual(quitarAfiliaciones(['World Health Organization', 'Pérez, J.']), ['World Health Organization', 'Pérez, J.']);
});

test('una universidad con el país tras la coma tampoco es un autor', () => {
  const { quitarAfiliaciones } = require('../src/modules/references/afiliacion');
  // Ficha real de Crossref (AR71E3CBB2): la universidad va antes y después de las personas.
  const ficha = 'University Tun Hussein Onn Malaysia, Malaysia; Ahmad, K.; Zabri, S.; University Tun Hussein Onn Malaysia, Malaysia';
  assert.deepEqual(quitarAfiliaciones(ficha.split('; ')), ['Ahmad, K.', 'Zabri, S.']);
  assert.deepEqual(quitarAfiliaciones(['Universidad Nacional de Trujillo, Perú']), ['Universidad Nacional de Trujillo, Perú']);
});
