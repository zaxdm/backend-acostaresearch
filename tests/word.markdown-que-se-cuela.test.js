'use strict';

/**
 * El Markdown que se colaba literal en el Word.
 *
 * DE DÓNDE SALE ESTA PRUEBA
 * -------------------------
 * De una batida: se armó un Word con cada cosa que Claude escribe al redactar
 * un capítulo y se miró si en el documento quedaba sintaxis a la vista. Es la
 * misma clase de fallo que dejaba «[figura1_histogramas.png]» impreso en medio
 * del capítulo de Resultados de una tesis de verdad, y lo que la hace grave es
 * que nada falla: el documento se descarga, se abre, y la sintaxis va dentro.
 *
 * Lo que se comprueba es lo que se ve al abrir el Word, no cómo está hecho por
 * dentro: si un asterisco llega al papel, la prueba tiene que enterarse.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const documento = require('../src/modules/projects/project.docx');

const TITULO = 'Capítulo IV';

/** Lo que se lee en el documento, de la primera línea del capítulo en adelante. */
async function visible(texto) {
  const buffer = await documento.armar({
    tema: 'Un tema',
    nombre: 'Alguien',
    capitulos: [{ titulo: TITULO, texto }],
  });
  const xml = new AdmZip(buffer).readAsText('word/document.xml');
  const todo = [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('\n');
  // El título sale dos veces: en el índice y como encabezado. El cuerpo es lo
  // que viene después de la segunda.
  return todo.split(TITULO).slice(2).join('');
}

test('la negrita y la cursiva no dejan asteriscos', async () => {
  const cuerpo = await visible('Esto es **negrita** y esto *cursiva*.');

  assert.ok(!cuerpo.includes('*'), cuerpo);
  assert.ok(cuerpo.includes('negrita') && cuerpo.includes('cursiva'));
});

test('las dos a la vez tampoco: «***así***»', async () => {
  // Dejaba un asterisco suelto a cada lado, porque la alternativa de dos
  // asteriscos casaba antes y partía la de tres por la mitad.
  const cuerpo = await visible('Y esto va ***con las dos***.');

  assert.ok(!cuerpo.includes('*'), cuerpo);
  assert.ok(cuerpo.includes('con las dos'));
});

test('una multiplicación no es una cursiva', async () => {
  // La regla de siempre: los asteriscos cuentan pegados al texto.
  const cuerpo = await visible('El total fue 3 * 4 * 5 = 60.');

  assert.ok(cuerpo.includes('3 * 4 * 5'), cuerpo);
});

test('el código entre acentos graves pierde los acentos, no el texto', async () => {
  // Claude los usa al nombrar una función de R, y es lo natural al explicar un
  // análisis. Salían impresos.
  const cuerpo = await visible('Se usó `alfa_de_cronbach()` sobre los cuatro ítems.');

  assert.ok(!cuerpo.includes('`'), cuerpo);
  assert.ok(cuerpo.includes('alfa_de_cronbach()'));
});

test('un enlace de Markdown se lee, y conserva la dirección', async () => {
  // Quitarla perdería el dato, y en un texto académico la dirección es justo
  // lo que hay que poder comprobar.
  const cuerpo = await visible('Los datos están en [el repositorio](https://ejemplo.com/datos).');

  assert.ok(!cuerpo.includes(']('), cuerpo);
  assert.ok(cuerpo.includes('el repositorio'));
  assert.ok(cuerpo.includes('https://ejemplo.com/datos'));
});

test('y si el texto del enlace ya es la dirección, no se repite', async () => {
  const cuerpo = await visible('Disponible en [https://ejemplo.com](https://ejemplo.com).');

  assert.equal(cuerpo.split('https://ejemplo.com').length - 1, 1, cuerpo);
});

test('el separador «---» no llega al documento', async () => {
  // Claude lo escribe para separar tramos mientras redacta. Una raya suelta no
  // significa nada en una tesis, y salía impresa.
  const cuerpo = await visible('Antes del corte.\n\n---\n\nDespués del corte.');

  assert.ok(!/^-{3,}$/m.test(cuerpo), cuerpo);
  assert.ok(cuerpo.includes('Antes del corte.') && cuerpo.includes('Después del corte.'));
});

test('una tabla a la que le falta la fila de guiones sigue siendo una tabla', async () => {
  // Sin esa fila salían los palotes impresos. Solo se rescata cuando el bloque
  // entero son filas y todas tienen el mismo número de celdas.
  const cuerpo = await visible('| Variable | n |\n| CD | 60 |\n| EMP | 60 |');

  assert.ok(!cuerpo.includes('|'), cuerpo);
  assert.ok(cuerpo.includes('Variable') && cuerpo.includes('EMP'));
});

test('pero unas líneas con barras que NO son una tabla se quedan como texto', async () => {
  // Distinto número de celdas: no es una tabla a la que le falte una línea.
  const cuerpo = await visible('| solo esto |\n| esto | y esto |');

  assert.ok(cuerpo.includes('|'), cuerpo);
});

test('un párrafo con una sola barra no se convierte en tabla', async () => {
  const cuerpo = await visible('La razón señal | ruido fue alta.');

  assert.ok(cuerpo.includes('señal | ruido'), cuerpo);
});

test('la tabla de siempre, con su fila de guiones, no cambia', async () => {
  const cuerpo = await visible('| Variable | n |\n|---|---|\n| CD | 60 |');

  assert.ok(!cuerpo.includes('|'), cuerpo);
  assert.ok(cuerpo.includes('Variable') && cuerpo.includes('60'));
});

test('el subtítulo en negrita al principio de la frase se lee entero', async () => {
  // «**Prueba de normalidad.** Se aplicó Shapiro-Wilk», que es como Claude
  // abre cada apartado de Resultados.
  const cuerpo = await visible('**Prueba de normalidad.** Se aplicó Shapiro-Wilk.');

  assert.ok(!cuerpo.includes('*'), cuerpo);
  assert.ok(cuerpo.includes('Prueba de normalidad.'));
  assert.ok(cuerpo.includes('Se aplicó Shapiro-Wilk.'));
});
