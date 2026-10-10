'use strict';

/**
 * LA Referencia, el respaldo de ALICIA. Lo que tiene que ser cierto:
 *
 *   · Solo se busca en el nodo peruano y sin los «report», que allí son
 *     sílabos de cursos.
 *   · Su `type=AllFields` contesta «Invalid search» (10-oct-2026): se prueba,
 *     se pasa al tipo de repuesto y ya no se vuelve a probar.
 *   · `pregrado` no existe allí y no se manda como filtro.
 *   · Los identificadores llevan el prefijo `lareferencia:` de ida y sin él
 *     hacia su API.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ruta = (m) => require.resolve(m);
const sustituir = (modulo, exports) => {
  const id = ruta(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
sustituir('../src/config/logger', { info: () => {}, warn: () => {}, error: () => {} });

const lareferencia = require('../src/modules/references/lareferencia.client');
const { esId: esIdDeAlicia } = require('../src/modules/references/alicia.client');

const fetchOriginal = global.fetch;
test.afterEach(() => {
  global.fetch = fetchOriginal;
});

const respuesta = (status, cuerpo) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(cuerpo),
});

const REGISTRO = {
  rawData: {
    id: 'PE_aa4fa0b87ea1772686481325040be247',
    title: 'Pensamiento crítico en estudiantes universitarios.',
    author: ['Pasquel Chong, Hedmer Antonio'],
    publishDate: ['2025'],
    format: ['masterThesis'],
    instname_str: 'Universidad Nacional De La Amazonía Peruana',
    url: ['https://hdl.handle.net/20.500.12737/12158'],
    topic: ['Pensamiento crítico', 'https://purl.org/pe-repo/ocde/ford#5.03.01'],
  },
  summary: ['El estudio…'],
};

/** Contesta «Invalid search» a AllFields y bien a lo demás, y lo apunta todo. */
function fetchDeLaReferencia() {
  const llamadas = [];
  global.fetch = async (url) => {
    const u = new URL(String(url));
    llamadas.push(u);
    if (u.searchParams.get('type') === 'AllFields') {
      return respuesta(400, { status: 'ERROR', statusMessage: 'Invalid search' });
    }
    return respuesta(200, { status: 'OK', resultCount: 1, records: [REGISTRO] });
  };
  return llamadas;
}

test('busca en el nodo peruano, sin sílabos, y pasa al tipo de repuesto una sola vez', async () => {
  const llamadas = fetchDeLaReferencia();

  const r = await lareferencia.buscar({
    consulta: '("critical thinking" OR "pensamiento crítico")',
    pagina: 2,
    tipos: ['pregrado', 'maestria', 'articulos'],
    desde: 2020,
    hasta: null,
  });

  assert.equal(r.total, 1);
  assert.equal(r.fichas[0].id, 'lareferencia:PE_aa4fa0b87ea1772686481325040be247');
  assert.equal(r.fichas[0].tipo, 'Tesis de maestría');
  assert.equal(r.fichas[0].universidad, 'Universidad Nacional De La Amazonía Peruana');
  assert.equal(r.fichas[0].tags, 'Pensamiento crítico');

  assert.equal(llamadas.length, 2);
  assert.equal(llamadas[0].searchParams.get('type'), 'AllFields');
  const buena = llamadas[1].searchParams;
  assert.notEqual(buena.get('type'), 'AllFields');
  assert.equal(buena.get('page'), '2');
  assert.deepEqual(buena.getAll('filter[]'), [
    'network_acronym_str:"PE"',
    '-format:"report"',
    '~format:"masterThesis"',
    '~format:"article"',
    'publishDate:[2020 TO *]',
  ]);

  // La siguiente búsqueda ya no pierde el tiempo con AllFields.
  await lareferencia.buscar({ consulta: 'tesis' });
  assert.equal(llamadas.length, 3);
});

test('un fallo que no es «Invalid search» llega tal cual, sin segundo intento', async () => {
  let llamadas = 0;
  global.fetch = async () => {
    llamadas += 1;
    return respuesta(502, { status: 'ERROR', statusMessage: 'Problem connecting to Solr.' });
  };

  await assert.rejects(lareferencia.buscar({ consulta: 'tesis' }), /LA Referencia respondió 502/);
  assert.equal(llamadas, 1);
});

test('las fichas se piden sin el prefijo y vuelven con él', async () => {
  const llamadas = fetchDeLaReferencia();

  const fichas = await lareferencia.porIds([
    'lareferencia:PE_aa4fa0b87ea1772686481325040be247',
    'UPAO_820c408978406207d0f35805795f9530',
    'lareferencia:PE_x&id[]=otro',
  ]);

  assert.deepEqual(llamadas[0].searchParams.getAll('id[]'), ['PE_aa4fa0b87ea1772686481325040be247']);
  assert.equal(fichas[0].id, 'lareferencia:PE_aa4fa0b87ea1772686481325040be247');
});

test('cada catálogo reconoce solo sus identificadores', () => {
  assert.ok(lareferencia.esId('lareferencia:PE_aa4fa0b87ea1772686481325040be247'));
  assert.ok(!lareferencia.esId('PE_aa4fa0b87ea1772686481325040be247'));
  assert.ok(!esIdDeAlicia('lareferencia:PE_aa4fa0b87ea1772686481325040be247'));
  // Los de ALICIA con guion: una escuela pedagógica y una revista por su ISSN.
  assert.ok(esIdDeAlicia('EESPPM-RI_46db0ad300286704da2b922d601766bd'));
  assert.ok(esIdDeAlicia('2519-5743_ea48728ae7bca82584fab1571eb88d8a'));
  assert.ok(!esIdDeAlicia('UPAO_820c&id[]=otro'));
});
