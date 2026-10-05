'use strict';

/**
 * La Ficha de Orientación (Fase 0) y la Matriz de Estrategia (Fase 1) del
 * artículo. Por el conector se guardan con `guardar_capitulo` para que las
 * fases siguientes las lean, pero el manuscrito empieza en la Introducción:
 * ninguna de las dos se imprime en el Word.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const esquema = require('../src/modules/projects/project.esquema');

for (const ruta of ['articulo', 'revision']) {
  const CATALOGO = [
    { code: `${ruta}-fase0-tema-y-orientacion`, displayName: '0 · Tema y orientación' },
    { code: `${ruta}-fase1-matriz-de-estrategia`, displayName: '1 · Matriz de estrategia' },
    { code: `${ruta}-fase2-introduccion`, displayName: '2 · Introducción' },
    { code: `${ruta}-fase4-metodos`, displayName: '4 · Métodos' },
  ];
  const CODIGOS = CATALOGO.map((s) => s.code);

  test(`${ruta}: la ficha y la matriz no salen en el Word`, () => {
    const { capitulos } = esquema.capitulosDelDocumento({
      esquema: null,
      catalogo: CATALOGO,
      conTexto: new Set(CODIGOS),
    });
    assert.deepEqual(
      capitulos.flatMap((c) => c.partes),
      CODIGOS.slice(2),
    );
  });

  test(`${ruta}: y un esquema no puede meterlas dentro del documento`, () => {
    assert.throws(
      () =>
        esquema.normalizar(
          { capitulos: [{ titulo: 'Introducción', de: [CODIGOS[0], CODIGOS[2]] }] },
          { catalogo: CATALOGO },
        ),
      /documentos de trabajo/,
    );
  });
}
