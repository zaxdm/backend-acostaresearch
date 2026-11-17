'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sustituir = (m, exports) => {
  const id = require.resolve(m);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
sustituir('../src/config/logger', { info() {}, warn() {} });
sustituir('../src/modules/references/openalex.client', {});
sustituir('../src/modules/references/crossref.client', {});
sustituir('../src/modules/references/citadas', {});
sustituir('../src/modules/zotero/biblioteca.repository', {});
sustituir('../src/modules/mendeley/mendeley.repository', {});
let filas;
sustituir('../src/modules/references/propias.repository', {
  TOPE_POR_USUARIO: 1000, contar: async () => 0, contarSinResumen: async () => 1,
  guardarLote: async (_userId, lote) => { filas = lote; return { guardadas: lote.length, repetidas: 0 }; },
  unaPorClave: async () => ({ id: 'fuente', itemType: 'masterThesis', origin: 'SCOPUS', title: 'Título de prueba', authors: '', sourceRef: 'titulo:prueba' }),
  otraConEsaIdentidad: async () => null,
  corregir: async (_id, datos) => { filas = [datos]; },
});

test('corregir el título de una tesis conserva el grado que se leyó al importarla', async () => {
  await propias.corregir({ userId: 'cliente', clave: 'AR12345678', ficha: {
    titulo: 'Título de prueba revisado', autores: 'Pérez Ruiz, Ana', anio: 2025, fuente: 'Universidad', tipo: 'tesis',
  } });
  assert.equal(filas[0].itemType, 'masterThesis');
});
const propias = require('../src/modules/references/propias.service');
test('la importación real conserva autores, año, universidad, handle y grado en la fila', async () => {
  for (const [grado, tipo] of [['pregrado', 'bachelorThesis'], ['maestria', 'masterThesis'], ['doctorado', 'doctoralThesis']]) {
    await propias.importarAMano({ userId: 'cliente', fuentes: [{
      titulo: 'Estudio de comunidades rurales en Pimentel', autores: 'Quispe Díaz, Rosa Elena; Flores Ruiz, Luis',
      anio: 2025, fuente: 'Universidad Señor de Sipán', tipo: 'tesis', grado,
      url: 'https://hdl.handle.net/20.500.12802/123', resumen: '',
    }] });
    assert.equal(filas[0].authors, 'Quispe Díaz, Rosa Elena; Flores Ruiz, Luis');
    assert.equal(filas[0].year, 2025);
    assert.equal(filas[0].source, 'Universidad Señor de Sipán');
    assert.equal(filas[0].url, 'https://hdl.handle.net/20.500.12802/123');
    assert.equal(filas[0].itemType, tipo);
  }
});
