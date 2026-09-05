'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { marcar, identificar, limpiar, huella } = require('../src/modules/skills/skill.watermark');

const LICENCIA = '11111111-2222-3333-4444-555555555555';
const OTRA = '99999999-8888-7777-6666-555555555555';

/** Un tramo escrito como están escritas las skills de verdad: a base de listas. */
const TRAMO_DE_LISTAS = [
  '## Paso 3 · Definir la población y la muestra',
  '',
  'Antes de calcular nada, deja por escrito a quién vas a estudiar y por qué.',
  '',
  '- Delimita la población con criterios verificables: quién entra y quién no entra.',
  '- Escribe los criterios de inclusión antes de mirar los datos, nunca después.',
  '- Justifica el marco muestral citando la fuente de donde sale el listado.',
  '* Si la población es finita, aplica la corrección correspondiente en la fórmula.',
  '+ Anota el nivel de confianza y el margen de error que has elegido y por qué.',
  '1. Calcula el tamaño con la fórmula que corresponda al diseño de tu estudio.',
  '2. Contrasta el resultado con lo que sea viable de verdad en tu campo.',
  '> Si el asesor pregunta por qué esa muestra, la respuesta ya está escrita arriba.',
  '',
  'Cierra el paso con el párrafo redactado y pásalo al documento en Word.',
].join('\n');

test('la marca sobrevive a una vuelta completa y señala a su licencia', () => {
  const { texto, escritos } = marcar(TRAMO_DE_LISTAS, LICENCIA);

  assert.ok(escritos >= 8, `se esperaban 8 bits o más, se escribieron ${escritos}`);

  const resultado = identificar(texto, [LICENCIA, OTRA]);
  assert.equal(resultado.encontrada, true);
  assert.deepEqual(resultado.candidatas, [LICENCIA]);
});

test('un texto de listas se firma: es el caso que antes salía en blanco', () => {
  // La versión anterior descartaba toda línea que empezara por «-», «*» o «>».
  // En un tramo como este no quedaban ocho líneas aptas y el texto salía del
  // servidor sin ninguna marca, sin avisar. Esta prueba existe para que no
  // vuelva a pasar.
  const { escritos } = marcar(TRAMO_DE_LISTAS, LICENCIA);
  assert.ok(escritos > 0, 'un tramo de viñetas tiene que poder firmarse');
});

test('marcar no cambia el texto que se lee', () => {
  const { texto } = marcar(TRAMO_DE_LISTAS, LICENCIA);
  assert.equal(limpiar(texto), TRAMO_DE_LISTAS);
});

test('la estructura del Markdown queda intacta', () => {
  const { texto } = marcar(TRAMO_DE_LISTAS, LICENCIA);

  for (const linea of texto.split('\n')) {
    const limpia = limpiar(linea);
    if (limpia.startsWith('- ') || limpia.startsWith('* ') || limpia.startsWith('+ ')) {
      // La viñeta tiene que seguir siendo el primer carácter de la línea: la
      // marca va detrás, o el renderizador deja de ver una lista.
      assert.ok(
        /^[-*+]\s/.test(linea.trimStart()),
        `la viñeta se rompió en: ${JSON.stringify(linea)}`,
      );
    }
    if (limpia.startsWith('## ')) {
      assert.ok(linea.startsWith('## '), 'un encabezado no debe llevar marca');
    }
  }
});

test('dos licencias distintas dejan huellas distintas', () => {
  const uno = marcar(TRAMO_DE_LISTAS, LICENCIA).texto;
  const dos = marcar(TRAMO_DE_LISTAS, OTRA).texto;

  assert.notEqual(uno, dos);
  assert.deepEqual(identificar(uno, [LICENCIA, OTRA]).candidatas, [LICENCIA]);
  assert.deepEqual(identificar(dos, [LICENCIA, OTRA]).candidatas, [OTRA]);
});

test('un fragmento recortado sigue señalando a su licencia', () => {
  // Nadie filtra el capítulo entero: filtra un trozo. En un trozo los bits no
  // empiezan por el principio, y aun así tienen que encajar.
  const { texto } = marcar(TRAMO_DE_LISTAS, LICENCIA);
  const lineas = texto.split('\n');
  const trozo = lineas.slice(4, 12).join('\n');

  const resultado = identificar(trozo, [LICENCIA, OTRA]);
  assert.equal(resultado.encontrada, true);
  assert.ok(resultado.candidatas.includes(LICENCIA));
});

test('un texto sin marcas no acusa a nadie', () => {
  const resultado = identificar(TRAMO_DE_LISTAS, [LICENCIA, OTRA]);
  assert.equal(resultado.encontrada, false);
  assert.deepEqual(resultado.candidatas, []);
});

test('un texto demasiado corto se devuelve limpio y lo dice', () => {
  // Media marca no identifica a nadie y sí revela que el mecanismo existe.
  const { texto, escritos } = marcar('Dos líneas.\nNada más que firmar aquí.', LICENCIA);

  assert.equal(escritos, 0);
  assert.equal(texto, 'Dos líneas.\nNada más que firmar aquí.');
  assert.equal(identificar(texto, [LICENCIA]).encontrada, false);
});

test('la huella de una licencia es siempre la misma', () => {
  assert.equal(huella(LICENCIA), huella(LICENCIA));
  assert.notEqual(huella(LICENCIA), huella(OTRA));
});
