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
