'use strict';

/**
 * Tablas y figuras numeradas en el orden en que salen en el Word.
 *
 * E2E de tesis del 8-nov-2026: el Capítulo I guarda sus matrices como Anexo 1
 * y 2 con las Tablas 1 a 4, el Capítulo II sigue con la 5… y como los anexos
 * van al final, el Word y su índice salían 5, 6, 7, 8, 1, 2, 3, 4.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const { renumerarRotulos } = require('../src/modules/projects/project.numeracion');
const { armar } = require('../src/modules/projects/project.docx');

test('los rótulos se numeran por orden de aparición y las menciones los siguen', () => {
  const [cuerpo, anexo] = renumerarRotulos([
    'Como muestra la Tabla 5, y también las Tablas 5 y 6.\n\n**Tabla 5**\n*Edades*\n\n**Tabla 6**\n*Sexo*',
    '**Tabla 1**\n*Matriz de consistencia*\n\nVer la tabla 1.',
  ]);
  assert.match(cuerpo, /^Como muestra la Tabla 1, y también las Tablas 1 y 2\.$/m);
  assert.match(cuerpo, /^\*\*Tabla 1\*\*$/m);
  assert.match(cuerpo, /^\*\*Tabla 2\*\*$/m);
  assert.match(anexo, /^\*\*Tabla 3\*\*$/m);
  assert.match(anexo, /Ver la tabla 3\./);
});

test('si ya van en orden, o numeran por capítulo, no se toca nada', () => {
  const enOrden = ['**Tabla 1**\n*A*\n\nLa Tabla 1 y la Tabla 2.', '**Tabla 2**\n*B*'];
  assert.deepEqual(renumerarRotulos(enOrden), enOrden);

  const porCapitulo = ['**Tabla 2.1**\n*A*', '**Tabla 1**\n*B*\n\nLa Tabla 1.'];
  assert.deepEqual(renumerarRotulos(porCapitulo), porCapitulo);
});

test('una mención a un número que no es de ningún rótulo se queda igual', () => {
  const [texto] = renumerarRotulos(['**Tabla 3**\n*A*\n\nEn la Tabla 3 y en la Tabla 9 de García (2020).']);
  assert.match(texto, /En la Tabla 1 y en la Tabla 9 de García/);
});

test('las figuras también, con la marca de su imagen', () => {
  const [texto] = renumerarRotulos(['**Figura 4**\n*Organigrama*\n[Insertar aquí la Figura 4: organigrama.png]']);
  assert.match(texto, /^\*\*Figura 1\*\*$/m);
  assert.match(texto, /\[Insertar aquí la Figura 1: organigrama\.png\]/);
});

test('en el Word, los anexos del Capítulo I van detrás y con los números siguientes', async () => {
  const tabla = (n, titulo) => `**Tabla ${n}**\n*${titulo}*\n| A | B |\n|---|---|\n| 1 | 2 |`;
  const zip = new AdmZip(
    await armar({
      tema: 'Motricidad fina en niños de 5 años',
      carrera: 'Educación Inicial',
      universidad: 'Universidad Nacional de Trujillo',
      nombre: 'Ana Pérez',
      referencias: [],
      capitulos: [
        {
          titulo: 'CAPÍTULO I: PROBLEMA',
          texto: `El problema.\n\n## Anexo 1. Matriz de consistencia\n\n${tabla(1, 'Matriz de consistencia')}`,
        },
        { titulo: 'CAPÍTULO II: MARCO TEÓRICO', texto: `La Tabla 2 resume la teoría.\n\n${tabla(2, 'Teorías')}` },
      ],
    }),
  );
  const xml = zip.readAsText('word/document.xml');
  // Cada rótulo con el título que lleva debajo, en el orden del cuerpo.
  const textos = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
  const pares = textos.flatMap((t, i) => (/^Tabla \d+$/.test(t) && !/\d$/.test(textos[i + 1]) ? [`${t}: ${textos[i + 1]}`] : []));
  assert.deepEqual(pares.slice(-2), ['Tabla 1: Teorías', 'Tabla 2: Matriz de consistencia']);
  assert.match(xml, /La Tabla 1 resume la teoría/);
});
