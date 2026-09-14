'use strict';

/**
 * El Word del informe de R: que las tablas salgan como tablas APA, las figuras
 * como imágenes con su número y su nota, y las citas y la lista de referencias
 * en la norma. Se abre el .docx generado y se mira su XML.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const informe = require('../src/modules/r/r.informe');

/** Un PNG de verdad de 4 × 3 píxeles: la cabecera es lo que se lee. */
function png(ancho, alto) {
  const cabecera = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(ancho, 8);
  ihdr.writeUInt32BE(alto, 12);
  return Buffer.concat([cabecera, ihdr, Buffer.alloc(40)]);
}

const TEXTO = `El presente capítulo da cuenta de los hallazgos obtenidos con los 50 trabajadores.

# 4.1. Resultados descriptivos

## 4.1.1. Nivel de gestión comercial

**Tabla 1**
*Nivel de gestión comercial*
| Nivel | Frecuencia | Porcentaje |
|---|---|---|
| Alto | 43 | 86,0 % |
| Medio | 7 | 14,0 % |
*Nota.* Datos del cuestionario aplicado a 50 trabajadores.

**Figura 1**
*Distribución porcentual del nivel de gestión comercial*
![](figura1.png)
*Nota.* Procesado en R 4.3.3.

La Tabla 1 muestra que 43 trabajadores (86,0 %) perciben un nivel alto.`;

async function xmlDe(datos) {
  const buffer = await informe.armar(datos);
  const zip = new AdmZip(buffer);
  return {
    documento: zip.readAsText('word/document.xml'),
    // Sin la entrada de la propia carpeta, que el zip también lista.
    medios: zip.getEntries().filter((e) => e.entryName.startsWith('word/media/') && !e.isDirectory),
  };
}

test('las figuras que pide el texto, en orden y sin repetir', () => {
  const texto = `${TEXTO}\n\n**Figura 2**\n*Otra*\n![](graficos/grafico-01.png)\n\n**Figura 3**\n![](figura1.png)`;
  assert.deepEqual(informe.figurasDe(texto), ['figura1.png', 'graficos/grafico-01.png']);
});

test('se cuentan las tablas con la misma regla que las pinta', () => {
  assert.equal(informe.cuantasTablas(TEXTO), 1);
  assert.equal(informe.cuantasTablas('| a | b |\n| c | d |'), 0, 'sin la fila de guiones no es tabla');
});

test('las dimensiones salen de la cabecera del PNG, y lo que no es PNG no vale', () => {
  assert.deepEqual(informe.dimensionesPng(png(1600, 1100)), { ancho: 1600, alto: 1100 });
  assert.equal(informe.dimensionesPng(Buffer.from('no es una imagen')), null);
});

test('el Word lleva el título, la tabla APA, la figura con su imagen y sus notas', async () => {
  const { documento, medios } = await xmlDe({
    titulo: 'CAPÍTULO IV\nRESULTADOS',
    tema: 'Gestión comercial y exportación de café',
    texto: TEXTO,
    figuras: new Map([['figura1.png', png(1600, 1100)]]),
  });

  for (const trozo of ['CAPÍTULO IV', 'RESULTADOS', 'Tabla 1', 'Nivel de gestión comercial', 'Figura 1', 'Nota.']) {
    assert.ok(documento.includes(trozo), `falta «${trozo}»`);
  }
  assert.match(documento, /<w:tbl>/, 'la tabla es una tabla de Word, no texto con barras');
  assert.doesNotMatch(documento, /\|---\|/);
  assert.match(documento, /<w:drawing>/, 'la figura va como imagen');
  assert.equal(medios.length, 1);
  assert.doesNotMatch(documento, /!\[\]\(figura1\.png\)/, 'la marca de la imagen no se cuela como texto');
});

test('una figura ancha se reduce al ancho de la página', async () => {
  const { documento } = await xmlDe({
    texto: '**Figura 1**\n*Ancha*\n![](figura1.png)',
    figuras: new Map([['figura1.png', png(2000, 1000)]]),
  });
  // 560 píxeles a 9525 EMU por píxel.
  assert.match(documento, new RegExp(`cx="${560 * 9525}"`));
});

test('las citas salen de sus huecos y la lista de referencias va al final', async () => {
  const citas = new Map([[1, { tramos: [{ texto: '(Cohen, 1988)' }], texto: '(Cohen, 1988)' }]]);
  const referencias = [
    { texto: 'Cohen, J. (1988). Statistical power analysis.', tramos: [{ texto: 'Cohen, J. (1988). ' }, { texto: 'Statistical power analysis', cursiva: true }, { texto: '.' }] },
  ];
  const { documento } = await xmlDe({
    texto: 'La magnitud sigue los criterios de Cohen ⟦C1⟧.',
    citas,
    referencias,
  });

  assert.ok(documento.includes('(Cohen, 1988)'));
  assert.doesNotMatch(documento, /⟦C1⟧/);
  assert.ok(documento.includes('Referencias'));
  assert.ok(documento.includes('Statistical power analysis'));
});
